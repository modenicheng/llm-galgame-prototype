/**
 * ConfluenceChecker —— 汇流子系统（执行清单 M2.2/M2.4，设计 §3.3），自
 * run-graph-coordinator 拆出（豁免清偿）。
 *
 * 边收束（openDecision）后，后台把新边末态与既有决策节点入口态交给
 * judge 比较；命中即改绑：边改指既有节点（判定凭据 + 真实末态内联）、
 * 紧随其后的出边改从既有节点出发、游标仍在新节点时前移到既有节点——
 * 新节点沦为孤儿（与崩溃孤儿同性质，恢复与路径行走均不理会）。
 * 改绑窗口守卫：仅当创建该边的周目仍是活动周目时落地（换周目/已完结
 * 即跳过）。判定是 LLM 调用，全程在互斥链之外；只有改绑本身入队。
 *
 * M2.4：候选不再限同场景（场景间汇流，§3.3）——末态索引 + 确定性预筛
 * 限流 judge 调用（location 等价 / 在场角色集合等价 / outline 物理地点
 * 等价（D8）至少一项才送判，按命中键数降序优先）；滞后汇流天然获得
 * （新边收束时对索引全量预筛，旧节点即候选）。
 *
 * 对协调器的访问经由 deps 的具名操作（互斥入队 / 周目判定 / 开放边与
 * 最近决策的重挂 / 大纲读取），协调器可变状态不出其自身。
 */
import type { ConfluenceJudgment, ConfluenceJudgePort } from "../../core/ports/confluence-judge-port.js";
import type { GraphStorePort } from "../../core/ports/graph-store-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { ClockPort } from "../../core/ports/clock-port.js";
import type {
  DecisionId,
  EdgeId,
  OutlineNodeId,
  RunId,
  SceneId,
} from "../../core/graph/ids.js";
import type { StateSnapshot } from "../../core/graph/types.js";
import type { OutlineNode } from "../../core/outline/types.js";
import { pathAncestors, toStateSnapshot } from "../../core/graph/walk.js";
import type { RuntimeMoment } from "../../core/ports/run-graph-port.js";

/**
 * 末态索引摘要键（M2.4 ①）：从决策入口快照提取的确定性等价键。
 * outlineLocation 经 sceneId → 场景节点 outlineRef → OutlineNode.location
 * 解析（D8：同物理场景不同状态的高优先候选信号）；entryState 随键缓存，
 * 候选判定零额外快照读取。
 */
interface EndStateKey {
  decisionId: DecisionId;
  sceneId: SceneId;
  location: string;
  characters: string[];
  outlineLocation?: string;
  entryState: StateSnapshot;
}

/** 协调器侧依赖：具名操作，可变状态（开放边/最近决策/互斥链）留协调器。 */
export interface ConfluenceCheckerDeps {
  /** 图变更互斥链：只有改绑落地入队，判定在链外（实时性红线）。 */
  enqueue: <T>(op: () => Promise<T>) => Promise<T>;
  /** 当前活动周目 id（null = 无活动周目：换周目/已完结 = 窗口关闭）。 */
  currentRunId: () => RunId | null;
  /** 开放边改源：开放边 from=`from` 时改挂 `to` 并返回 true；否则 false。 */
  relinkOpenEdge: (from: DecisionId, to: DecisionId) => boolean;
  /** 最近决策重指：lastDecision=`from` 时改指 `to`。 */
  relinkLastDecision: (from: DecisionId, to: DecisionId) => void;
  /** 大纲读取（D8 物理地点键的解析源；大纲未装配 = 无键）。 */
  outline:
    | {
        ensureLoaded(): Promise<void>;
        nodes(): readonly OutlineNode[];
        sceneRefs(): ReadonlyMap<SceneId, OutlineNodeId>;
      }
    | undefined;
}

export class ConfluenceChecker {
  /** 场景 id → 摘要键列表（内存；hydrate 单点重建，惰性一次）。 */
  private endStateIndex: Map<SceneId, EndStateKey[]> | null = null;

  constructor(
    private readonly store: GraphStorePort,
    private readonly judge: ConfluenceJudgePort | undefined,
    private readonly diagnostics: DiagnosticSink,
    private readonly deps: ConfluenceCheckerDeps,
  ) {}

  /** 索引就绪后的增量维护：新决策节点入索引（D8 键经内存映射解析，与 hydrate 同源）。 */
  indexDecision(decisionId: DecisionId, sceneId: SceneId, entryState: StateSnapshot): void {
    if (this.endStateIndex === null) return; // 未 hydrate → 首次重建时自然包含
    const key = extractEndStateKey(decisionId, sceneId, entryState);
    const ref = this.deps.outline?.sceneRefs().get(sceneId);
    const outlineLocation = ref !== undefined
      ? this.deps.outline?.nodes().find((n) => n.id === ref)?.location
      : undefined;
    if (outlineLocation !== undefined) key.outlineLocation = outlineLocation;
    const bucket = this.endStateIndex.get(sceneId);
    if (bucket !== undefined) bucket.push(key);
    else this.endStateIndex.set(sceneId, [key]);
  }

  /** 索引就绪后的增量维护：汇流孤儿化节点出索引。 */
  deindexDecision(decisionId: DecisionId): void {
    if (this.endStateIndex === null) return;
    for (const [sceneId, bucket] of this.endStateIndex) {
      const next = bucket.filter((k) => k.decisionId !== decisionId);
      if (next.length !== bucket.length) this.endStateIndex.set(sceneId, next);
    }
  }

  /** fire-and-forget：判定失败只告警，绝不影响运行时（实时性红线）。 */
  schedule(
    input: { modelSceneId: string; moment: RuntimeMoment },
    opened: { decisionId: DecisionId; sceneId: SceneId; closedEdgeId: EdgeId | null },
  ): void {
    if (this.judge === undefined || opened.closedEdgeId === null || this.deps.currentRunId() === null) {
      return;
    }
    const context = {
      runId: this.deps.currentRunId()!,
      edgeId: opened.closedEdgeId,
      newNodeId: opened.decisionId,
      sceneId: opened.sceneId,
      endState: toStateSnapshot(input.moment),
    };
    void this.runCheck(context).catch((error: unknown) => {
      this.diagnostics.warn(
        "RunGraphCoordinator",
        `汇流判定失败（边 ${context.edgeId} 保持原指向）：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async runCheck(context: {
    runId: RunId;
    edgeId: EdgeId;
    newNodeId: DecisionId;
    sceneId: SceneId;
    endState: StateSnapshot;
  }): Promise<void> {
    const judge = this.judge;
    if (judge === undefined) return;

    // 末态索引（M2.4 ①）→ 候选不再限同场景（场景间汇流）。
    const index = await this.hydrateEndStateIndex();
    const newKey = extractEndStateKey(context.newNodeId, context.sceneId, context.endState);

    const edges = await this.store.listEdges();
    const withInEdge = new Set(
      edges.filter((edge) => edge.to.kind === "decision").map((edge) => edge.to.id),
    );
    const pathNodes = pathAncestors(edges, context.newNodeId);
    // 保留：非自身、不在当前路径上（防成环）、有入边（孤儿/周目首节点排除）。
    const allKeys = [...index.values()].flat();
    const scored = allKeys
      .filter(
        (key) =>
          key.decisionId !== context.newNodeId &&
          !pathNodes.has(key.decisionId) &&
          withInEdge.has(key.decisionId),
      )
      .map((key) => ({ key, score: prescreenScore(newKey, key) }))
      .filter(({ score }) => score > 0) // 确定性预筛限流：无等价键不送 judge
      .sort((a, b) => b.score - a.score); // 命中键数降序优先（D8 高优先）

    // 滞后汇流天然获得：此处对索引全量预筛，旧节点即新边收束时的候选。
    if (scored.length === 0) return;

    // 预筛通过者仍逐个交 judge，置信最高命中走既有改绑。
    const judged = await Promise.allSettled(
      scored.map(async ({ key }) => ({
        candidate: key,
        judgment: await judge.judge({
          endState: context.endState,
          candidateEntry: key.entryState,
        }),
      })),
    );
    let best: { candidate: EndStateKey; judgment: ConfluenceJudgment } | null = null;
    for (const result of judged) {
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.diagnostics.warn("RunGraphCoordinator", `汇流判定单项失败（跳过该候选）：${reason}`);
        continue;
      }
      const { candidate, judgment } = result.value;
      if (!judgment.equivalent) continue;
      if (best === null || judgment.confidence > best.judgment.confidence) {
        best = { candidate, judgment };
      }
    }
    if (best === null) return;

    await this.deps.enqueue(() =>
      this.applyMatch(context, best.candidate.decisionId, best.judgment),
    );
  }

  /**
   * 互斥链内的改绑落地。全量守卫后重写两条边（入边改指、出边改源），
   * 并在游标仍停在新节点时前移。任一守卫不满足即静默放弃（世界已前进，
   * 该次判定的窗口已关闭）。
   */
  private async applyMatch(
    context: {
      runId: RunId;
      edgeId: EdgeId;
      newNodeId: DecisionId;
      endState: StateSnapshot;
    },
    candidate: DecisionId,
    judgment: ConfluenceJudgment,
  ): Promise<void> {
    if (this.deps.currentRunId() !== context.runId) return; // 换周目/已完结：窗口关闭
    const edges = await this.store.listEdges();
    const edge = edges.find((item) => item.id === context.edgeId);
    if (
      edge === undefined ||
      edge.to.kind !== "decision" ||
      edge.to.id !== context.newNodeId ||
      edge.confluence !== undefined
    ) {
      return; // 已被改绑或世界已变化
    }
    const cursor = await this.store.loadCursor();
    if (
      candidate === context.newNodeId ||
      (cursor !== null && pathAncestors(edges, cursor.position).has(candidate))
    ) {
      return; // 防成环：候选落在当前路径上
    }

    // ① 入边改指候选节点：confluence 边内联真实末态（≠ 候选入口，凭据
    //   承担差异审计——2026-09-15 存储修订），免精确一致门禁。
    await this.store.putEdge({
      ...edge,
      endState: edge.endState,
      to: { kind: "decision", id: candidate },
      confluence: {
        matchedNode: candidate,
        judgedBy: judgment.judgedBy,
        confidence: judgment.confidence,
        rationale: judgment.rationale,
      },
    });

    // ② 新节点的出边改从候选出发。开放边（尚未收束）只改内存；否则该
    //   出边已落盘，直接改写。此刻它必是普通决策端点（终点为结局 = 周目
    //   已完结 = 上方守卫已拦），endState 不变、写入门禁照常通过。
    const relinked = this.deps.relinkOpenEdge(context.newNodeId, candidate);
    if (!relinked) {
      const outEdge = edges.find(
        (item) => item.id !== context.edgeId && item.from === context.newNodeId,
      );
      if (outEdge !== undefined) {
        await this.store.putEdge({ ...outEdge, from: candidate });
      }
    }

    // ③ 游标仍停在新节点 → 前移到候选（运行时继续用它解析交互）。
    this.deps.relinkLastDecision(context.newNodeId, candidate);
    if (cursor !== null && cursor.runId === context.runId && cursor.position === context.newNodeId) {
      await this.store.saveCursor({ ...cursor, position: candidate });
    }
    // M2.4：新节点沦为孤儿 → 出末态索引（不再作为后续汇流候选）。
    this.deindexDecision(context.newNodeId);
    this.diagnostics.info(
      "RunGraphCoordinator",
      `汇流成立：边 ${context.edgeId} 改指既有节点 ${candidate}（${judgment.judgedBy}，置信 ${judgment.confidence.toFixed(2)}）；节点 ${context.newNodeId} 沦为孤儿`,
    );
  }

  /** 惰性重建末态索引（单点：listDecisions + listScenes + outline 位置解析）。 */
  private async hydrateEndStateIndex(): Promise<Map<SceneId, EndStateKey[]>> {
    if (this.endStateIndex !== null) return this.endStateIndex;
    const decisions = await this.store.listDecisions();
    const scenes = await this.store.listScenes();
    if (this.deps.outline !== undefined) await this.deps.outline.ensureLoaded();
    const outlineNodes = this.deps.outline?.nodes() ?? [];
    const outlineLocationByRef = new Map<OutlineNodeId, string | undefined>(
      outlineNodes.map((n) => [n.id, n.location]),
    );
    const outlineRefBySceneId = new Map(scenes.map((s) => [s.id, s.outlineRef]));
    const index = new Map<SceneId, EndStateKey[]>();
    for (const decision of decisions) {
      const key = extractEndStateKey(decision.id, decision.sceneId, decision.entryState);
      const outlineLocation = outlineRefBySceneId.get(decision.sceneId) === undefined
        ? undefined
        : outlineLocationByRef.get(outlineRefBySceneId.get(decision.sceneId)!);
      if (outlineLocation !== undefined) key.outlineLocation = outlineLocation;
      const bucket = index.get(decision.sceneId);
      if (bucket !== undefined) bucket.push(key);
      else index.set(decision.sceneId, [key]);
    }
    this.endStateIndex = index;
    return index;
  }
}

/** 从快照提取摘要键。 */
function extractEndStateKey(
  decisionId: DecisionId,
  sceneId: SceneId,
  snapshot: StateSnapshot,
): EndStateKey {
  return {
    decisionId,
    sceneId,
    location: snapshot.storyState.scene.location,
    characters: Object.keys(snapshot.storyState.characters).sort(),
    entryState: snapshot,
  };
}

/** 确定性预筛：命中键数（0 = 不送 judge）。 */
function prescreenScore(newKey: EndStateKey, candidate: EndStateKey): number {
  let score = 0;
  if (newKey.location !== "" && newKey.location === candidate.location) score += 1;
  if (
    newKey.characters.length > 0 &&
    newKey.characters.length === candidate.characters.length &&
    newKey.characters.every((c, i) => c === candidate.characters[i])
  ) {
    score += 1;
  }
  // D8：outline 物理地点等价（同地不同状态是常见汇流点）。
  if (
    newKey.outlineLocation !== undefined &&
    newKey.outlineLocation === candidate.outlineLocation
  ) {
    score += 1;
  }
  return score;
}
