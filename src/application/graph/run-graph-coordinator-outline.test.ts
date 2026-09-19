/**
 * M3.4 大纲动态迁移测试：确定性 activate/realize 时机与日志留痕、
 * 后台维护产 op 预筛、currentOutlineRevision 缓存。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunGraphCoordinator } from "./run-graph-coordinator.js";
import { GameGraphStore } from "../../adapters/storage/game-graph-store.js";
import { OutlineStore } from "../../adapters/storage/outline-store.js";
import type { OutlineStorePort } from "../../core/ports/outline-store-port.js";
import type { OutlineMaintainerPort } from "../../application/outline/outline-writer.js";
import type { OutlineNode } from "../../core/outline/types.js";
import { createInitialState } from "../../story/state.js";
import { makeIdentity } from "../../core/graph/testing.js";
import type { RuntimeMoment } from "../../core/ports/run-graph-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";

let idCounter = 0;

function makeNode(overrides: Partial<OutlineNode> & { id: string }): OutlineNode {
  return { purpose: `${overrides.id} 目的`, kind: "act", status: "planned", ...overrides };
}

function makeMoment(overrides?: { recentSummary?: string }): RuntimeMoment {
  return {
    storyState: createInitialState({
      ...(overrides?.recentSummary !== undefined
        ? { recent_summary: overrides.recentSummary }
        : {}),
    }),
    visualState: { characters: {} },
    memoryDigest: {
      revision: 1,
      consolidatedThroughEventSeq: 3,
      checkpointCount: 1,
      threads: [],
      setups: [],
      anchors: [],
      facts: [],
      beliefs: [],
      consolidationFailedIntervals: [],
    },
    outlineRevision: 0,
    identity: makeIdentity(),
  };
}

function makeForm(overrides?: { prompt?: string }): {
  mode: "choice";
  prompt: string;
  options: string[];
} {
  return {
    mode: "choice",
    prompt: overrides?.prompt ?? "怎么做？",
    options: ["追查", "离开"],
  };
}

describe("RunGraphCoordinator outline (M3.4)", () => {
  let root: string;
  let gameId: string;
  let outlineStore: OutlineStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "galgraph-outline-"));
    gameId = `game_t${++idCounter}`;
    outlineStore = new OutlineStore(root, gameId);
    await outlineStore.load();
    await outlineStore.applyRevision(
      [
        { type: "add", node: makeNode({ id: "ol_a1" }) },
        { type: "add", node: makeNode({ id: "ol_a2" }) },
        { type: "add", node: makeNode({ id: "ol_end_1", kind: "ending" }) },
      ],
      "测试大纲",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeCoordinatorWithOutline(
    maintainer?: OutlineMaintainerPort,
  ): Promise<{ coordinator: RunGraphCoordinator; diagnostics: Array<string> }> {
    const store = new GameGraphStore(root, gameId);
    const diagnostics: Array<string> = [];
    const sink: DiagnosticSink = {
      info: () => {},
      warn: (_scope, message) => diagnostics.push(message),
    };
    const coordinator = new RunGraphCoordinator(store, {
      nowIso: () => new Date().toISOString(),
    } as never, (prefix) => `${prefix}_${++idCounter}`, {
      outline: {
        store: outlineStore,
        ...(maintainer !== undefined ? { maintainer } : {}),
      },
      diagnostics: sink,
    });
    return { coordinator, diagnostics };
  }

  it("activates the frontier act on a scene's first decision, and realizes it when the story moves to the next act's scene", async () => {
    const { coordinator } = await makeCoordinatorWithOutline();
    await coordinator.startRootRun();

    // 幕一场景首个决策 → activate ol_a1
    await coordinator.openDecision({ modelSceneId: "教室", form: makeForm(), moment: makeMoment() });
    let snap = outlineStore.getOutline();
    expect(snap.nodes.find((n) => n.id === "ol_a1")?.status).toBe("active");
    expect(snap.nodes.find((n) => n.id === "ol_a2")?.status).toBe("planned");
    const revisionAfterActivate = coordinator.currentOutlineRevision();
    expect(revisionAfterActivate).toBeGreaterThanOrEqual(1);

    // 同场景再开决策：不重复迁移（revision 不再变化）
    await coordinator.openDecision({
      modelSceneId: "教室",
      form: makeForm({ prompt: "同场景下一个决策" }),
      moment: makeMoment(),
    });
    expect(coordinator.currentOutlineRevision()).toBe(revisionAfterActivate);

    // 幕二场景（不同 modelSceneId）→ ol_a1 realize（instantiatedBy=幕一场景）+ ol_a2 activate
    await coordinator.openDecision({ modelSceneId: "旧校舍", form: makeForm(), moment: makeMoment() });
    snap = outlineStore.getOutline();
    const a1 = snap.nodes.find((n) => n.id === "ol_a1")!;
    expect(a1.status).toBe("realized");
    expect(a1.instantiatedBy).toMatch(/^sc_/);
    expect(snap.nodes.find((n) => n.id === "ol_a2")?.status).toBe("active");

    // 修订日志留痕
    const log = await readFile(
      path.join(root, gameId, "outline.log.jsonl"),
      "utf8",
    );
    expect(log).toContain("M3.4：场景首个决策落成");
    expect(log).toContain("上一前沿 act realize");
  });

  it("runs outline maintenance fire-and-forget and filters illegal ops (realized untouched)", async () => {
    const maintainer = {
      maintainOutline: vi.fn(async () => [
        { type: "add", node: makeNode({ id: "ol_a3", purpose: "维护新增的支线幕" }) },
        // 非法：prune 一个尚未实例化的 planned？合法；这里构造「维护试图
        // activate/realize」与「prune 已实例化节点」两类必须被预筛掉的 op。
        { type: "activate", id: "ol_a1" },
        { type: "prune", id: "ol_a2" },
      ]),
    };
    const { coordinator } = await makeCoordinatorWithOutline(maintainer as OutlineMaintainerPort);
    await coordinator.startRootRun();
    await coordinator.openDecision({ modelSceneId: "教室", form: makeForm(), moment: makeMoment({ recentSummary: "第一幕开始" }) });

    // 等待后台维护收敛：add ol_a3（合法）+ prune ol_a2（planned 未实例化，
    // 合法）被应用；activate（确定性迁移独占）被预筛。
    await vi.waitFor(() => {
      expect(maintainer.maintainOutline).toHaveBeenCalled();
      expect(coordinator.currentOutlineRevision()).toBe(3);
    });
    const snap = outlineStore.getOutline();
    expect(snap.nodes.find((n) => n.id === "ol_a3")?.status).toBe("planned");
    expect(snap.nodes.find((n) => n.id === "ol_a2")?.status).toBe("pruned");
  });
});
