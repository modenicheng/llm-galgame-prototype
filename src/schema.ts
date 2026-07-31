import { z } from "zod";
import {
  InteractionEventSchema as BaseInteractionEventSchema,
  DialogueDraftEventSchema,
  NarrationDraftEventSchema,
  PortraitSchema,
  StoryStatePatchSchema,
  type InteractionEvent,
  type StoryStatePatch,
} from "./story/types.js";

// Re-export for convenience
export type { InteractionEvent } from "./story/types.js";
export {
  PortraitSchema,
  DialogueDraftEventSchema,
  NarrationDraftEventSchema,
} from "./story/types.js";

export const InteractionEventSchema = BaseInteractionEventSchema.refine(
  (data) => {
    if (
      (data.mode === "choice" || data.mode === "hybrid") &&
      (!data.options || data.options.length === 0)
    ) {
      return false;
    }
    if (
      (data.mode === "input" || data.mode === "hybrid") &&
      !data.input
    ) {
      return false;
    }
    return true;
  },
  {
    message:
      "choice/hybrid 模式需要 options 数组，input/hybrid 模式需要 input 字段",
  }
);

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
}

export interface NarrationDraftEvent {
  type: "narration";
  text: string;
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
export type RuntimePlayableEvent = RuntimeDialogueEvent | RuntimeNarrationEvent;
export type RuntimeModelEvent = RuntimePlayableEvent | ChoiceEvent | InteractionEvent | EndEvent;

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

export type StoredEvent = StoredModelEvent | StoredPlayerChoiceEvent | StoredPlayerInputEvent;

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
    };

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

export function isPlayableEvent(event: RuntimeModelEvent): event is RuntimePlayableEvent {
  return event.type === "dialogue" || event.type === "narration";
}
