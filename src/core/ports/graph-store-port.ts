/**
 * v2 剧情图存储端口（设计 §9 布局，执行清单 M1.2）。
 *
 * 运行时只知道图记录落在某个 per-game 目录里；文件布局、JSONL 编码、
 * 快照文件的拆分方式都是 adapter 的私有事务。核心只见本接口。
 *
 * 读写模型：
 * - 图记录（scenes/decisions/edges/endings/runs）为 append-only JSONL，
 *   `put*` = 追加（同 id 再次写入即取代，读取取最后一次出现）——更新与
 *   追加共用一条路径，历史行天然留痕。
 * - 决策节点的入口快照单独落盘（`snapshots/<decisionId>.json`），是运行
 *   时状态的唯一物理真源；`decisions.jsonl` 只存索引（id/sceneId/form），
 *   `getDecision` 读取时组合成完整 DecisionNode。
 * - 边的 endState 在决策端点时不落盘（由后继节点的入口快照派生，写入时
 *   校验一致）；仅结局端点内联存储（结局没有快照归宿）。
 */
import type { StoredEvent } from "../../schema.js";
import type {
  ActiveCursor,
  DecisionNode,
  EndingNode,
  PlotEdge,
  RunRecord,
  SceneNode,
} from "../graph/types.js";
import type { DecisionId, EdgeId, RunId } from "../graph/ids.js";

export interface GraphStorePort {
  /** Human-readable root of this game's storage (games/<gameId>). */
  readonly location: string;

  /** Create the layout directories this store writes. Idempotent. */
  initialize(): Promise<void>;

  putScene(scene: SceneNode): Promise<void>;

  /** Persist a decision node: index line + entry snapshot in one call. */
  putDecision(node: DecisionNode): Promise<void>;

  /** Null when no record exists; throws on a record whose snapshot is missing. */
  getDecision(id: DecisionId): Promise<DecisionNode | null>;

  listDecisions(): Promise<DecisionNode[]>;

  /**
   * Persist an edge. For a decision endpoint the successor node must already
   * exist and its entry snapshot must equal `edge.endState`; mismatch throws.
   */
  putEdge(edge: PlotEdge): Promise<void>;

  listEdges(): Promise<PlotEdge[]>;

  putEnding(ending: EndingNode): Promise<void>;

  /** Append one replayable event to an edge's payload log. */
  appendPayload(edgeId: EdgeId, event: StoredEvent): Promise<void>;

  /** Missing log reads as empty. */
  readPayload(edgeId: EdgeId): Promise<StoredEvent[]>;

  /** Edge ids that have a payload log on disk (recorded or orphaned). */
  listPayloadIds(): Promise<EdgeId[]>;

  /** Remove an orphaned payload log (no edge record) — restore cleanup. */
  deletePayload(edgeId: EdgeId): Promise<void>;

  /** Latest-wins run record append (create and update share one path). */
  putRun(run: RunRecord): Promise<void>;

  getRun(id: RunId): Promise<RunRecord | null>;

  /** All run records in append order (last element = most recently written). */
  listRuns(): Promise<RunRecord[]>;

  saveCursor(cursor: ActiveCursor): Promise<void>;

  /** Remove the cursor file (run reached its ending — no active run). */
  clearCursor(): Promise<void>;

  /** Null when no cursor file exists (fresh game); a corrupt file warns and reads as null. */
  loadCursor(): Promise<ActiveCursor | null>;
}
