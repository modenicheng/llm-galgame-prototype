import type { StageCue } from "./core/presentation/types.js";
import {
  InteractionEventSchema,
  DialogueDraftEventSchema,
  NarrationDraftEventSchema,
  PortraitSchema,
  LinePerformanceSchema,
  type InteractionEvent,
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
  CharacterDialogueEventSchema,
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

/**
 * Legacy 宽松对白读取器（C2 起 frozen）：`speaker` 是显示名，只在兼容
 * adapter/wire 过渡边界解析；新生成路径使用 `CharacterDialogueEvent`
 * （characterId + displayLabel 必填）。
 */
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

/**
 * 严格新格式对白事件（C2 强事件身份）。`characterId` 与 `displayLabel`
 * 都是必填——不允许通过把新字段设 optional 来“兼容”旧载荷；旧 `speaker`
 * 只在兼容 adapter/wire 过渡边界经 `DialogueDraftEventSchema`（宽松
 * legacy 读取器）读取。类型在 schema.ts、zod schema 在 story/types.ts。
 */
export interface CharacterDialogueEvent {
  type: "dialogue";
  /** 稳定 roster 角色 ID（机器键，不是显示名/名牌）。 */
  characterId: string;
  /** 发射时刻的名牌（initialLabel 或其后改名），用于 UI/回放显示。 */
  displayLabel: string;
  text: string;
  performance?: LinePerformance;
}

/** 新格式对白的运行时形态：附带 line_id 与同拍舞台 cue（§63）。 */
export type RuntimeCharacterDialogueEvent = CharacterDialogueEvent & {
  line_id: string;
  stage?: StageCue[];
};

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
 * `@end ... ending` (handleSegmentEnd). Never emitted by the model.
 */
export interface EndEvent {
  type: "end";
  ending_id: string;
  text: string;
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
