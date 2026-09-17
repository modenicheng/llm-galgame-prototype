/**
 * RunGraphCoordinator 场景内汇流专项测试（执行清单 M2.2）。
 *
 * 配真实 GameGraphStore（tmpdir）+ 可控假判定员，覆盖：跨周目汇流改绑
 * （凭据落盘 + 真实末态内联 + 孤儿化 + 游标前移 + 祖先/异场景候选排除）、
 * 不命中不动图、判定落地前玩家已推进（出边改源 + apply 时防自环守卫）、
 * 开放边改源、判定失败只告警、周目已完结跳过改绑。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameGraphStore } from "../../adapters/storage/game-graph-store.js";
import { RunGraphCoordinator } from "./run-graph-coordinator.js";
import { FakeClock } from "../../test-helpers.js";
import { makeForm } from "../../core/graph/testing.js";
import { createInitialState } from "../../story/state.js";
import type { CharacterState } from "../../story/types.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type {
  ConfluenceJudgment,
  ConfluenceJudgePort,
} from "../../core/ports/confluence-judge-port.js";
import type { StateSnapshot } from "../../core/graph/types.js";
import type { RuntimeMoment } from "../../core/ports/run-graph-port.js";
import type { StoredEvent } from "../../schema.js";

let idCounter = 0;

const SCENE_A = "prologue";
const SCENE_B = "backstreet";

/** 按候选入口的 recent_summary 标记（= story 状态标识）编程判定的假判定员。 */
class FakeJudge implements ConfluenceJudgePort {
  /** 依次记录被比较的候选标记（断言候选枚举的过滤面）。 */
  readonly candidateMarkers: string[] = [];
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly results: (
      candidateMarker: string,
    ) => ConfluenceJudgment | Error | Promise<ConfluenceJudgment>,
  ) {}

  /** 测试同步点：等到第 count 次判定被发起。 */
  async waitCalls(count: number): Promise<void> {
    while (this.candidateMarkers.length < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  judge(input: { endState: StateSnapshot; candidateEntry: StateSnapshot }): Promise<ConfluenceJudgment> {
    const marker = input.candidateEntry.storyState.recent_summary;
    this.candidateMarkers.push(marker);
    for (const waiter of this.waiters.splice(0)) waiter();
    const result = this.results(marker);
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  }
}

function match(confidence = 0.9): ConfluenceJudgment {
  return { equivalent: true, confidence, rationale: `标记等价（${confidence}）`, judgedBy: "fake-judge" };
}

const NO_MATCH: ConfluenceJudgment = {
  equivalent: false,
  confidence: 0.9,
  rationale: "状态分歧",
  judgedBy: "fake-judge",
};

function makeMoment(
  marker: string,
  sceneId = SCENE_A,
  overrides?: { location?: string; characters?: Record<string, CharacterState> },
): RuntimeMoment {
  const base = createInitialState();
  return {
    storyState: createInitialState({
      scene: { ...base.scene, id: sceneId, ...(overrides?.location !== undefined ? { location: overrides.location } : {}) },
      ...(overrides?.characters !== undefined ? { characters: overrides.characters } : {}),
      recent_summary: marker,
    }),
    visualState: { characters: {} },
    memoryDigest: {
      revision: 1,
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

function makeEndEvent(seq: number, text: string): StoredEvent {
  return {
    seq,
    turn: 1,
    timestamp: new Date().toISOString(),
    source: "model",
    type: "end",
    text,
  } as StoredEvent;
}

/**
 * 周目 1：异场景支点 D_B -(回主线)→ D1 -(A)→ D2 -(B)→ D3 -(C)→ 结局。
 * D_B 在 scene B 且 location/在场角色集与主线不同（M2.4 预筛即排除——
 * judge 调用次数断言依赖此）；主线在 scene A（验证祖先排除、跨周目命中）。
 * 世界最大 seq = 7。
 */
async function buildRun1ToEnding(coordinator: RunGraphCoordinator): Promise<void> {
  await coordinator.startRootRun();
  await coordinator.openDecision({
    modelSceneId: SCENE_B,
    form: makeForm(),
    moment: makeMoment("state-B", SCENE_B, { location: "后巷", characters: { 路人: {} } }),
  });
  await coordinator.beginEdge({ kind: "option", text: "回主线" });
  await coordinator.appendEdgeEvents([makeStoredEvent(4)]);
  await coordinator.openDecision({ modelSceneId: SCENE_A, form: makeForm({ prompt: "第一幕" }), moment: makeMoment("state-D1") });
  await coordinator.beginEdge({ kind: "option", text: "A" });
  await coordinator.appendEdgeEvents([makeStoredEvent(5)]);
  await coordinator.openDecision({ modelSceneId: SCENE_A, form: makeForm({ prompt: "第二幕" }), moment: makeMoment("state-D2") });
  await coordinator.beginEdge({ kind: "option", text: "B" });
  await coordinator.appendEdgeEvents([makeStoredEvent(6)]);
  await coordinator.openDecision({ modelSceneId: SCENE_A, form: makeForm({ prompt: "第三幕" }), moment: makeMoment("state-D3") });
  await coordinator.beginEdge({ kind: "option", text: "C" });
  await coordinator.appendEdgeEvents([makeEndEvent(7, "周目一落幕。")]);
  await coordinator.reachEnding({ endingId: "fin", moment: makeMoment("state-end") });
}

/** 周目 2 开局（结局后重开，nextSeq=8）：D1' -(A, 事件 8,9)→ D2' 打开，汇流检查发起。 */
async function startRun2ToD2(
  harness: Awaited<ReturnType<typeof makeHarness>>,
): Promise<{ coordinator: RunGraphCoordinator; store: GameGraphStore }> {
  const { coordinator: c2 } = await harness.reopen();
  const resume = await c2.restoreOrCreateRun({ restart: true });
  if (resume.kind !== "fresh") throw new Error(`expected fresh, got ${resume.kind}`);
  expect(resume.nextSeq).toBe(8);
  await c2.openDecision({ modelSceneId: SCENE_A, form: makeForm(), moment: makeMoment("state-D1-run2") });
  await c2.beginEdge({ kind: "option", text: "A" });
  await c2.appendEdgeEvents([makeStoredEvent(8), makeStoredEvent(9)]);
  await c2.openDecision({ modelSceneId: SCENE_A, form: makeForm({ prompt: "二" }), moment: makeMoment("state-D2-run2") });
  return { coordinator: c2, store: harness.store };
}

async function makeHarness(results: FakeJudge["results"]): Promise<{
  coordinator: RunGraphCoordinator;
  store: GameGraphStore;
  judge: FakeJudge;
  diagnostics: DiagnosticSink;
  root: string;
  /** 在同一世界目录上重开协调器（带同一判定配置）。 */
  reopen: () => Promise<{ coordinator: RunGraphCoordinator; store: GameGraphStore }>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "galgraph-confluence-"));
  const gameId = `game_c${++idCounter}`;
  const diagnostics: DiagnosticSink = { info: vi.fn(), warn: vi.fn() };
  const judge = new FakeJudge(results);
  const build = () => {
    const store = new GameGraphStore(root, gameId);
    const coordinator = new RunGraphCoordinator(store, new FakeClock(), (prefix) => `${prefix}t${++idCounter}`, {
      judge,
      diagnostics,
    });
    return { coordinator, store };
  };
  const first = build();
  return {
    ...first,
    judge,
    diagnostics,
    root,
    reopen: async () => build(),
  };
}

describe("RunGraphCoordinator confluence (M2.2)", () => {
  it("cross-run confluence: reroutes the edge to the matched node with evidence and moves the cursor", async () => {
    const harness = await makeHarness((marker) =>
      marker === "state-D2" ? match(0.9) : NO_MATCH,
    );
    const { coordinator, store, judge } = harness;
    try {
      await buildRun1ToEnding(coordinator);
      const { coordinator: c2 } = await startRun2ToD2(harness);

      // 候选面：同场景、有入边、不在当前路径上的周目 1 节点 D1/D2/D3
      //（异场景的 state-B 与路径上的 D1' 永不入列）
      await judge.waitCalls(3);
      expect(judge.candidateMarkers).toEqual(["state-D1", "state-D2", "state-D3"]);

      // 改绑落地：边 (D1',A) 改指 D2，凭据 + 真实末态内联；游标前移到 D2
      await vi.waitFor(async () => {
        const edges = await store.listEdges();
        const rerouted = edges.find((edge) => edge.payload.lastSeq === 9)!;
        expect(rerouted.confluence).toBeDefined();
      });

      const edges = await store.listEdges();
      const run1EdgeA = edges.find((edge) => edge.payload.lastSeq === 5)!;
      const run2EdgeA = edges.find((edge) => edge.payload.lastSeq === 9)!;
      expect(run1EdgeA.confluence).toBeUndefined(); // 周目 1 的原边不动
      const d2 = run1EdgeA.to.kind === "decision" ? run1EdgeA.to.id : "";
      expect(run2EdgeA.to).toEqual({ kind: "decision", id: d2 });
      expect(run2EdgeA.confluence).toMatchObject({
        matchedNode: d2,
        judgedBy: "fake-judge",
        confidence: 0.9,
      });
      // 汇流边内联真实末态（≠ 候选入口——凭据承担差异审计）
      expect(run2EdgeA.endState.storyState.recent_summary).toBe("state-D2-run2");
      const decision = await store.getDecision(d2);
      expect(run2EdgeA.endState).not.toEqual(decision!.entryState);
      expect((await store.loadCursor())?.position).toBe(d2);

      // 改绑后周目 2 继续推进：游标停在 D2（周目 1 节点）。M5.3 同选项
      // 快进：重选与既有出边（D2 -B→ D3）完全一致的「B」→ 零新边、零生成，
      // 游标直接前移到既有后继 D3（路径事件 = 到 D2 的重放 + 该边负载）。
      const edgesBeforeFF = (await store.listEdges()).length;
      const ff = await c2.beginEdge({ kind: "option", text: "B" });
      expect(ff.kind).toBe("fast_forward");
      const d3 = (await store.listEdges()).find((edge) => edge.payload.lastSeq === 6)!.to;
      expect(ff.kind === "fast_forward" ? ff.restore.decision.id : "").toBe(
        d3.kind === "decision" ? d3.id : "",
      );
      expect(ff.kind === "fast_forward" ? ff.restore.pathEvents.map((event) => event.seq) : []).toEqual([
        8, 9, 6,
      ]);
      expect((await store.listEdges()).length).toBe(edgesBeforeFF); // 图零新增
      expect((await store.loadCursor())?.position).toBe(d3.kind === "decision" ? d3.id : "");

      // 恢复：路径沿最近入边走过 D2（周目 2 的边 seq 更大——M2.1 播种），
      // 再沿周目 1 的 B 边到 D3（跨周目路径按「最近走过」拼接）。
      const { coordinator: c3 } = await harness.reopen();
      const restored = await c3.restoreOrCreateRun();
      if (restored.kind !== "active") throw new Error(`expected active, got ${restored.kind}`);
      expect(restored.restore.pathEvents.map((event) => event.seq)).toEqual([8, 9, 6]);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("no match: the graph stays untouched", async () => {
    const harness = await makeHarness(() => NO_MATCH);
    const { coordinator, store, judge } = harness;
    try {
      await buildRun1ToEnding(coordinator);
      const { coordinator: c2 } = await startRun2ToD2(harness);

      await judge.waitCalls(3);
      await vi.waitFor(async () => {
        expect(judge.candidateMarkers.length).toBeGreaterThanOrEqual(3);
      });
      // 判定均为不等价：边保持指向新建节点，无凭据，游标不动
      const edges = await store.listEdges();
      const run2EdgeA = edges.find((edge) => edge.payload.lastSeq === 9)!;
      expect(run2EdgeA.confluence).toBeUndefined();
      const newNode = run2EdgeA.to.kind === "decision" ? run2EdgeA.to.id : "";
      expect((await store.loadCursor())?.position).toBe(newNode);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("late judgment (player already moved past): the out-edge is re-sourced from the matched node", async () => {
    // 共享 deferred：check#1 与 check#2 都比较 state-D2，同时放行——
    // check#2 的改绑申请必须被 apply 时的祖先守卫拦下（防 D2→D2 自环）。
    let releaseMatch!: (value: ConfluenceJudgment) => void;
    const pendingMatch = new Promise<ConfluenceJudgment>((resolve) => {
      releaseMatch = resolve;
    });
    const harness = await makeHarness((marker) =>
      marker === "state-D2" ? pendingMatch : NO_MATCH,
    );
    const { coordinator, store, judge } = harness;
    try {
      await buildRun1ToEnding(coordinator);
      const { coordinator: c2 } = await startRun2ToD2(harness);
      await judge.waitCalls(3);

      // 判定悬而未决时玩家已解决交互并推进到下一节点（check#2 发起）
      await c2.beginEdge({ kind: "option", text: "B" });
      await c2.appendEdgeEvents([makeStoredEvent(10)]);
      await c2.openDecision({ modelSceneId: SCENE_A, form: makeForm({ prompt: "三" }), moment: makeMoment("state-D3-run2") });
      await judge.waitCalls(6);

      // 判定落地：check#1 改绑（入边改指 + 出边改源）；check#2 的重复申请
      // 被 apply 时守卫拦下
      releaseMatch(match(0.8));
      await vi.waitFor(async () => {
        const edges = await store.listEdges();
        const rerouted = edges.find((edge) => edge.payload.lastSeq === 9)!;
        expect(rerouted.confluence).toBeDefined();
        const outEdge = edges.find((edge) => edge.payload.lastSeq === 10)!;
        expect(outEdge.from).toBe(rerouted.to.id);
      });

      const edges = await store.listEdges();
      const rerouted = edges.find((edge) => edge.payload.lastSeq === 9)!;
      const outEdge = edges.find((edge) => edge.payload.lastSeq === 10)!;
      const d2 = rerouted.to.kind === "decision" ? rerouted.to.id : "";
      expect(rerouted.to).toEqual({ kind: "decision", id: d2 });
      expect(outEdge.from).toBe(d2);
      expect(outEdge.to.kind).toBe("decision");
      expect(outEdge.from).not.toBe(outEdge.to.id); // 无自环
      expect(outEdge.confluence).toBeUndefined();
      const d3 = outEdge.to.kind === "decision" ? outEdge.to.id : "";
      expect((await store.loadCursor())?.position).toBe(d3);

      // 重开恢复：路径 D1' → D2 → D3'（混合周目路径，seq 无撞号）
      const { coordinator: c3 } = await harness.reopen();
      const restored = await c3.restoreOrCreateRun();
      if (restored.kind !== "active") throw new Error(`expected active, got ${restored.kind}`);
      expect(restored.restore.decision.id).toBe(d3);
      expect(restored.restore.pathEvents.map((event) => event.seq)).toEqual([8, 9, 10]);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("pending open edge is re-sourced in memory before it closes", async () => {
    let releaseMatch!: (value: ConfluenceJudgment) => void;
    const pendingMatch = new Promise<ConfluenceJudgment>((resolve) => {
      releaseMatch = resolve;
    });
    const harness = await makeHarness((marker) =>
      marker === "state-D2" ? pendingMatch : NO_MATCH,
    );
    const { coordinator, store, judge } = harness;
    try {
      await buildRun1ToEnding(coordinator);
      const { coordinator: c2 } = await startRun2ToD2(harness);
      await judge.waitCalls(3);

      // 玩家已解决、开放边尚未收束时判定落地
      await c2.beginEdge({ kind: "option", text: "B" });
      releaseMatch(match());
      await c2.appendEdgeEvents([makeStoredEvent(10)]);
      await c2.openDecision({ modelSceneId: SCENE_A, form: makeForm({ prompt: "三" }), moment: makeMoment("state-D3-run2") });

      // 收束后的边从 D2 出发（开放边内存改源生效）
      await vi.waitFor(async () => {
        const edges = await store.listEdges();
        const openThenClosed = edges.find((edge) => edge.payload.lastSeq === 10)!;
        const rerouted = edges.find((edge) => edge.payload.lastSeq === 9)!;
        expect(rerouted.confluence).toBeDefined();
        expect(openThenClosed.from).toBe(rerouted.to.id);
      });
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("excludes other-key nodes before judging (M2.4 pre-screen, judge-call assertion)", async () => {
    const harness = await makeHarness((marker) => {
      if (marker === "state-B") return match(0.99); // 无等价键的候选也不可改绑
      return NO_MATCH;
    });
    const { coordinator, store, judge } = harness;
    try {
      await buildRun1ToEnding(coordinator);
      const { coordinator: c2 } = await startRun2ToD2(harness);

      await judge.waitCalls(3);
      await vi.waitFor(async () => {
        expect(judge.candidateMarkers.length).toBeGreaterThanOrEqual(3);
      });
      // state-B 的 location/在场角色集与主线节点全不等价 → 确定性预筛阶段
      // 即被排除（M2.4），从未送判；判定员对同键候选全部不命中 → 全图无改绑
      expect(judge.candidateMarkers).not.toContain("state-B");
      const edges = await store.listEdges();
      expect(edges.every((edge) => edge.confluence === undefined)).toBe(true);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("judge failures only warn and leave the graph untouched", async () => {
    const harness = await makeHarness(() => new Error("判定服务不可用"));
    const { coordinator, store, judge, diagnostics } = harness;
    try {
      await buildRun1ToEnding(coordinator);
      const { coordinator: c2 } = await startRun2ToD2(harness);

      await judge.waitCalls(3);
      await vi.waitFor(() => {
        expect(diagnostics.warn).toHaveBeenCalled();
      });
      const edges = await store.listEdges();
      expect(edges.every((edge) => edge.confluence === undefined)).toBe(true);
      // 运行时不受影响
      await c2.beginEdge({ kind: "option", text: "B" });
      await c2.appendEdgeEvents([makeStoredEvent(10)]);
      await c2.openDecision({ modelSceneId: SCENE_A, form: makeForm({ prompt: "三" }), moment: makeMoment("state-D3-run2") });
      // 周目 1 四条边 + 周目 2 两条边
      expect((await store.listEdges()).length).toBe(6);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("skips rebinding when the run already completed before the judgment lands", async () => {    let releaseMatch!: (value: ConfluenceJudgment) => void;
    const pendingMatch = new Promise<ConfluenceJudgment>((resolve) => {
      releaseMatch = resolve;
    });
    const harness = await makeHarness((marker) =>
      marker === "state-D2" ? pendingMatch : NO_MATCH,
    );
    const { coordinator, store, judge } = harness;
    try {
      await buildRun1ToEnding(coordinator);
      const { coordinator: c2 } = await startRun2ToD2(harness);
      await judge.waitCalls(3);

      // 周目 2 直接收束结局后再放行判定——改绑窗口已关闭
      await c2.beginEdge({ kind: "option", text: "B" });
      await c2.appendEdgeEvents([makeStoredEvent(10), makeEndEvent(11, "结局。")]);
      await c2.reachEnding({ endingId: "fin2", moment: makeMoment("state-end2") });
      releaseMatch(match());

      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      const edges = await store.listEdges();
      const run2EdgeA = edges.find((edge) => edge.payload.lastSeq === 9)!;
      expect(run2EdgeA.confluence).toBeUndefined();
      expect(await store.loadCursor()).toBeNull(); // 周目已完结，游标已清
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("cross-scene confluence (M2.4): an other-scene node with equivalent keys is judged and rebinds", async () => {
    const harness = await makeHarness((marker) =>
      marker === "state-B-x" ? match(0.95) : NO_MATCH,
    );
    const { coordinator, store, judge } = harness;
    try {
      // 周目 1：主线首节点 → 场景 B 支点（location/角色集与主线同键，且有
      // 入边——预筛与结构过滤都放行）→ 回主线 → 结局。
      await coordinator.startRootRun();
      await coordinator.openDecision({ modelSceneId: SCENE_A, form: makeForm(), moment: makeMoment("state-D0") });
      await coordinator.beginEdge({ kind: "option", text: "进后巷" });
      await coordinator.appendEdgeEvents([makeStoredEvent(4)]);
      const openedBId = await coordinator.openDecision({
        modelSceneId: SCENE_B,
        form: makeForm({ prompt: "后巷" }),
        moment: makeMoment("state-B-x", SCENE_B),
      });
      await coordinator.beginEdge({ kind: "option", text: "回主线" });
      await coordinator.appendEdgeEvents([makeStoredEvent(5)]);
      await coordinator.openDecision({ modelSceneId: SCENE_A, form: makeForm({ prompt: "第一幕" }), moment: makeMoment("state-D1") });
      await coordinator.beginEdge({ kind: "option", text: "A" });
      await coordinator.appendEdgeEvents([makeEndEvent(6, "落幕。")]);
      await coordinator.reachEnding({ endingId: "fin", moment: makeMoment("state-end") });

      // 周目 2：新边末态键与场景 B 支点等价（默认 location 相同）→ 预筛放行
      // → judge 命中 → 跨场景改绑。
      const { coordinator: c2 } = await harness.reopen();
      const resume = await c2.restoreOrCreateRun({ restart: true });
      if (resume.kind !== "fresh") throw new Error(`expected fresh, got ${resume.kind}`);
      await c2.openDecision({ modelSceneId: SCENE_A, form: makeForm(), moment: makeMoment("state-D1-run2") });
      await c2.beginEdge({ kind: "option", text: "A" });
      await c2.appendEdgeEvents([makeStoredEvent(7), makeStoredEvent(8)]);
      await c2.openDecision({ modelSceneId: SCENE_A, form: makeForm({ prompt: "二" }), moment: makeMoment("state-D2-run2") });

      // state-B-x 被送判（预筛未按场景排除）
      await judge.waitCalls(2);
      expect(judge.candidateMarkers).toContain("state-B-x");

      // 改绑落地：新边跨场景改指场景 B 的既有节点 + 游标前移。
      await vi.waitFor(async () => {
        const edges = await store.listEdges();
        const rerouted = edges.find((edge) => edge.payload.lastSeq === 8)!;
        expect(rerouted.confluence).toBeDefined();
        expect(rerouted.to).toEqual({ kind: "decision", id: openedBId });
      });
      expect((await store.loadCursor())?.position).toBe(openedBId);
      // 让后台检查完全落地后再清理（Windows 目录句柄时序）。
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
});
