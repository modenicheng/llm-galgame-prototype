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
import type { InteractionFormSnapshot, MemoryDigest } from "../graph/types.js";
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

export interface RunGraphPort {
  /** Human-readable root of this game's storage. */
  readonly location: string;

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
