import { z } from "zod";
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
  InputBridge,
  InputBridgeEvent,
  ChoiceInteraction,
  InputInteraction,
  HybridInteraction,
  LinePerformance,
} from "./story/types.js";
export {
  PortraitSchema,
  DialogueDraftEventSchema,
  NarrationDraftEventSchema,
  InputBridgeEventSchema,
  InputBridgeSchema,
  LinePerformanceSchema,
} from "./story/types.js";
export { InteractionEventSchema } from "./story/types.js";
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

export interface ChoiceEvent {
  type: "choice";
  prompt: string;
  options: ChoiceOption[];
}

export interface EndEvent {
  type: "end";
  ending_id: string;
  text: string;
}

export type ModelPlayableEvent = DialogueDraftEvent | NarrationDraftEvent;
export type ModelEvent = ModelPlayableEvent | ChoiceEvent | InteractionEvent | EndEvent;

export type RuntimeDialogueEvent = DialogueDraftEvent & { line_id: string };
export type RuntimeNarrationEvent = NarrationDraftEvent & { line_id: string };

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

export type RuntimeModelEvent = RuntimeDialogueEvent | RuntimeNarrationEvent | ChoiceEvent | InteractionEvent | EndEvent;

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

export const ChoiceOptionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1)
});

export const ChoiceEventSchema = z.object({
  type: z.literal("choice"),
  prompt: z.string().min(1).default("请选择："),
  options: z.array(ChoiceOptionSchema).min(2).max(5)
});

export const EndEventSchema = z.object({
  type: z.literal("end"),
  ending_id: z.string().min(1),
  text: z.string().min(1)
});

/**
 * Optional in-band state-update line in the JSONL stream.
 *
 * The model may emit `{"type":"state_patch","patch":{...}}` at any point
 * between event lines. The runtime validates the patch and applies it after
 * the request completes (state_patch lines never enter the playback path).
 */
export const StatePatchLineSchema = z.object({
  type: z.literal("state_patch"),
  patch: StoryStatePatchSchema,
});

export interface StatePatchLine {
  type: "state_patch";
  patch: StoryStatePatch;
}

export function isStatePatchLine(value: unknown): value is StatePatchLine {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).type === "state_patch"
  );
}

export const ModelEventSchema = z.discriminatedUnion("type", [
  DialogueDraftEventSchema,
  NarrationDraftEventSchema,
  ChoiceEventSchema,
  InteractionEventSchema,
  EndEventSchema
]);

export function isPlayableEvent(
  event: RuntimeModelEvent,
): event is RuntimeDialogueEvent | RuntimeNarrationEvent {
  return event.type === "dialogue" || event.type === "narration";
}
