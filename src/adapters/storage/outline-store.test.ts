/**
 * OutlineStore adapter tests（执行清单 M3.1 验收）：
 * 非法迁移整批拒绝且不落盘；日志 append-only 与全量一致；原子写；损坏抛错。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OutlineStore } from "./outline-store.js";
import type { OutlineNode } from "../../core/outline/types.js";
import { GAME_STORAGE_LAYOUT } from "../../core/graph/ids.js";

function makeNode(overrides: Partial<OutlineNode> & { id: string }): OutlineNode {
  return {
    purpose: `${overrides.id} 节拍`,
    kind: "act",
    status: "planned",
    ...overrides,
  };
}

describe("OutlineStore", () => {
  let root: string;
  let store: OutlineStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "outline-store-"));
    store = new OutlineStore(root, "game_outline_test");
    await store.load();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const outlinePath = () => path.join(root, "game_outline_test", GAME_STORAGE_LAYOUT.outline);
  const logPath = () => path.join(root, "game_outline_test", GAME_STORAGE_LAYOUT.outlineLog);

  it("starts with an empty outline at revision 0 when no file exists", async () => {
    const fresh = new OutlineStore(root, "game_fresh");
    const snap = await fresh.load();
    expect(snap.revision).toBe(0);
    expect(snap.nodes).toEqual([]);
  });

  it("applies a valid batch, bumps the revision, and appends the log", async () => {
    const revision = await store.applyRevision(
      [
        {
          type: "add",
          node: makeNode({ id: "ol_act_1" }),
        },
      ],
      "编剧初版大纲",
    );
    expect(revision).toBe(1);

    const snap = store.getOutline();
    expect(snap.revision).toBe(1);
    expect(snap.nodes).toHaveLength(1);

    // 全量与日志一致
    const file = JSON.parse(await readFile(outlinePath(), "utf8"));
    expect(file.revision).toBe(1);
    const logRaw = await readFile(logPath(), "utf8");
    const lines = logRaw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.revision).toBe(1);
    expect(entry.reason).toBe("编剧初版大纲");
    expect(entry.ops[0].type).toBe("add");
    expect(entry.at).toBeTruthy();
  });

  it("validates state-machine transitions across the batch (activate → realize)", async () => {
    await store.applyRevision([{ type: "add", node: makeNode({ id: "ol_act_1" }) }], "init");
    const revision = await store.applyRevision(
      [{ type: "activate", id: "ol_act_1" }],
      "场景首个决策落成",
    );
    expect(revision).toBe(2);
    await store.applyRevision(
      [{ type: "realize", id: "ol_act_1", instantiatedBy: "dc_1" }],
      "进入不同 outlineRef 的场景",
    );
    expect(store.getOutline().nodes[0]?.status).toBe("realized");
  });

  it("rejects an invalid batch loudly and leaves disk untouched", async () => {
    await store.applyRevision([{ type: "add", node: makeNode({ id: "ol_act_1" }) }], "init");
    const before = await readFile(outlinePath(), "utf8");
    const logBefore = await readFile(logPath(), "utf8");

    // planned → realized 跳迁非法（状态机不允许；realize 只接受 active）
    await expect(
      store.applyRevision(
        [{ type: "realize", id: "ol_act_1", instantiatedBy: "dc_1" }],
        "非法跳迁批",
      ),
    ).rejects.toThrow(/outline op 非法/);

    // 损坏前缀写入后整批未生效：状态与磁盘都不变
    expect(store.getOutline().nodes[0]?.status).toBe("planned");
    expect(await readFile(outlinePath(), "utf8")).toBe(before);
    expect(await readFile(logPath(), "utf8")).toBe(logBefore);
  });

  it("rejects add of a duplicate id or a non-planned node", async () => {
    await store.applyRevision([{ type: "add", node: makeNode({ id: "ol_act_1" }) }], "init");
    await expect(
      store.applyRevision(
        [{ type: "add", node: makeNode({ id: "ol_act_1" }) }],
        "重复 id",
      ),
    ).rejects.toThrow(/已存在/);
    await expect(
      store.applyRevision(
        [{ type: "add", node: makeNode({ id: "ol_act_2", status: "active" }) }],
        "非 planned",
      ),
    ).rejects.toThrow(/planned/);
  });

  it("rejects an empty batch", async () => {
    await expect(store.applyRevision([], "空批")).rejects.toThrow(/空批次/);
  });

  it("throws loudly on a corrupt outline.json", async () => {
    const dir = path.join(root, "game_corrupt");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, GAME_STORAGE_LAYOUT.outline), "{corrupt", "utf8");
    const corrupt = new OutlineStore(root, "game_corrupt");
    await expect(corrupt.load()).rejects.toThrow();
  });

  it("throws loudly on a structurally invalid outline.json (valid JSON, wrong shape)", async () => {
    const dir = path.join(root, "game_bad_shape");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, GAME_STORAGE_LAYOUT.outline),
      JSON.stringify({ revision: -1, nodes: "nope" }),
      "utf8",
    );
    const bad = new OutlineStore(root, "game_bad_shape");
    await expect(bad.load()).rejects.toThrow();
  });

  it("atomic write leaves no tmp files behind", async () => {
    await store.applyRevision([{ type: "add", node: makeNode({ id: "ol_act_1" }) }], "init");
    const gameDir = await readdir(path.join(root, "game_outline_test"));
    expect(gameDir.filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

