import type { StageCue } from "./core/presentation/types.js";
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
