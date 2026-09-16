/**
 * CanonStore adapter tests（执行清单 M3.6 ① 验收）：append-only 修订留痕、
 * 原子写、损坏大声抛错、脚手架拒绝覆写、重复晋升整批拒绝。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CanonStore } from "./canon-store.js";
import { GAME_STORAGE_LAYOUT } from "../../core/graph/ids.js";

describe("CanonStore", () => {
  let root: string;
  let store: CanonStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "canon-store-"));
    store = new CanonStore(root, "game_canon_test");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const canonPath = () => path.join(root, "game_canon_test", GAME_STORAGE_LAYOUT.worldCanon);
  const logPath = () => path.join(root, "game_canon_test", GAME_STORAGE_LAYOUT.worldCanonLog);

  it("starts with an empty canon at revision 0 when no file exists", async () => {
    const snap = await store.load();
    expect(snap.revision).toBe(0);
    expect(snap.worldSetting).toBe("");
    expect(snap.promotedFacts).toEqual([]);
    expect(snap.exceptions).toEqual([]);
  });

  it("saveScaffold writes worldSetting + characters and refuses to overwrite", async () => {
    await store.saveScaffold({
      worldSetting: "深夜的废弃校舍，藏着旧终端的秘密。",
      characters: [{ id: "suyao", name: "苏遥", description: "转学生。" }],
    });
    const snap = await store.load();
    expect(snap.worldSetting).toContain("旧终端");
    expect(snap.characters).toHaveLength(1);
    expect(snap.promotedFacts).toEqual([]);

    const second = new CanonStore(root, "game_canon_test");
    await expect(
      second.saveScaffold({ worldSetting: "另一个世界", characters: [] }),
    ).rejects.toThrow(/已存在/);
  });

  it("applyPromotion writes canon.json atomically and appends the log trail", async () => {
    const rev1 = await store.applyPromotion(
      [
        {
          type: "promote",
          fact: { id: "fact_1", content: "旧终端连通着废弃的广播站。", evidenceRuns: ["run_a", "run_b"] },
        },
      ],
      "测试晋升 1",
    );
    expect(rev1).toBe(1);
    const rev2 = await store.applyPromotion(
      [
        {
          type: "exception",
          exception: {
            id: "exc_1",
            content: "苏遥在终章记得前世。",
            reason: "与 canon 的失忆线矛盾",
            compensatingLimit: "仅限终章梦境段",
          },
        },
      ],
      "测试晋升 2",
    );
    expect(rev2).toBe(2);

    const snap = await store.load();
    expect(snap.promotedFacts).toHaveLength(1);
    expect(snap.promotedFacts[0]!.judgedBy).toBe("canon-adjudicator");
    expect(snap.promotedFacts[0]!.evidenceRuns).toEqual(["run_a", "run_b"]);
    expect(snap.promotedFacts[0]!.promotedAt).toBeTruthy();
    expect(snap.exceptions).toHaveLength(1);
    expect(snap.exceptions[0]!.compensatingLimit).toBe("仅限终章梦境段");

    // append-only：日志逐行累积，全量文件与日志同批生效。
    const log = await readFile(logPath(), "utf8");
    const lines = log.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).revision).toBe(2);
    const fileRaw = JSON.parse(await readFile(canonPath(), "utf8"));
    expect(fileRaw.revision).toBe(2);
  });

  it("throws loudly on a corrupt canon.json", async () => {
    await store.saveScaffold({ worldSetting: "设定", characters: [] });
    await writeFile(canonPath(), "{ not json", "utf8");
    await expect(new CanonStore(root, "game_canon_test").load()).rejects.toThrow();
  });

  it("rejects a duplicate promotion (id or content already in canon)", async () => {
    await store.applyPromotion(
      [{ type: "promote", fact: { id: "fact_1", content: "A 事实", evidenceRuns: ["run_a", "run_b"] } }],
      "首次",
    );
    await expect(
      store.applyPromotion(
        [{ type: "promote", fact: { id: "fact_1", content: "B 事实", evidenceRuns: ["run_a"] } }],
        "id 重复",
      ),
    ).rejects.toThrow(/已晋升/);
    await expect(
      store.applyPromotion(
        [{ type: "promote", fact: { id: "fact_2", content: "A 事实", evidenceRuns: ["run_a"] } }],
        "content 重复",
      ),
    ).rejects.toThrow(/已晋升/);
    // 拒绝的批次不落盘。
    expect((await store.load()).promotedFacts).toHaveLength(1);
  });

  it("rejects empty batches and malformed ops", async () => {
    await expect(store.applyPromotion([], "空批次")).rejects.toThrow(/空批次/);
    await expect(
      store.applyPromotion(
        [{ type: "promote", fact: { id: "fact_x", content: "无佐证", evidenceRuns: [] } }],
        "evidenceRuns 空",
      ),
    ).rejects.toThrow();
  });
});
