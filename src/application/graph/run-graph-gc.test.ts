/**
 * M5.6 图维护（GC）测试：不可达内容回收（崩溃孤儿 + 级联 + 幂等）、
 * 「已到达内容不可回收」负面锁定（含已弃周目，决议 D7）、共享节点存活。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameGraphStore } from "../../adapters/storage/game-graph-store.js";
import { RunGraphCoordinator } from "./run-graph-coordinator.js";
import { FakeClock } from "../../test-helpers.js";
import { makeDecision, makeEdge, makeForm, makeSnapshot } from "../../core/graph/testing.js";
import type { MemoryDigest, PlotEdge } from "../../core/graph/types.js";
import type { RuntimeMoment } from "../../core/ports/run-graph-port.js";
import type { StoredEvent } from "../../schema.js";

let idCounter = 0;

function moment(marker: string): RuntimeMoment {
  return {
    storyState: {
      scene: { id: "s1", location: "unknown", purpose: "test" },
      characters: {},
      recent_summary: marker,
    },
    visualState: { characters: {} },
    memoryDigest: {
      revision: 0, consolidatedThroughEventSeq: 0, checkpointCount: 0,
      threads: [], setups: [], anchors: [], facts: [], beliefs: [],
    } as MemoryDigest,
    outlineRevision: 0,
  };
}

function ev(seq: number): StoredEvent {
  return { seq, turn: 1, timestamp: new Date().toISOString(), source: "model", type: "narration", text: `e${seq}`, line_id: `l${seq}` } as StoredEvent;
}

/** 崩溃孤儿：只落决策节点（无任何边）——putDecision 后 putEdge 前崩溃窗口。 */
async function seedCrashOrphan(store: GameGraphStore, id: string): Promise<void> {
  await store.putDecision(makeDecision({ id, entryState: makeSnapshot() }));
}

describe("RunGraphCoordinator collectGarbage (M5.6)", () => {
  let root: string;
  let store: GameGraphStore;
  let coordinator: RunGraphCoordinator;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "graph-gc-"));
    store = new GameGraphStore(root, "game_gc");
    await store.initialize();
    coordinator = new RunGraphCoordinator(store, new FakeClock(), (p) => `${p}g${++idCounter}`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("recycles a crash orphan and keeps every reached node; idempotent", async () => {
    // 正常推进：root → D1 -A→ D2（游标停驻 D2 表单）。
    await coordinator.startRootRun();
    const d1 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "一" }), moment: moment("m1") });
    await coordinator.beginEdge({ kind: "option", text: "A" });
    await coordinator.appendEdgeEvents([ev(1)]);
    const d2 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "二" }), moment: moment("m2") });

    // 崩溃孤儿（从未进入任何周目路径）。
    await seedCrashOrphan(store, "dc_orphan");

    await coordinator.collectGarbage();

    const decisions = await store.listDecisions();
    expect(decisions.map((d) => d.id).sort()).toEqual([d1, d2].sort());
    // 幂等：再跑一轮不变化、不抛错。
    await coordinator.collectGarbage();
    expect(await store.listDecisions()).toHaveLength(2);
    expect(await store.listEdges()).toHaveLength(1);
  });

  it("never recycles nodes reached by an abandoned run (D7 negative lock)", async () => {
    // run1：D1 -A→ D2 -B→ D3 后弃局于 D3（restart 语义）。
    await coordinator.startRootRun();
    const d1 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "一" }), moment: moment("m1") });
    await coordinator.beginEdge({ kind: "option", text: "A" });
    await coordinator.appendEdgeEvents([ev(1)]);
    const d2 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "二" }), moment: moment("m2") });
    await coordinator.beginEdge({ kind: "option", text: "B" });
    await coordinator.appendEdgeEvents([ev(2)]);
    const d3 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "三" }), moment: moment("m3") });
    const run1 = (await store.loadCursor())!.runId;
    await store.putRun({ id: run1, origin: { kind: "root" }, startedAt: "t", abandonedAt: d3 });

    // 新 root 周目（旧路径内容全部保持——含已弃周目触达的每个节点）。
    const coordinator2 = new RunGraphCoordinator(store, new FakeClock(), (p) => `${p}h${++idCounter}`);
    await coordinator2.collectGarbage();

    const decisions = await store.listDecisions();
    expect(decisions.map((d) => d.id).sort()).toEqual([d1, d2, d3].sort());
    expect(await store.listEdges()).toHaveLength(2);
  });

  it("cascade: downstream of a recycled orphan is recycled too; shared nodes survive", async () => {
    // 活跃周目：root → D1 -A→ D2（全保护）。
    await coordinator.startRootRun();
    const d1 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "一" }), moment: moment("m1") });
    await coordinator.beginEdge({ kind: "option", text: "A" });
    await coordinator.appendEdgeEvents([ev(1)]);
    const d2 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "二" }), moment: moment("m2") });

    // 直接构造崩溃链：孤儿 O（无入边）→ X（入边只来自 O）。
    await store.putDecision(makeDecision({ id: "dc_orphan", entryState: makeSnapshot() }));
    await store.putDecision(
      makeDecision({ id: "dc_downstream", entryState: makeSnapshot() }),
    );
    const orphanEdge: PlotEdge = {
      ...makeEdge({ id: "eg_orphan", from: "dc_orphan" }),
      endState: makeSnapshot(),
      to: { kind: "decision", id: "dc_downstream" },
    };
    await store.putEdge(orphanEdge);

    await coordinator.collectGarbage();

    // 级联回收：孤儿与其独占下游都消失；周目触达节点全部存活。
    const ids = (await store.listDecisions()).map((d) => d.id).sort();
    expect(ids).toEqual([d1, d2].sort());
    expect(await store.listEdges()).toHaveLength(1);
    // 幂等：再跑不变。
    await coordinator.collectGarbage();
    expect((await store.listDecisions()).map((d) => d.id).sort()).toEqual([d1, d2].sort());
  });

  it("store tombstones: removeDecision/removeEdge hide records while the file keeps lines", async () => {
    await coordinator.startRootRun();
    const d1 = await coordinator.openDecision({ modelSceneId: "s1", form: makeForm({ prompt: "一" }), moment: moment("m1") });
    await store.removeDecision(d1);
    expect((await store.listDecisions()).map((d) => d.id)).not.toContain(d1);
    // 磁盘仍是 append-only（原行 + tombstone 行都在）。
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path.join(store.location, "graph", "decisions.jsonl"), "utf8");
    expect(raw.trim().split("\n").length).toBe(2);
  });
});
