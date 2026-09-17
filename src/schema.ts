import type { StageCue } from "./core/presentation/types.js";
import type { EndingGrade } from "./core/protocol/gal-dsl/types.js";
/** 结局档位词表类型（@ending 指令）：单一来源在 gal-dsl 协议层，这里转出口。 */
export type { EndingGrade } from "./core/protocol/gal-dsl/types.js";
import {
  InteractionEventSchema,
  DialogueDraftEventSchema,
  NarrationDraftEventSchema,
  PortraitSchema,
  StoryStatePatchSchema,
  LinePerformanceSchema,
  type InteractionEvent,
  type StoryStatePatch,
  type LinePerformance,
} from "./story/types.js";
// Re-export for convenience
export type {
  InteractionEvent,
  ChoiceInteraction,
  InputInteraction,
  HybridInteraction,
  LinePerformance,
} from "./story/types.js";
export {
  PortraitSchema,
  DialogueDraftEventSchema,
  NarrationDraftEventSchema,
  LinePerformanceSchema,
} from "./story/types.js";
export { InteractionEventSchema } from "./story/types.js";
/** Pure presentation types for the stage (stage cues attached to events). */
export type { StageCue } from "./core/presentation/types.js";
export interface Portrait {
  character: string;
  expression: string;
  position: "left" | "center" | "right";
}

export interface DialogueDraftEvent {
  type: "dialogue";
  speaker: string;
  text: string;
  portrait?: Portrait | null;
  performance?: LinePerformance;
}

export interface NarrationDraftEvent {
  type: "narration";
  text: string;
  performance?: LinePerformance;
}

export interface ChoiceOption {
  id: string;
  text: string;
}

/**
 * Runtime-only branching terminal. Never produced by the model (the DSL
 * interaction form is the model-side contract); the runtime synthesizes it
 * from a mode=choice interaction to drive BranchManager/branch prefetch.
 */
export interface ChoiceEvent {
  type: "choice";
  prompt: string;
  options: ChoiceOption[];
}

/**
 * Terminal produced by the runtime when a DSL segment closes with
 * `@end ... ending` (handleSegmentEnd). Never emitted by the model. The
 * optional metadata comes from the model's `@ending` epilogue line:
 * 结局档位缺省 NE（现场活动按档位分发奖品），结尾词缺省时 UI 回退「剧终」。
 */
export interface EndEvent {
  type: "end";
  ending_id: string;
  text: string;
  /** @ending 行的档位：TE | HE | NE | BE；旧数据/兜底局由运行时填 NE。 */
  grade?: EndingGrade;
  /** @ending 行的结尾词（结局标题），超长已由解析层截断。 */
  title?: string;
}

export type RuntimeDialogueEvent = DialogueDraftEvent & {
  line_id: string;
  /**
   * Stable character identity for StoryState/TTS/asset binding (docs
   * llm-outputs-refactor.md §10, §62).
   */
  characterId?: string;
  /** Stage cues applied together with this line (docs §63). */
  stage?: StageCue[];
};
export type RuntimeNarrationEvent = NarrationDraftEvent & {
  line_id: string;
  /** Stage cues applied together with this line (docs §63). */
  stage?: StageCue[];
};

/**
 * The player's own spoken line, created by the runtime at input confirm.
 * Playable like dialogue, but stored with `source: "player"` and never
 * produced by the model.
 */
export interface PlayerDialogueEvent {
  type: "player_dialogue";
  /** Links back to the InteractionEvent that spawned this line. */
  interaction_id: string;
  /** Speaker label shown to the player (e.g. "你"). */
  speaker: string;
  text: string;
  line_id: string;
}

export type RuntimePlayableEvent =
  | RuntimeDialogueEvent
  | RuntimeNarrationEvent
  | PlayerDialogueEvent;

/**
 * 运行时合成的舞台 beat：DSL `@beat` 组的播放时间线影子（模型从不直接
 * 产出，也不入库）。它存在的意义是把 beat 组前奏里的舞台 cue（@bg/@bgm/
 * @ch/@se）放到播放队列里的正确位置生效——与台词行的 `stage` 载荷同一
 * 时机契约——而不是在解析完成时立即打到舞台上。
 */
export interface RuntimeBeatEvent {
  type: "beat";
  line_id: string;
  /** Stage cues carried by the beat's group prelude (docs §63). */
  stage?: StageCue[];
}

export type RuntimeModelEvent =
  | RuntimeDialogueEvent
  | RuntimeNarrationEvent
  | InteractionEvent
  | EndEvent;

/** Everything the playback buffer may hold (model stream + player lines). */
export type RuntimeBufferEvent = RuntimeModelEvent | PlayerDialogueEvent;

export interface StoredEventBase {
  seq: number;
  turn: number;
  timestamp: string;
  source: "model" | "player";
}

export type StoredModelEvent = StoredEventBase & RuntimeModelEvent;

export type StoredPlayerChoiceEvent = StoredEventBase & {
  type: "player_choice";
  choice_id: string;
  text: string;
};

export type StoredPlayerInputEvent = StoredEventBase & {
  type: "player_input";
  interaction_id: string;
  text: string;
};

export type StoredPlayerDialogueEvent = StoredEventBase & PlayerDialogueEvent;

export type StoredEvent =
  | StoredModelEvent
  | StoredPlayerChoiceEvent
  | StoredPlayerInputEvent
  | StoredPlayerDialogueEvent;

export type StoryContextEvent =
  | StoredEvent
  | RuntimeModelEvent
  | {
      type: "player_choice";
      choice_id: string;
      text: string;
    }
  | {
      type: "player_input";
      interaction_id: string;
      text: string;
    }
  | PlayerDialogueEvent;

export function isPlayableEvent(
  event: RuntimeModelEvent,
): event is RuntimeDialogueEvent | RuntimeNarrationEvent {
  return event.type === "dialogue" || event.type === "narration";
}
