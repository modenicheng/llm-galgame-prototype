/**
 * 剧情图运行时端口（执行清单 M1.3）。
 *
 * Game（演员管线）以此把 actor 生命周期翻译成图操作：玩家解决交互 → 开边；
 * 交互正式打开 → 落决策节点（入口快照）+ 游标推进 + 收束前一条边；end →
 * 结局节点 + 周目完结。实现方（RunGraphCoordinator）持有当前周目与开放边
 * 的状态机；core 只见本接口。开局段（首个决策点之前）的事件不入图——
 * 无边可挂，恢复语义见执行清单 M1.1 决议。
 */
import type { StoredEvent } from "../../schema.js";
import type { StoryState } from "../../story/types.js";
import type { VisualState } from "../presentation/types.js";
import type {
  DecisionNode,
  InteractionFormSnapshot,
  MemoryDigest,
} from "../graph/types.js";
import type { DecisionId, EndingId, RunId } from "../graph/ids.js";

/** 快照时刻的运行时状态（决策入口与结局末态共用）。 */
export interface RuntimeMoment {
  storyState: StoryState;
  visualState: VisualState;
  memoryDigest: MemoryDigest;
  /** M1 无编剧期恒为 0；大纲修订计数（M3）接入后递增。 */
  outlineRevision: number;
}

/** 玩家的解决方式（边的 choice 语义）。 */
export interface EdgeChoice {
  kind: "option" | "free_input";
  text: string;
}

/** 恢复点：游标决策节点的完整重建材料（执行清单 M1.4）。 */
export interface RestorePoint {
  /** 游标决策节点（入口快照 + 表单快照）。 */
  decision: DecisionNode;
  /**
   * 本周目根 → 游标的全部边负载事件（提交历史，按剧情序）。导演追赶把它
   * 喂给 observeCommitted——内部按 seq 水位过滤，恰好只入队未整理窗口；
   * Game 同时用它重建演员的生成上下文。
   */
  pathEvents: StoredEvent[];
  /**
   * seq 计数器播种（下一个分配槽位）：max(路径末事件 seq, digest 水位) + 1，
   * 保证恢复后新事件不与重放事件撞号、周目内严格单调。
   */
  nextSeq: number;
  /** turn 播种：路径末事件（游标交互事件自身）的 turn；首个决策点为 1。 */
  turnFloor: number;
}

/** 「继续游戏」入口的三态结果：全新 / 周目已完结 / 游标恢复。 */
export type RunResume =
  | { kind: "fresh" }
  | {
      kind: "ended";
      /** 已完结周目的契约结局 id。 */
      endingId: EndingId;
      /** 从末边负载回收的结局文本；开局直落结局（无负载）为 null。 */
      endingText: string | null;
    }
  | { kind: "active"; restore: RestorePoint };

export interface RunGraphPort {
  /** Human-readable root of this game's storage. */
  readonly location: string;

  /**
   * 「继续游戏」统一入口：无游标且最新周目未完结 → 开启全新 root run
   * （返回 fresh）；游标存在 → 水合状态机并返回恢复点（active）；最新
   * 周目已完结 → 返回其结局（ended，不改变状态机）。
   *
   * `restart: true`（宿主 restart_session / 「重来」）：活跃周目弃局
   * （abandonedAt = 游标位）并在游标节点开启 retrace 新周目——表单重放、
   * 新选择产生新边（M1.5）；已完结世界则直接开新 root 周目（再玩一轮），
   * 永不返回 ended。实现内部负责孤儿 payload 清理与场景节点缓存重建。
   */
  restoreOrCreateRun(options?: { restart?: boolean }): Promise<RunResume>;

  /** 全新开局：登记 root 周目（游标在首个决策点出现前不落盘）。 */
  startRootRun(): Promise<RunId>;

  /**
   * 玩家解决交互 → 开放新边（此后已提交事件进边负载）。必须在解决事件
   * 自身入负载之前调用，使选择事件成为新边首条负载。
   */
  beginEdge(choice: EdgeChoice): Promise<void>;

  /** 已提交事件追加进当前开放边负载；无开放边（开局段）时忽略。 */
  appendEdgeEvents(events: readonly StoredEvent[]): Promise<void>;

  /**
   * 交互正式打开：收束当前边（endState = 本次入口快照）→ 落决策节点 →
   * 游标推进。同一交互只能打开一次。
   */
  openDecision(input: {
    /** StoryState.scene.id（模型场景）——场景节点按需惰性创建。 */
    modelSceneId: string;
    form: InteractionFormSnapshot;
    moment: RuntimeMoment;
  }): Promise<DecisionId>;

  /**
   * 结局：收束当前边（指向结局节点，末态快照内联）→ 结局节点 → 周目
   * 完结 + 游标清除。开局直接结局（无开放边）也成立。
   */
  reachEnding(input: { endingId: string; moment: RuntimeMoment }): Promise<EndingId>;
}
