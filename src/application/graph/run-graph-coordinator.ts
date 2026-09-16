/**
 * RunGraphCoordinator —— RunGraphPort 的应用层实现（执行清单 M1.3）。
 *
 * 把演员管线的生命周期翻译成 GraphStorePort 的图记录：
 * - 玩家解决交互（`beginEdge`）→ 开放新边（choice 语义 + 负载统计累积）；
 * - 交互正式打开（`openDecision`）→ 前一条边收束（endState 复用本次入口
 *   快照，§3.3 不变量的结构保证）→ 决策节点落盘 → 游标推进；
 * - `end`（`reachEnding`）→ 结局节点 + 末态内联 → 周目完结 + 游标清除。
 *
 * 开局段（首个决策点之前）无开放边，事件不入图（M1.1 决议）。
 * M1 无编剧期：场景节点惰性创建，outlineRef 指向种子大纲节点 ol_seed
 * （outline.json 本体随 M3.1 OutlineStore 落地）。
 */
import type { StoredEvent } from "../../schema.js";
import type { ClockPort } from "../../core/ports/clock-port.js";
import type { GraphStorePort } from "../../core/ports/graph-store-port.js";
import type {
  ConfluenceJudgment,
  ConfluenceJudgePort,
} from "../../core/ports/confluence-judge-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type {
  EdgeChoice,
  RestorePoint,
  RunResume,
  RuntimeMoment,
  RunGraphPort,
} from "../../core/ports/run-graph-port.js";
import type {
  ActiveCursor,
  DecisionNode,
  InteractionFormSnapshot,
  PlotEdge,
  RunRecord,
  SceneNode,
  StateSnapshot,
} from "../../core/graph/types.js";
import { SNAPSHOT_VERSION } from "../../core/graph/types.js";
import type {
  DecisionId,
  EdgeId,
  EndingId,
  RunId,
  SceneId,
} from "../../core/graph/ids.js";
import {
  DECISION_ID_PREFIX,
  EDGE_ID_PREFIX,
  ENDING_ID_PREFIX,
  RUN_ID_PREFIX,
  SCENE_ID_PREFIX,
} from "../../core/graph/ids.js";
import type { OutlineNodeId } from "../../core/graph/ids.js";
import type {
  OutlineStorePort,
  OutlineOp,
} from "../../core/ports/outline-store-port.js";
import type { OutlineMaintainerPort } from "../../application/outline/outline-writer.js";
import type { OutlineNode } from "../../core/outline/types.js";

/** M1 种子大纲节点 id（编剧 M3.2 接入后由真实大纲取代；不迁移旧 game）。 */
export const SEED_OUTLINE_NODE_ID = "ol_seed";

interface OpenEdge {
  id: EdgeId;
  from: DecisionId;
  choice: EdgeChoice;
  eventCount: number;
  firstSeq: number;
  lastSeq: number;
}

interface CurrentRun {
  id: RunId;
  startedAt: string;
  /** 周目来源（root/retrace）——结局收束回写 run 记录时必须原样保留。 */
  origin: RunRecord["origin"];
}

export class RunGraphCoordinator implements RunGraphPort {
  readonly location: string;

  private currentRun: CurrentRun | null = null;
  private lastDecisionId: DecisionId | null = null;
  private openEdge: OpenEdge | null = null;
  /** 模型场景 id → 场景节点 id（会话内缓存；恢复路径 M1.4 重建）。 */
  private readonly sceneNodes = new Map<string, SceneId>();
  /** 场景节点 → outlineRef（M3.4：确定性迁移的去重依据）。 */
  private readonly sceneOutlineRefs = new Map<SceneId, OutlineNodeId>();
  /**
   * 图变更互斥链：演员管线的生命周期调用与后台汇流改绑共用一条串行队列。
   * 互斥体只做快速落盘/状态变更；LLM 判定在链外等待，绝不阻塞运行时。
   */
  private mutationChain: Promise<unknown> = Promise.resolve();
  private readonly judge: ConfluenceJudgePort | undefined;
  private readonly diagnostics: DiagnosticSink;
  /**
   * M3.4 大纲动态维护：OutlineStore 接线后，确定性迁移（activate/realize）
   * 走 applyRevision；后台维护（LLM maintainer）fire-and-forget 产 op。
   * outlineRevision 缓存供 RuntimeMoment 嵌入快照。
   */
  private readonly outline:
    | { store: OutlineStorePort; maintainer?: OutlineMaintainerPort }
    | undefined;
  private outlineLoaded = false;
  private outlineNodes: OutlineNode[] = [];
  private outlineRevision = 0;
  /** 前沿 outlineRef（D5：首个未 realized 的 act）与其场景节点。 */
  private frontierOutlineRef: OutlineNodeId | null = null;
  private frontierSceneId: SceneId | null = null;
  private maintenanceRunning = false;

  constructor(
    private readonly store: GraphStorePort,
    private readonly clock: ClockPort,
    private readonly newId: (prefix: string) => string,
    options?: {
      judge?: ConfluenceJudgePort;
      diagnostics?: DiagnosticSink;
      outline?: { store: OutlineStorePort; maintainer?: OutlineMaintainerPort };
    },
  ) {
    this.location = store.location;
    this.judge = options?.judge;
    this.diagnostics = options?.diagnostics ?? silentDiagnosticSink;
    this.outline = options?.outline;
  }

  /** 串行执行一次图变更（见 mutationChain）。 */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(op, op);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  async startRootRun(): Promise<RunId> {
    return this.enqueue(() => this.startRootRunUnsafe());
  }

  private async startRootRunUnsafe(): Promise<RunId> {
    await this.store.initialize();
    const run: CurrentRun = {
      id: this.newId(RUN_ID_PREFIX) as RunId,
      startedAt: this.clock.nowIso(),
      origin: { kind: "root" },
    };
    this.currentRun = run;
    this.lastDecisionId = null;
    this.openEdge = null;
    await this.store.putRun({ id: run.id, origin: run.origin, startedAt: run.startedAt });
    return run.id;
  }

  /**
   * 「继续游戏」统一入口（M1.4）：游标存在 → 水合状态机并返回恢复点；
   * 无游标 → 最新周目已完结则补报结局，否则开新局。孤儿 payload（崩溃时
   * 已追加事件但边记录未落盘）在恢复时删除——重生成走新边 id（M1.1 决议）。
   */
  async restoreOrCreateRun(options?: { restart?: boolean }): Promise<RunResume> {
    return this.enqueue(() => this.restoreOrCreateRunUnsafe(options));
  }

  private async restoreOrCreateRunUnsafe(
    options?: { restart?: boolean },
  ): Promise<RunResume> {
    await this.store.initialize();
    const cursor = await this.store.loadCursor();
    if (cursor === null) {
      const lastRun = (await this.store.listRuns()).at(-1);
      if (
        !options?.restart &&
        lastRun?.endedAt !== undefined &&
        lastRun.ending !== undefined
      ) {
        return {
          kind: "ended",
          endingId: lastRun.ending,
          endingText: await this.endingTextOf(lastRun.ending),
        };
      }
      // seq 从世界最大值播种（M2.1 决议）：结局后重开的新 root 周目不得
      // 从 1 回绕——同世界边负载 seq 重叠会破坏跨周目单调性。
      const worldMax = worldMaxSeq(await this.store.listEdges());
      await this.startRootRunUnsafe();
      return { kind: "fresh", nextSeq: worldMax + 1 };
    }
    if (options?.restart) {
      return { kind: "active", restore: await this.restartFromCursor(cursor) };
    }
    return { kind: "active", restore: await this.hydrateFromCursor(cursor) };
  }

  /**
   * M1.5（重来）：活跃周目弃局留痕（abandonedAt = 游标位），在游标节点
   * 开启 retrace 新周目并改绑游标。图如实记录两次周目；快进/回溯到祖先
   * 节点随 M5.3 回溯入口接入（游标节点恒为前沿、无出边，同选项快进在此
   * 入口语义下不可达——见执行清单 M1.5 注记）。
   */
  private async restartFromCursor(cursor: ActiveCursor): Promise<RestorePoint> {
    const restore = await this.hydrateFromCursor(cursor);
    const previous = await this.store.getRun(cursor.runId);
    if (previous !== null && previous.endedAt === undefined) {
      await this.store.putRun({ ...previous, abandonedAt: cursor.position });
    }
    const run: CurrentRun = {
      id: this.newId(RUN_ID_PREFIX) as RunId,
      startedAt: this.clock.nowIso(),
      origin: { kind: "retrace", from: cursor.position },
    };
    this.currentRun = run;
    await this.store.putRun({
      id: run.id,
      origin: { kind: "retrace", from: cursor.position },
      startedAt: run.startedAt,
    });
    await this.store.saveCursor({ runId: run.id, position: cursor.position });
    return restore;
  }

  /** 从游标重建协调器状态机与恢复点材料（快照缺失时 store 会大声抛错）。 */
  private async hydrateFromCursor(cursor: ActiveCursor): Promise<RestorePoint> {
    const run = await this.store.getRun(cursor.runId);
    if (run === null) {
      throw new Error(`游标指向不存在的周目（结构损坏）：${cursor.runId}`);
    }
    const decision = await this.store.getDecision(cursor.position);
    if (decision === null) {
      throw new Error(`游标指向不存在的决策节点（结构损坏）：${cursor.position}`);
    }

    const edges = await this.store.listEdges();
    await this.discardOrphanPayloads(edges);

    // 根 → 游标的路径回放：逐节点取「最近走过」的入边（payload.lastSeq
    // 最大者；M1.4 单入边下唯一，M1.5 retrace 后该规则仍指向当前周目）。
    const chunks: StoredEvent[][] = [];
    let nodeId: DecisionId | null = cursor.position;
    const visited = new Set<string>();
    while (nodeId !== null && !visited.has(nodeId)) {
      visited.add(nodeId);
      const inEdge = pickLatestInEdge(edges, nodeId);
      if (inEdge === undefined) break;
      chunks.push(await this.store.readPayload(inEdge.id));
      nodeId = inEdge.from;
    }
    const pathEvents = chunks.reverse().flat();

    const watermark = decision.entryState.memoryDigest.consolidatedThroughEventSeq;
    const pathLastSeq = pathEvents.at(-1)?.seq ?? 0;
    this.currentRun = { id: cursor.runId, startedAt: run.startedAt, origin: run.origin };
    this.lastDecisionId = cursor.position;
    this.openEdge = null;
    return {
      decision,
      pathEvents,
      // 下一个分配槽位：新事件不与重放事件撞号（周目内严格单调），且不与
      // 同世界其他周目（含被弃分支）的 seq 撞号（跨周目单调，M2.1 决议）。
      nextSeq: Math.max(worldMaxSeq(edges), pathLastSeq, watermark) + 1,
      turnFloor: pathEvents.at(-1)?.turn ?? 1,
    };
  }

  /** 有 payload 文件但无边记录 = 崩溃残留，删除（边负载只在收束时定形）。 */
  private async discardOrphanPayloads(edges: readonly PlotEdge[]): Promise<void> {
    const recorded = new Set(edges.map((edge) => edge.id));
    for (const payloadId of await this.store.listPayloadIds()) {
      if (!recorded.has(payloadId)) {
        await this.store.deletePayload(payloadId);
      }
    }
  }

  /**
   * 已完结周目的结局文本：从指向结局的边负载回收；开局直落结局为 null。
   * 同一结局 id 可被多个周目到达（运行时 ending_N 易重号），倒序扫描取
   * 最近写入的边——ended 恢复呈现的应是最新周目的文本。
   */
  private async endingTextOf(endingId: EndingId): Promise<string | null> {
    const edges = await this.store.listEdges();
    for (let i = edges.length - 1; i >= 0; i -= 1) {
      const edge = edges[i];
      if (edge === undefined || edge.to.kind !== "ending" || edge.to.id !== endingId) continue;
      const events = await this.store.readPayload(edge.id);
      for (let j = events.length - 1; j >= 0; j -= 1) {
        const event = events[j];
        if (event?.type === "end") return event.text ?? null;
      }
    }
    return null;
  }

  async beginEdge(choice: EdgeChoice): Promise<void> {
    return this.enqueue(() => this.beginEdgeUnsafe(choice));
  }

  private async beginEdgeUnsafe(choice: EdgeChoice): Promise<void> {
    if (this.currentRun === null) {
      throw new Error("beginEdge：无活动周目（startRootRun 未调用）");
    }
    if (this.lastDecisionId === null) {
      throw new Error("beginEdge：首个决策点尚未打开（开局段事件不入图）");
    }
    if (this.openEdge !== null) {
      throw new Error(`beginEdge：边 ${this.openEdge.id} 尚未收束（演员管线时序被破坏）`);
    }
    this.openEdge = {
      id: this.newId(EDGE_ID_PREFIX) as EdgeId,
      from: this.lastDecisionId,
      choice,
      eventCount: 0,
      firstSeq: 0,
      lastSeq: 0,
    };
  }

  async appendEdgeEvents(events: readonly StoredEvent[]): Promise<void> {
    return this.enqueue(() => this.appendEdgeEventsUnsafe(events));
  }

  private async appendEdgeEventsUnsafe(events: readonly StoredEvent[]): Promise<void> {
    if (this.openEdge === null) return; // 开局段：无边可挂
    for (const event of events) {
      await this.store.appendPayload(this.openEdge.id, event);
      if (this.openEdge.eventCount === 0) this.openEdge.firstSeq = event.seq;
      this.openEdge.lastSeq = event.seq;
      this.openEdge.eventCount += 1;
    }
  }

  async openDecision(input: {
    modelSceneId: string;
    form: InteractionFormSnapshot;
    moment: RuntimeMoment;
  }): Promise<DecisionId> {
    const opened = await this.enqueue(async () => {
      const opened = await this.openDecisionUnsafe(input);
      this.scheduleConfluenceCheck(input, opened);
      return opened;
    });
    // M3.4：大纲后台维护 fire-and-forget（LLM 链外，落盘走 store 队列）。
    void this.maintainOutlineQuietly(input);
    return opened.decisionId;
  }

  private async openDecisionUnsafe(input: {
    modelSceneId: string;
    form: InteractionFormSnapshot;
    moment: RuntimeMoment;
  }): Promise<{ decisionId: DecisionId; sceneId: SceneId; closedEdgeId: EdgeId | null }> {
    if (this.currentRun === null) {
      throw new Error("openDecision：无活动周目（startRootRun 未调用）");
    }
    const decisionId = this.newId(DECISION_ID_PREFIX) as DecisionId;
    const sceneId = await this.ensureSceneNode(input.modelSceneId);
    const entryState = toStateSnapshot(input.moment);
    await this.store.putDecision({ id: decisionId, sceneId, entryState, form: input.form });
    await this.migrateOutlineForScene(sceneId);

    // 先收束前一条边（endState = 本次入口快照），再推进游标。
    const edge = this.openEdge;
    this.openEdge = null;
    if (edge !== null) {
      await this.store.putEdge({
        id: edge.id,
        from: edge.from,
        choice: edge.choice,
        payload: {
          eventCount: edge.eventCount,
          firstSeq: edge.firstSeq,
          lastSeq: edge.lastSeq,
        },
        endState: entryState,
        to: { kind: "decision", id: decisionId },
      });
    }

    this.lastDecisionId = decisionId;
    await this.store.saveCursor({ runId: this.currentRun.id, position: decisionId });
    return {
      decisionId,
      sceneId,
      closedEdgeId: edge !== null ? edge.id : null,
    };
  }

  async reachEnding(input: { endingId: string; moment: RuntimeMoment }): Promise<EndingId> {
    return this.enqueue(() => this.reachEndingUnsafe(input));
  }

  currentOutlineRevision(): number {
    return this.outlineRevision;
  }

  // ----------------------------------------------------------------
  // M3.4 大纲确定性迁移与后台维护
  // ----------------------------------------------------------------

  /** 惰性加载 OutlineStore（缺文件 = 空大纲 revision 0）。 */
  private async ensureOutlineLoaded(): Promise<void> {
    if (this.outline === undefined || this.outlineLoaded) return;
    this.outlineLoaded = true;
    const snap = await this.outline.store.load();
    this.outlineNodes = snap.nodes;
    this.outlineRevision = snap.revision;
  }

  /**
   * 确定性迁移（无 LLM，openDecision 时机，决议 D5）：
   * - 场景的首个决策落成 → 其 outlineRef 节点 activate（planned → active）；
   * - 进入不同 outlineRef 的场景 → 上一前沿 act realize
   *   （instantiatedBy = 上一场景节点）。
   * applyRevision 内部整批校验；迁移失败只告警不阻塞演出（实时性红线）。
   */
  private async migrateOutlineForScene(sceneId: SceneId): Promise<void> {
    if (this.outline === undefined) return;
    try {
      await this.ensureOutlineLoaded();
      if (this.sceneOutlineRefs.has(sceneId)) return; // 同场景后续决策：不迁移

      // ① 进入新场景：上一前沿 act（active 且未被实例化）→ realize。
      if (this.frontierOutlineRef !== null && this.frontierSceneId !== null) {
        const previous = this.outlineNodes.find((n) => n.id === this.frontierOutlineRef);
        if (previous?.status === "active" && previous.instantiatedBy === undefined) {
          await this.applyOutlineQuietly(
            [
              {
                type: "realize",
                id: previous.id,
                instantiatedBy: this.frontierSceneId,
              },
            ],
            "M3.4：游玩进入下一幕场景 → 上一前沿 act realize",
          );
        }
      }

      // ② 前沿推进：首个未 realized 的 act；planned → activate。
      const ref = this.pickFrontierRef();
      this.sceneOutlineRefs.set(sceneId, ref);
      const node = this.outlineNodes.find((n) => n.id === ref);
      if (node?.status === "planned") {
        await this.applyOutlineQuietly([{ type: "activate", id: ref }], "M3.4：场景首个决策落成 → activate");
      }

      this.frontierOutlineRef = ref;
      this.frontierSceneId = sceneId;
    } catch (err) {
      this.diagnostics.warn("RunGraphCoordinator", `大纲确定性迁移失败（不阻塞演出）：${String(err)}`);
    }
  }

  /** D5 前沿 = 首个未 realized 的 act；无大纲（dev 种子世界）时回退 ol_seed。 */
  private pickFrontierRef(): OutlineNodeId {
    const frontier = this.outlineNodes.find(
      (n) => n.kind === "act" && n.status !== "realized",
    );
    return (frontier?.id ?? SEED_OUTLINE_NODE_ID) as OutlineNodeId;
  }

  private async applyOutlineQuietly(ops: OutlineOp[], reason: string): Promise<void> {
    if (this.outline === undefined) return;
    try {
      this.outlineRevision = await this.outline.store.applyRevision(ops, reason);
      this.outlineNodes = this.outline.store.getOutline().nodes;
    } catch (err) {
      this.diagnostics.warn("RunGraphCoordinator", `大纲修订被拒绝（${reason}）：${String(err)}`);
    }
  }

  /** 后台维护（LLM）：单飞；产 op 预筛后 applyRevision，store 兜底拒绝非法。 */
  private async maintainOutlineQuietly(input: {
    moment: RuntimeMoment;
    modelSceneId: string;
  }): Promise<void> {
    if (
      this.outline?.maintainer === undefined ||
      this.maintenanceRunning ||
      this.outlineNodes.length === 0
    ) {
      return;
    }
    this.maintenanceRunning = true;
    try {
      const ops = await this.outline.maintainer.maintainOutline({
        outline: this.outlineNodes,
        recentSummary: input.moment.storyState.recent_summary,
        memoryDigest: input.moment.memoryDigest,
      });
      const allowed = ops.filter((op) => {
        if (op.type === "add") return op.node.status === "planned";
        if (op.type === "prune") {
          const target = this.outlineNodes.find((n) => n.id === op.id);
          if (target === undefined) return false;
          return target.status === "planned" || (target.status === "active" && target.instantiatedBy === undefined);
        }
        return false; // 维护不得 activate/realize（确定性迁移独占）
      });
      if (allowed.length > 0) {
        await this.applyOutlineQuietly(allowed, "M3.4：后台维护（LLM）");
      }
    } catch (err) {
      this.diagnostics.warn("RunGraphCoordinator", `大纲后台维护失败（忽略）：${String(err)}`);
    } finally {
      this.maintenanceRunning = false;
    }
  }

  private async reachEndingUnsafe(input: {
    endingId: string;
    moment: RuntimeMoment;
  }): Promise<EndingId> {
    if (this.currentRun === null) {
      throw new Error("reachEnding：无活动周目（startRootRun 未调用）");
    }
    const endingId = `${ENDING_ID_PREFIX}${sanitizeIdSuffix(input.endingId)}` as EndingId;
    const endState = toStateSnapshot(input.moment);
    await this.store.putEnding({ id: endingId });

    const edge = this.openEdge;
    this.openEdge = null;
    if (edge !== null) {
      await this.store.putEdge({
        id: edge.id,
        from: edge.from,
        choice: edge.choice,
        payload: {
          eventCount: edge.eventCount,
          firstSeq: edge.firstSeq,
          lastSeq: edge.lastSeq,
        },
        endState,
        to: { kind: "ending", id: endingId },
      });
    }

    await this.store.putRun({
      id: this.currentRun.id,
      origin: this.currentRun.origin,
      startedAt: this.currentRun.startedAt,
      endedAt: this.clock.nowIso(),
      ending: endingId,
    });
    this.currentRun = null;
    await this.store.clearCursor();
    return endingId;
  }

  /**
   * 场景节点按模型场景 id 世界级稳定（M2.2 修订）：缓存 → 扫既有决策
   * 入口快照 → 惰性创建。此前只有恢复路径重建缓存，fresh 新周目会给同一
   * 模型场景再建一个场景节点——M2.2 的同场景候选过滤按 sceneId 匹配，
   * 跨周目汇流因此失效（场景图 UI 亦会重复），故收口在此单点。
   */
  private async ensureSceneNode(modelSceneId: string): Promise<SceneId> {
    const cached = this.sceneNodes.get(modelSceneId);
    if (cached !== undefined) return cached;
    const existing = (await this.store.listDecisions()).find(
      (node) => node.entryState.storyState.scene.id === modelSceneId,
    );
    if (existing !== undefined) {
      this.sceneNodes.set(modelSceneId, existing.sceneId);
      return existing.sceneId;
    }
    const sceneId = this.newId(SCENE_ID_PREFIX) as SceneId;
    const scene: SceneNode = {
      id: sceneId,
      outlineRef: SEED_OUTLINE_NODE_ID,
      status: "active",
    };
    await this.store.putScene(scene);
    this.sceneNodes.set(modelSceneId, sceneId);
    return sceneId;
  }

  // ----------------------------------------------------------------
  // 场景内汇流（执行清单 M2.2，设计 §3.3）
  //
  // 边收束（openDecision）后，后台把新边末态与同场景既有决策节点入口态
  // 交给 judge 比较；命中即改绑：边改指既有节点（判定凭据 + 真实末态
  // 内联）、紧随其后的出边改从既有节点出发、游标仍在新节点时前移到既有
  // 节点——新节点沦为孤儿（与崩溃孤儿同性质，恢复与路径行走均不理会）。
  // 改绑窗口守卫：仅当创建该边的周目仍是活动周目时落地（换周目/已完结
  // 即跳过）。判定是 LLM 调用，全程在互斥链之外；只有改绑本身入队。
  // ----------------------------------------------------------------

  /** fire-and-forget：判定失败只告警，绝不影响运行时（实时性红线）。 */
  private scheduleConfluenceCheck(
    input: { modelSceneId: string; moment: RuntimeMoment },
    opened: { decisionId: DecisionId; sceneId: SceneId; closedEdgeId: EdgeId | null },
  ): void {
    if (this.judge === undefined || opened.closedEdgeId === null || this.currentRun === null) {
      return;
    }
    const context = {
      runId: this.currentRun.id,
      edgeId: opened.closedEdgeId,
      newNodeId: opened.decisionId,
      sceneId: opened.sceneId,
      endState: toStateSnapshot(input.moment),
    };
    void this.runConfluenceCheck(context).catch((error: unknown) => {
      this.diagnostics.warn(
        "RunGraphCoordinator",
        `汇流判定失败（边 ${context.edgeId} 保持原指向）：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async runConfluenceCheck(context: {
    runId: RunId;
    edgeId: EdgeId;
    newNodeId: DecisionId;
    sceneId: SceneId;
    endState: StateSnapshot;
  }): Promise<void> {
    const judge = this.judge;
    if (judge === undefined) return;

    // 候选 = 同场景、有入边（孤儿/周目首节点排除）、不在当前路径上
    //（防成环）的决策节点；自身按构造精确相等，亦排除。
    const decisions = await this.store.listDecisions();
    const edges = await this.store.listEdges();
    const withInEdge = new Set(
      edges.filter((edge) => edge.to.kind === "decision").map((edge) => edge.to.id),
    );
    const pathNodes = pathAncestors(edges, context.newNodeId);
    const candidates = decisions.filter(
      (node) =>
        node.sceneId === context.sceneId &&
        node.id !== context.newNodeId &&
        !pathNodes.has(node.id) &&
        withInEdge.has(node.id),
    );
    if (candidates.length === 0) return;

    const judged = await Promise.allSettled(
      candidates.map(async (candidate) => ({
        candidate,
        judgment: await judge.judge({
          endState: context.endState,
          candidateEntry: candidate.entryState,
        }),
      })),
    );
    let best: { candidate: (typeof candidates)[number]; judgment: ConfluenceJudgment } | null = null;
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

    await this.enqueue(() =>
      this.applyConfluenceMatch(context, best.candidate.id, best.judgment),
    );
  }

  /**
   * 互斥链内的改绑落地。全量守卫后重写两条边（入边改指、出边改源），
   * 并在游标仍停在新节点时前移。任一守卫不满足即静默放弃（世界已前进，
   * 该次判定的窗口已关闭）。
   */
  private async applyConfluenceMatch(
    context: {
      runId: RunId;
      edgeId: EdgeId;
      newNodeId: DecisionId;
      endState: StateSnapshot;
    },
    candidate: DecisionId,
    judgment: ConfluenceJudgment,
  ): Promise<void> {
    if (this.currentRun?.id !== context.runId) return; // 换周目/已完结：窗口关闭
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

    // ② 新节点的出边改从候选出发（尚未收束的开放边只改内存）。此刻它必
    //   是普通决策端点（终点为结局 = 周目已完结 = 上方守卫已拦），endState
    //   不变、写入门禁照常通过。
    if (this.openEdge?.from === context.newNodeId) {
      this.openEdge = { ...this.openEdge, from: candidate };
    } else {
      const outEdge = edges.find(
        (item) => item.id !== context.edgeId && item.from === context.newNodeId,
      );
      if (outEdge !== undefined) {
        await this.store.putEdge({ ...outEdge, from: candidate });
      }
    }

    // ③ 游标仍停在新节点 → 前移到候选（运行时继续用它解析交互）。
    if (this.lastDecisionId === context.newNodeId) {
      this.lastDecisionId = candidate;
    }
    if (cursor !== null && cursor.runId === context.runId && cursor.position === context.newNodeId) {
      await this.store.saveCursor({ ...cursor, position: candidate });
    }
    this.diagnostics.info(
      "RunGraphCoordinator",
      `汇流成立：边 ${context.edgeId} 改指既有节点 ${candidate}（${judgment.judgedBy}，置信 ${judgment.confidence.toFixed(2)}）；节点 ${context.newNodeId} 沦为孤儿`,
    );
  }
}

function toStateSnapshot(moment: RuntimeMoment): StateSnapshot {
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    storyState: moment.storyState,
    visualState: moment.visualState,
    memoryDigest: moment.memoryDigest,
    outlineRevision: moment.outlineRevision,
  };
}

/**
 * 世界最大已落盘事件 seq（各边负载统计的 lastSeq 取最大）。开局段事件不
 * 入图、孤儿 payload 恢复时删除，故 recorded edges 的统计即存活事件的全集。
 */
function worldMaxSeq(edges: readonly PlotEdge[]): number {
  return edges.reduce((max, edge) => Math.max(max, edge.payload.lastSeq), 0);
}

/** 指向 `nodeId` 的入边中最近走过的一条（payload.lastSeq 最大）。 */
function pickLatestInEdge(edges: readonly PlotEdge[], nodeId: DecisionId): PlotEdge | undefined {
  let best: PlotEdge | undefined;
  for (const edge of edges) {
    if (edge.to.kind !== "decision" || edge.to.id !== nodeId) continue;
    if (best === undefined || edge.payload.lastSeq > best.payload.lastSeq) best = edge;
  }
  return best;
}

/**
 * 根 → `start` 的当前路径节点集（含 start）：沿「最近走过」的入边回溯。
 * 汇流候选排除该集合——把边指回自己正在走的路径即成环。
 */
function pathAncestors(edges: readonly PlotEdge[], start: DecisionId): Set<DecisionId> {
  const visited = new Set<DecisionId>();
  let nodeId: DecisionId | null = start;
  while (nodeId !== null && !visited.has(nodeId)) {
    visited.add(nodeId);
    const inEdge = pickLatestInEdge(edges, nodeId);
    nodeId = inEdge?.from ?? null;
  }
  return visited;
}

/** 运行时结局 id → 契约后缀字符集（[A-Za-z0-9._-]）。 */
function sanitizeIdSuffix(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unnamed";
}
