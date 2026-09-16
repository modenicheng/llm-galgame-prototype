/**
 * RunGraphCoordinator 专项测试（执行清单 M1.3/M1.4）。
 *
 * 配真实 GameGraphStore（tmpdir）跑完整生命周期：开局事件不入图、边负载
 * 与统计、endState 复用入口快照、游标推进与清除、周目完结；M1.4 追加
 * 恢复路径：fresh/active/ended 三态、全路径回放、孤儿 payload 清理、
 * 场景节点缓存水合。这是 Game 级测试（MemoryRunGraph 双打）之下的
 * 真实行为验证层。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
  gameId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "galgraph-coord-"));
  const gameId = `game_t${++idCounter}`;
  const { coordinator, store } = reopenAt(root, gameId);
  return { coordinator, store, root, gameId };
}

/** 同一游戏目录上重开一套 store + 协调器（模拟进程重启）。 */
function reopenAt(root: string, gameId: string) {
  const store = new GameGraphStore(root, gameId);
  const coordinator = new RunGraphCoordinator(
    store,
    new FakeClock(),
    (prefix) => `${prefix}t${++idCounter}`,
  );
  return { coordinator, store };
}

function makeStoredEvent(seq: number, turn = 1): StoredEvent {
  return {
    seq,
    turn,
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
      facts: [],
      beliefs: [],
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
      expect(edges[0]?.endState).toEqual({ snapshotVersion: 2, ...entry2 });

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

/** 建到「游标停在 D2」的图：D1 --E1(seq4,5)--> D2。 */
async function buildToCursorAtD2(root: string, gameId: string) {
  const { coordinator, store } = reopenAt(root, gameId);
  await coordinator.startRootRun();
  const d1 = await coordinator.openDecision({
    modelSceneId: createInitialState().scene.id,
    form: makeForm(),
    moment: makeMoment(),
  });
  await coordinator.beginEdge({ kind: "option", text: "追问" });
  const e1Events = [makeStoredEvent(4), makeStoredEvent(5, 2)];
  await coordinator.appendEdgeEvents(e1Events);
  const entry2 = makeMoment();
  const d2 = await coordinator.openDecision({
    modelSceneId: createInitialState().scene.id,
    form: makeForm({ prompt: "第二个决策" }),
    moment: entry2,
  });
  return { coordinator, store, d1, d2, e1Events, entry2 };
}

describe("RunGraphCoordinator restore (M1.4)", () => {
  /** makeMoment 的 scene id——生产中 openDecision 的 modelSceneId 恒等于 moment.storyState.scene.id。 */
  const SCENE_ID = createInitialState().scene.id;

  it("empty storage reads as fresh and registers a root run", async () => {
    const { coordinator, store, root } = await makeCoordinator();
    try {
      const resume = await coordinator.restoreOrCreateRun();
      expect(resume).toEqual({ kind: "fresh", nextSeq: 1 });
      expect(await store.loadCursor()).toBeNull();
      expect(await store.listRuns()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("active cursor restores the decision, full path events, and seq/turn floors", async () => {
    const made = await makeCoordinator();
    try {
      const built = await buildToCursorAtD2(made.root, made.gameId);
      const { coordinator: reopened, store: store2 } = reopenAt(made.root, made.gameId);
      const resume = await reopened.restoreOrCreateRun();
      if (resume.kind !== "active") throw new Error(`expected active, got ${resume.kind}`);

      expect(resume.restore.decision.id).toBe(built.d2);
      expect(resume.restore.decision.form).toEqual(makeForm({ prompt: "第二个决策" }));
      expect(resume.restore.decision.entryState).toEqual({ snapshotVersion: 2, ...built.entry2 });
      expect(resume.restore.pathEvents).toEqual(built.e1Events);
      // nextSeq = max(世界最大 seq 5, 路径末 seq 5, digest 水位 3) + 1；turn = 路径末事件 turn
      expect(resume.restore.nextSeq).toBe(6);
      expect(resume.restore.turnFloor).toBe(2);

      // 水合后的状态机可直接续写：同一场景不再建第二个场景节点
      await reopened.beginEdge({ kind: "option", text: "恢复后的选择" });
      await reopened.appendEdgeEvents([makeStoredEvent(6)]);
      await reopened.openDecision({
        modelSceneId: SCENE_ID,
        form: makeForm({ prompt: "第三个决策" }),
        moment: makeMoment(),
      });
      const scenesText = await readFile(path.join(store2.location, "graph/scenes.jsonl"), "utf8");
      expect(scenesText.trim().split("\n")).toHaveLength(1);
      expect((await store2.loadCursor())?.position).not.toBe(built.d2);
    } finally {
      await rm(made.root, { recursive: true, force: true });
    }
  });

  it("multi-edge paths replay in story order across the whole run", async () => {
    const made = await makeCoordinator();
    try {
      const { coordinator } = reopenAt(made.root, made.gameId);
      await coordinator.startRootRun();
      await coordinator.openDecision({ modelSceneId: "s", form: makeForm(), moment: makeMoment() });
      await coordinator.beginEdge({ kind: "option", text: "a" });
      await coordinator.appendEdgeEvents([makeStoredEvent(1), makeStoredEvent(2)]);
      await coordinator.openDecision({ modelSceneId: "s", form: makeForm({ prompt: "二" }), moment: makeMoment() });
      await coordinator.beginEdge({ kind: "option", text: "b" });
      await coordinator.appendEdgeEvents([makeStoredEvent(3), makeStoredEvent(4)]);
      await coordinator.openDecision({ modelSceneId: "s", form: makeForm({ prompt: "三" }), moment: makeMoment() });

      const { coordinator: reopened } = reopenAt(made.root, made.gameId);
      const resume = await reopened.restoreOrCreateRun();
      if (resume.kind !== "active") throw new Error(`expected active, got ${resume.kind}`);
      expect(resume.restore.pathEvents.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      expect(resume.restore.nextSeq).toBe(5);
    } finally {
      await rm(made.root, { recursive: true, force: true });
    }
  });

  it("orphan payload files (no edge record) are deleted on restore; recorded ones survive", async () => {
    const made = await makeCoordinator();
    try {
      const { store } = await buildToCursorAtD2(made.root, made.gameId);
      // 崩溃残留：玩家已选择、事件已追加，但边记录尚未落盘
      await store.appendPayload("edge_ghost", makeStoredEvent(9));
      const payloadsDir = path.join(store.location, "graph", "payloads");
      expect(await readdirCount(payloadsDir)).toBe(2); // e1 + ghost

      const { coordinator: reopened, store: store2 } = reopenAt(made.root, made.gameId);
      const resume = await reopened.restoreOrCreateRun();
      expect(resume.kind).toBe("active");
      expect(await readdirCount(payloadsDir)).toBe(1); // ghost 已清理
      const remaining = await store2.listPayloadIds();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatch(/^eg_/);
    } finally {
      await rm(made.root, { recursive: true, force: true });
    }
  });

  it("an ended run without cursor restores as ended with the text recovered from the payload", async () => {
    const made = await makeCoordinator();
    try {
      const { coordinator } = reopenAt(made.root, made.gameId);
      await coordinator.startRootRun();
      await coordinator.openDecision({ modelSceneId: "天台", form: makeForm(), moment: makeMoment() });
      await coordinator.beginEdge({ kind: "option", text: "留下" });
      await coordinator.appendEdgeEvents([makeStoredEvent(4), makeEndEvent(5, "故事圆满。")]);
      const endingId = await coordinator.reachEnding({ endingId: "good", moment: makeMoment() });

      const { coordinator: reopened } = reopenAt(made.root, made.gameId);
      const resume = await reopened.restoreOrCreateRun();
      expect(resume).toEqual({ kind: "ended", endingId, endingText: "故事圆满。" });
    } finally {
      await rm(made.root, { recursive: true, force: true });
    }
  });

  it("ended text prefers the most recent run reaching the same ending id", async () => {
    const made = await makeCoordinator();
    try {
      // 周目 1 → end_fin（文本 A）；周目 2（结局后重开 root）→ 同一 end_fin（文本 B）。
      // 运行时 ending id 易重号：恢复 ended 必须呈现最新周目的文本。
      const first = reopenAt(made.root, made.gameId);
      await first.coordinator.startRootRun();
      await first.coordinator.openDecision({ modelSceneId: "天台", form: makeForm(), moment: makeMoment() });
      await first.coordinator.beginEdge({ kind: "option", text: "留下" });
      await first.coordinator.appendEdgeEvents([makeEndEvent(4, "初版的结局。")]);
      await first.coordinator.reachEnding({ endingId: "fin", moment: makeMoment() });

      const second = reopenAt(made.root, made.gameId);
      const secondResume = await second.coordinator.restoreOrCreateRun({ restart: true });
      expect(secondResume).toEqual({ kind: "fresh", nextSeq: 5 });
      await second.coordinator.openDecision({ modelSceneId: "天台", form: makeForm(), moment: makeMoment() });
      await second.coordinator.beginEdge({ kind: "option", text: "追上去" });
      await second.coordinator.appendEdgeEvents([makeEndEvent(5, "重开后的结局。")]);
      await second.coordinator.reachEnding({ endingId: "fin", moment: makeMoment() });

      const third = reopenAt(made.root, made.gameId);
      const resume = await third.coordinator.restoreOrCreateRun();
      expect(resume).toEqual({ kind: "ended", endingId: "end_fin", endingText: "重开后的结局。" });
    } finally {
      await rm(made.root, { recursive: true, force: true });
    }
  });

  it("an ending reached before any decision restores with a null text", async () => {
    const made = await makeCoordinator();
    try {
      const { coordinator } = reopenAt(made.root, made.gameId);
      await coordinator.startRootRun();
      const endingId = await coordinator.reachEnding({ endingId: "solo", moment: makeMoment() });

      const { coordinator: reopened } = reopenAt(made.root, made.gameId);
      const resume = await reopened.restoreOrCreateRun();
      expect(resume).toEqual({ kind: "ended", endingId, endingText: null });
    } finally {
      await rm(made.root, { recursive: true, force: true });
    }
  });
});

describe("RunGraphCoordinator retrace (M1.5)", () => {
  it("restart abandons the active run at the cursor and opens a retrace run bound to the cursor", async () => {
    const made = await makeCoordinator();
    try {
      const built = await buildToCursorAtD2(made.root, made.gameId);
      const oldRunId = (await built.store.listRuns()).at(-1)!.id;

      const { coordinator: reopened, store: store2 } = reopenAt(made.root, made.gameId);
      const resume = await reopened.restoreOrCreateRun({ restart: true });
      if (resume.kind !== "active") throw new Error(`expected active, got ${resume.kind}`);
      expect(resume.restore.decision.id).toBe(built.d2);

      // 旧周目弃局留痕（latest-wins），新周目 origin=retrace 且游标改绑
      const runs = await store2.listRuns();
      const oldRun = runs.find((run) => run.id === oldRunId);
      expect(oldRun?.abandonedAt).toBe(built.d2);
      const newRun = runs.at(-1)!;
      expect(newRun.id).not.toBe(oldRunId);
      expect(newRun.origin).toEqual({ kind: "retrace", from: built.d2 });
      expect((await store2.loadCursor())?.runId).toBe(newRun.id);

      // retrace 周目的新选择产生新边（D2 出边此前不存在）
      await reopened.beginEdge({ kind: "option", text: "新的选择" });
      await reopened.appendEdgeEvents([makeStoredEvent(6)]);
      const ending = await reopened.reachEnding({ endingId: "done", moment: makeMoment() });
      const edges = await store2.listEdges();
      expect(edges).toHaveLength(2);
      expect(edges[1]?.from).toBe(built.d2);
      expect(edges[1]?.to).toEqual({ kind: "ending", id: ending });
      const finished = (await store2.listRuns()).find((run) => run.id === newRun.id);
      expect(finished?.ending).toBe(ending);
    } finally {
      await rm(made.root, { recursive: true, force: true });
    }
  });

  it("restart on an ended world (no cursor) starts a fresh root run seeded from world max seq", async () => {
    const made = await makeCoordinator();
    try {
      const { coordinator } = reopenAt(made.root, made.gameId);
      await coordinator.startRootRun();
      await coordinator.openDecision({ modelSceneId: "天台", form: makeForm(), moment: makeMoment() });
      await coordinator.beginEdge({ kind: "option", text: "留下" });
      await coordinator.appendEdgeEvents([makeEndEvent(4, "初版的结局。")]);
      await coordinator.reachEnding({ endingId: "solo", moment: makeMoment() });

      const { coordinator: reopened, store: store2 } = reopenAt(made.root, made.gameId);
      const resume = await reopened.restoreOrCreateRun({ restart: true });
      // 世界最大 seq = 4（周目 1 的末边负载）→ 新 root 周目从 5 起算（M2.1 决议）
      expect(resume).toEqual({ kind: "fresh", nextSeq: 5 });
      const runs = await store2.listRuns();
      expect(runs).toHaveLength(2);
      expect(runs.at(-1)?.origin).toEqual({ kind: "root" });
      expect(runs.at(-1)?.endedAt).toBeUndefined();
    } finally {
      await rm(made.root, { recursive: true, force: true });
    }
  });

  it("restart on an empty world simply starts the first root run", async () => {
    const made = await makeCoordinator();
    try {
      const { coordinator: reopened, store: store2 } = reopenAt(made.root, made.gameId);
      const resume = await reopened.restoreOrCreateRun({ restart: true });
      expect(resume).toEqual({ kind: "fresh", nextSeq: 1 });
      expect(await store2.listRuns()).toHaveLength(1);
    } finally {
      await rm(made.root, { recursive: true, force: true });
    }
  });
});

function makeEndEvent(seq: number, text: string): StoredEvent {
  return {
    seq,
    turn: 1,
    timestamp: new Date().toISOString(),
    source: "model",
    type: "end",
    ending_id: `end_${seq}`,
    text,
  } as StoredEvent;
}

async function readdirCount(dir: string): Promise<number> {
  await stat(dir); // 目录必须存在
  const { readdir } = await import("node:fs/promises");
  return (await readdir(dir)).length;
}
