/**
 * RunGraphCoordinator 专项测试（执行清单 M1.3）。
 *
 * 配真实 GameGraphStore（tmpdir）跑完整生命周期：开局事件不入图、边负载
 * 与统计、endState 复用入口快照、游标推进与清除、周目完结。这是 Game 级
 * 测试（MemoryRunGraph 双打）之下的真实行为验证层。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameGraphStore } from "../../adapters/storage/game-graph-store.js";
import { RunGraphCoordinator } from "./run-graph-coordinator.js";
import { FakeClock } from "../../test-helpers.js";
import { makeForm } from "../../core/graph/testing.js";
import { createInitialState } from "../../story/state.js";
import type { RuntimeMoment } from "../../core/ports/run-graph-port.js";
import type { StoredEvent } from "../../schema.js";

let idCounter = 0;

async function makeCoordinator(): Promise<{
  coordinator: RunGraphCoordinator;
  store: GameGraphStore;
  root: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "galgraph-coord-"));
  const store = new GameGraphStore(root, `game_t${++idCounter}`);
  const coordinator = new RunGraphCoordinator(
    store,
    new FakeClock(),
    (prefix) => `${prefix}t${++idCounter}`,
  );
  return { coordinator, store, root };
}

function makeStoredEvent(seq: number): StoredEvent {
  return {
    seq,
    turn: 1,
    timestamp: new Date().toISOString(),
    source: "model",
    type: "narration",
    text: `事件 ${seq}`,
    line_id: `line-${seq}`,
  } as StoredEvent;
}

function makeMoment(): RuntimeMoment {
  return {
    storyState: createInitialState(),
    visualState: { characters: {} },
    memoryDigest: {
      revision: 1,
      consolidatedThroughEventSeq: 3,
      checkpointCount: 1,
      threads: [],
      setups: [],
      anchors: [],
    },
    outlineRevision: 0,
  };
}

describe("RunGraphCoordinator", () => {
  it("opening-segment events stay out of the graph; beginEdge before any decision throws", async () => {
    const { coordinator, store, root } = await makeCoordinator();
    try {
      await coordinator.startRootRun();

      // 开局段：无决策点 → 边负载忽略、beginEdge 拒绝
      await coordinator.appendEdgeEvents([makeStoredEvent(1)]);
      await expect(coordinator.beginEdge({ kind: "option", text: "过早选择" })).rejects.toThrow();
      expect(await store.listEdges()).toHaveLength(0);
      expect(await store.loadCursor()).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("full lifecycle: decision → edge with payload stats → decision; cursor follows", async () => {
    const { coordinator, store, root } = await makeCoordinator();
    try {
      await coordinator.startRootRun();

      const d1 = await coordinator.openDecision({
        modelSceneId: "旧校舍",
        form: makeForm(),
        moment: makeMoment(),
      });

      await coordinator.beginEdge({ kind: "option", text: "追问" });
      await coordinator.appendEdgeEvents([makeStoredEvent(4), makeStoredEvent(5)]);

      const entry2 = makeMoment();
      const d2 = await coordinator.openDecision({
        modelSceneId: "旧校舍",
        form: makeForm({ prompt: "下一个决策" }),
        moment: entry2,
      });

      const edges = await store.listEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0]?.from).toBe(d1);
      expect(edges[0]?.to).toEqual({ kind: "decision", id: d2 });
      expect(edges[0]?.choice).toEqual({ kind: "option", text: "追问" });
      expect(edges[0]?.payload).toEqual({ eventCount: 2, firstSeq: 4, lastSeq: 5 });
      // endState 复用后继入口快照（同一次快照写两处）
      expect(edges[0]?.endState).toEqual({ snapshotVersion: 1, ...entry2 });

      expect(await store.listDecisions()).toHaveLength(2);
      expect((await store.loadCursor())?.position).toBe(d2);

      // 场景节点按模型场景 id 惰性创建且只建一次
      const scenesText = await readFile(path.join(store.location, "graph/scenes.jsonl"), "utf8");
      expect(scenesText.trim().split("\n")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reachEnding: ending node, inline endState edge, run ended, cursor cleared", async () => {
    const { coordinator, store, root } = await makeCoordinator();
    try {
      const runId = await coordinator.startRootRun();

      await coordinator.openDecision({
        modelSceneId: "天台",
        form: makeForm(),
        moment: makeMoment(),
      });
      await coordinator.beginEdge({ kind: "free_input", text: "抱住她" });
      await coordinator.appendEdgeEvents([makeStoredEvent(9)]);

      const endingId = await coordinator.reachEnding({ endingId: "normal end/1", moment: makeMoment() });
      expect(endingId).toMatch(/^end_/);
      expect(endingId).not.toContain("/"); // 非法字符被净化

      const edges = await store.listEdges();
      expect(edges[0]?.to).toEqual({ kind: "ending", id: endingId });
      expect(edges[0]?.payload.eventCount).toBe(1);

      const run = await store.getRun(runId);
      expect(run?.endedAt).toBeTruthy();
      expect(run?.ending).toBe(endingId);
      expect(await store.loadCursor()).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ending before any decision (no open edge) still concludes the run", async () => {
    const { coordinator, store, root } = await makeCoordinator();
    try {
      const runId = await coordinator.startRootRun();
      const endingId = await coordinator.reachEnding({ endingId: "solo", moment: makeMoment() });
      const run = await store.getRun(runId);
      expect(run?.ending).toBe(endingId);
      expect(await store.loadCursor()).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
