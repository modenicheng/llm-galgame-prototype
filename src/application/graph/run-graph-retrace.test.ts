/**
 * M5.3 回溯入口 + 同选项快进（coordinator 级）：
 * - retraceFrom 任意祖先节点：abandonedAt 记账 + 新 retrace 周目 + 图零删除；
 * - 快进命中（kind+text 严格相等、指向决策节点）；
 * - 快进未命中（不一致选择 → 新边）；
 * - 结局端点不参与快进（重选结局选项走新生成）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameGraphStore } from "../../adapters/storage/game-graph-store.js";
import { RunGraphCoordinator } from "./run-graph-coordinator.js";
import { FakeClock } from "../../test-helpers.js";
import { makeForm } from "../../core/graph/testing.js";
import type { StoredEvent } from "../../schema.js";

let idCounter = 0;

function makeMoment(marker: string): import("../../core/ports/run-graph-port.js").RuntimeMoment {
  const base = { id: "prologue", location: "unknown", purpose: "test" };
  return {
    storyState: {
      scene: base,
      characters: {},
      recent_summary: marker,
    },
    visualState: { characters: {} },
    memoryDigest: {
      revision: 0,
      consolidatedThroughEventSeq: 0,
      checkpointCount: 0,
      threads: [],
      setups: [],
      anchors: [],
      facts: [],
      beliefs: [],
    },
    outlineRevision: 0,
  };
}

function ev(seq: number): StoredEvent {
  return { seq, turn: 1, timestamp: new Date().toISOString(), source: "model", type: "narration", text: `e${seq}`, line_id: `l${seq}` } as StoredEvent;
}

describe("RunGraphCoordinator retrace + fast-forward (M5.3)", () => {
  let root: string;
  let store: GameGraphStore;
  let coordinator: RunGraphCoordinator;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "graph-retrace-"));
    store = new GameGraphStore(root, "game_retrace");
    await store.initialize();
    coordinator = new RunGraphCoordinator(store, new FakeClock(), (p) => `${p}t${++idCounter}`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 周目 1：root → D1 -救她→ D2 -留下→ D3（停驻第三次表单）。 */
  async function seedRunToD3(): Promise<{ d1: string; d2: string; d3: string; runId: string }> {
    await coordinator.startRootRun();
    const d1 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "一" }), moment: makeMoment("m1") });
    await coordinator.beginEdge({ kind: "option", text: "救她" });
    await coordinator.appendEdgeEvents([ev(1)]);
    const d2 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "二" }), moment: makeMoment("m2") });
    await coordinator.beginEdge({ kind: "option", text: "留下" });
    await coordinator.appendEdgeEvents([ev(2)]);
    const d3 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "三" }), moment: makeMoment("m3") });
    const runId = (await store.loadCursor())!.runId;
    return { d1, d2, d3, runId };
  }

  it("retraceFrom an arbitrary ancestor: abandons the active run, starts a retrace run, deletes nothing", async () => {
    const { d1, d2, d3, runId } = await seedRunToD3();

    const restore = await coordinator.retraceFrom(d1);

    // 记账：旧周目弃局于其游标位（D3）；新周目 origin = retrace from D1。
    const runs = await store.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.id === runId)?.abandonedAt).toBe(d3);
    expect(runs.find((r) => r.id !== runId)?.origin).toEqual({ kind: "retrace", from: d1 });
    expect((await store.loadCursor())?.position).toBe(d1);
    expect(restore.decision.id).toBe(d1);

    // 图零删除：决策与边原样保留（决议 D7）。
    expect(await store.listDecisions()).toHaveLength(3);
    expect(await store.listEdges()).toHaveLength(2);

    // 新周目从 D1 继续提交：与既有出边不同的选择 → 新边产生（新节点）。
    await coordinator.beginEdge({ kind: "option", text: "回头" });
    await coordinator.appendEdgeEvents([ev(10)]);
    const d4 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "二" }), moment: makeMoment("m4") });
    const edges = await store.listEdges();
    expect(edges).toHaveLength(3);
    const newEdge = edges.find((e) => e.to.kind === "decision" && e.to.id === d4)!;
    expect(newEdge.from).toBe(d1);
    expect(newEdge.choice).toEqual({ kind: "option", text: "回头" });
  });

  it("fast-forward hit: identical choice at the retrace node walks the existing edge", async () => {
    const { d1, d2 } = await seedRunToD3();
    await coordinator.retraceFrom(d1);

    const result = await coordinator.beginEdge({ kind: "option", text: "救她" });
    expect(result.kind).toBe("fast_forward");
    if (result.kind !== "fast_forward") return;
    expect(result.restore.decision.id).toBe(d2);
    expect(result.restore.pathEvents.map((e) => e.seq)).toEqual([1]);
    expect((await store.loadCursor())?.position).toBe(d2);
    // 图零新增：快进不开新边。
    expect(await store.listEdges()).toHaveLength(2);
  });

  it("fast-forward miss: a different choice opens a new edge as usual", async () => {
    const { d1 } = await seedRunToD3();
    await coordinator.retraceFrom(d1);

    const result = await coordinator.beginEdge({ kind: "option", text: "另一种选择" });
    expect(result.kind).toBe("opened");
    await coordinator.appendEdgeEvents([ev(10)]);
    const dNew = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "新" }), moment: makeMoment("mNew") });
    const edges = await store.listEdges();
    expect(edges).toHaveLength(3);
    expect(edges.find((e) => e.to.kind === "decision" && e.to.id === dNew)?.choice).toEqual({
      kind: "option",
      text: "另一种选择",
    });
  });

  it("ending endpoints do not participate in fast-forward: re-picking the ending choice generates anew", async () => {
    // run1：D1 -终→ 结局（周目完结，游标清空）。
    await coordinator.startRootRun();
    const d1 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "终局选择" }), moment: makeMoment("m1") });
    await coordinator.beginEdge({ kind: "option", text: "终" });
    await coordinator.appendEdgeEvents([ev(1)]);
    await coordinator.reachEnding({ endingId: "fin", moment: makeMoment("mend") });

    // 回溯到 D1（已完结世界 → 无活跃周目可弃局）。
    await coordinator.retraceFrom(d1);

    // 重选同一结局选项「终」：不快进（结局端点排除），如实开新边。
    const result = await coordinator.beginEdge({ kind: "option", text: "终" });
    expect(result.kind).toBe("opened");
    await coordinator.appendEdgeEvents([ev(5)]);
    const d2 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "新分支" }), moment: makeMoment("m2") });
    const edges = await store.listEdges();
    const toEnding = edges.filter((e) => e.to.kind === "ending");
    expect(toEnding).toHaveLength(1); // 原结局边不动
    expect(edges.some((e) => e.from === d1 && e.to.kind === "decision" && e.to.id === d2)).toBe(true);
  });
});
