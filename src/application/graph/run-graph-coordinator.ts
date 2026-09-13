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
  EdgeChoice,
  RuntimeMoment,
  RunGraphPort,
} from "../../core/ports/run-graph-port.js";
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
import type { InteractionFormSnapshot, SceneNode, StateSnapshot } from "../../core/graph/types.js";
import { SNAPSHOT_VERSION } from "../../core/graph/types.js";

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
}

export class RunGraphCoordinator implements RunGraphPort {
  readonly location: string;

  private currentRun: CurrentRun | null = null;
  private lastDecisionId: DecisionId | null = null;
  private openEdge: OpenEdge | null = null;
  /** 模型场景 id → 场景节点 id（会话内缓存；恢复路径 M1.4 重建）。 */
  private readonly sceneNodes = new Map<string, SceneId>();

  constructor(
    private readonly store: GraphStorePort,
    private readonly clock: ClockPort,
    private readonly newId: (prefix: string) => string,
  ) {
    this.location = store.location;
  }

  async startRootRun(): Promise<RunId> {
    await this.store.initialize();
    const run: CurrentRun = {
      id: this.newId(RUN_ID_PREFIX) as RunId,
      startedAt: this.clock.nowIso(),
    };
    this.currentRun = run;
    this.lastDecisionId = null;
    this.openEdge = null;
    await this.store.putRun({ id: run.id, origin: { kind: "root" }, startedAt: run.startedAt });
    return run.id;
  }

  async beginEdge(choice: EdgeChoice): Promise<void> {
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
    if (this.currentRun === null) {
      throw new Error("openDecision：无活动周目（startRootRun 未调用）");
    }
    const decisionId = this.newId(DECISION_ID_PREFIX) as DecisionId;
    const sceneId = await this.ensureSceneNode(input.modelSceneId);
    const entryState = toStateSnapshot(input.moment);
    await this.store.putDecision({ id: decisionId, sceneId, entryState, form: input.form });

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
    return decisionId;
  }

  async reachEnding(input: { endingId: string; moment: RuntimeMoment }): Promise<EndingId> {
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
      origin: { kind: "root" },
      startedAt: this.currentRun.startedAt,
      endedAt: this.clock.nowIso(),
      ending: endingId,
    });
    this.currentRun = null;
    await this.store.clearCursor();
    return endingId;
  }

  private async ensureSceneNode(modelSceneId: string): Promise<SceneId> {
    const cached = this.sceneNodes.get(modelSceneId);
    if (cached !== undefined) return cached;
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

/** 运行时结局 id → 契约后缀字符集（[A-Za-z0-9._-]）。 */
function sanitizeIdSuffix(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unnamed";
}
