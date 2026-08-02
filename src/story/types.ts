/**
 * Core protocol types for the LLM-driven GalGame story engine.
 *
 * These types define the new generation protocol where the model returns a
 * GenerationEnvelope containing both narrative events and a state patch,
 * rather than raw JSONL. InteractionEvents replace standalone choice/end
 * as the terminal event type, and BranchCandidate formalizes the prefetch
 * branch transaction model.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Re-export existing types from schema.ts for compatibility
// ---------------------------------------------------------------------------

export type {
  DialogueDraftEvent,
  NarrationDraftEvent,
  Portrait,
  ChoiceOption,
  EndEvent,
} from "../schema.js";

import type {
  ChoiceEvent,
  DialogueDraftEvent,
  NarrationDraftEvent,
  EndEvent,
} from "../schema.js";

// ---------------------------------------------------------------------------
// InteractionEvent — replaces standalone choice/end as the terminal event
// ---------------------------------------------------------------------------

/**
 * Determines how the player interacts at a decision point.
 *
 * - `"choice"`:     traditional multiple-choice selection.
 * - `"input"`:      free-form text input (typing, voice, etc.).
 * - `"hybrid"`:     both a curated choice list and a free-text fallback.
 */
export type InteractionMode = "choice" | "input" | "hybrid";

/** A single option presented to the player in a choice-style interaction. */
export interface InteractionOption {
  /** Stable identifier used to track branch selection. */
  id: string;
  /** Display text shown to the player. */
  text: string;
}

/**
 * Describes the shape of an open-ended text input prompt.
 *
 * `kind` values:
 * - `"free_text"`:   unrestricted text entry.
 * - `"guided_text"`: text with a suggested format or template.
 * - `"question"`:    a direct question expecting a sentence or two.
 * - `"action"`:      an imperative verb-phrase (e.g. "open the door").
 * - `"short_answer"`: constrained answer, typically 1–3 words.
 */
export interface InputSpec {
  kind: "free_text" | "guided_text" | "question" | "action" | "short_answer";
  /** Placeholder text shown in the input field. */
  placeholder: string;
  /** Maximum allowed characters for the input. */
  max_length: number;
}

/**
 * A decision point in the story. The model emits this as the final event
 * in a generation segment. Unlike the old `choice`/`end` events, this
 * unifies both branching and text-input interactions under one type.
 */

/** A bridge event is always narration — never dialogue, never state. */
export type InputBridgeEvent = NarrationDraftEvent;

/**
 * 1–2 narration lines bundled with an input/hybrid interaction.
 *
 * The runtime plays them after the player confirms their input and before
 * the NPC response arrives: they set the scene without answering the
 * input, introducing facts, changing state, or creating a new interaction.
 */
export interface InputBridge {
  events: InputBridgeEvent[];
}

export interface ChoiceInteraction {
  type: "interaction";
  /** Unique identifier for this interaction point. */
  interaction_id: string;
  /** Prompt text displayed to the player. */
  prompt: string;
  mode: "choice";
  /** Curated options. */
  options: InteractionOption[];
}

export interface InputInteraction {
  type: "interaction";
  /** Unique identifier for this interaction point. */
  interaction_id: string;
  /** Prompt text displayed to the player. */
  prompt: string;
  mode: "input";
  /** Open-ended input specification. */
  input: InputSpec;
  /** Scene-aware lead-in narration played after the player confirms. */
  input_bridge: InputBridge;
}

export interface HybridInteraction {
  type: "interaction";
  /** Unique identifier for this interaction point. */
  interaction_id: string;
  /** Prompt text displayed to the player. */
  prompt: string;
  mode: "hybrid";
  /** Curated options. */
  options: InteractionOption[];
  /** Open-ended input specification. */
  input: InputSpec;
  /** Scene-aware lead-in narration; discarded when a preset option is chosen. */
  input_bridge: InputBridge;
}

export type InteractionEvent =
  | ChoiceInteraction
  | InputInteraction
  | HybridInteraction;

// ---------------------------------------------------------------------------
// GenerationEnvelope — the model's structured return format
// ---------------------------------------------------------------------------

/**
 * All event types the model may produce within a generation segment.
 * Excludes runtime-only fields like `line_id`.
 *
 * Includes `ChoiceEvent` for backward compatibility with the legacy
 * JSONL format. New code should prefer `InteractionEvent` with
 * `mode: "choice"` instead.
 */
export type GeneratedEvent =
  | DialogueDraftEvent
  | NarrationDraftEvent
  | InteractionEvent
  | EndEvent
  | ChoiceEvent;

/**
 * A state patch that the model returns alongside events. All fields are
 * optional; the runtime merges only the keys the model explicitly provides.
 */
export interface StoryStatePatch {
  scene?: Partial<{
    id: string;
    location: string;
    time?: string;
    purpose: string;
  }>;
  /** Key-value metadata about the world state. */
  canon?: Record<string, unknown>;
  /** Per-character updates. Keys are character identifiers. */
  characters?: Record<
    string,
    Partial<{
      location?: string;
      emotion?: string;
      current_goal?: string;
      relationship_to_player?: string;
      known_facts?: string[];
    }>
  >;
  /** New or updated narrative threads. Merged by `id`. */
  open_threads?: Array<{
    id: string;
    summary: string;
    status: "new" | "active" | "ready" | "resolved" | "abandoned";
    last_touched_turn: number;
  }>;
  /** A concise 1–3 sentence summary of recent events. */
  recent_summary?: string;
  player_profile?: Partial<{
    recent_tendencies: string[];
  }>;
}

/**
 * The top-level result of a generation request: ordered events plus the
 * merged state updates collected from in-band state_patch lines.
 */
export interface GenerationEnvelope {
  /** Ordered narrative events for this segment. */
  events: GeneratedEvent[];
  /** Partial state updates the runtime applies after loading events. */
  state_patch: StoryStatePatch;
}

// ---------------------------------------------------------------------------
// StoryState — simplified in-memory story memory
// ---------------------------------------------------------------------------

/** A single narrative thread tracked across turns. */
export interface StoryThread {
  id: string;
  summary: string;
  status: "new" | "active" | "ready" | "resolved" | "abandoned";
  last_touched_turn: number;
}

/** Per-character mutable state. */
export interface CharacterState {
  location?: string;
  emotion?: string;
  current_goal?: string;
  relationship_to_player?: string;
  known_facts?: string[];
}

/**
 * Compressed story memory that supplements the sliding window of recent
 * events. The model reads and writes this via `StoryStatePatch` in each
 * `GenerationEnvelope`.
 */
export interface StoryState {
  scene: {
    id: string;
    location: string;
    time?: string;
    purpose: string;
  };
  /** Arbitrary world facts (inventory, flags, relationships, etc.). */
  canon: Record<string, unknown>;
  /** Mutable character state keyed by character identifier. */
  characters: Record<string, CharacterState>;
  /** Narrative threads currently tracked. */
  open_threads: StoryThread[];
  /** 1–3 sentence summary of the most recent events. */
  recent_summary: string;
  /** Lightweight player behaviour profile. */
  player_profile: {
    recent_tendencies: string[];
  };
}

// ---------------------------------------------------------------------------
// BranchCandidate — formal branch transaction
// ---------------------------------------------------------------------------

/** Where the branch originated. */
export type BranchSource = "choice" | "input_preview";

/** Lifecycle status of a branch candidate. */
export type BranchStatus =
  | "queued"
  | "generating"
  | "ready"
  | "selected"
  | "discarded"
  | "failed";

/**
 * A formal transaction representing one speculative branch. The runtime
 * creates one `BranchCandidate` per choice option, tracks its generation
 * lifecycle, and activates it if the player selects it.
 */
export interface BranchCandidate {
  /** Unique branch identifier. */
  id: string;
  /** Links back to the InteractionEvent that spawned this branch. */
  interaction_id: string;
  /** How this branch was triggered. */
  source: BranchSource;
  /** Current lifecycle status. */
  status: BranchStatus;
  /** Ordered narrative events for this branch. */
  events: GeneratedEvent[];
  /** Optional state patch produced by the branch generation. */
  state_patch?: StoryStatePatch;
}

// ---------------------------------------------------------------------------
// Zod schemas for runtime validation
// ---------------------------------------------------------------------------

/**
 * Restricted performance intent the LLM may attach to a playable line
 * (V2 §14.3). Optional and bounded; invalid values are dropped by the
 * schema while the line body survives (§14.5). Mirrors the identical
 * interface in src/application/audio/performance-compiler.ts — keep the
 * two shapes in sync (the compiler maps intent → provider parameters).
 */
export interface LinePerformance {
  emotion?:
    | "neutral"
    | "happy"
    | "sad"
    | "angry"
    | "anxious"
    | "afraid"
    | "excited"
    | "tired"
    | "sarcastic"
    | "tender"
    | "serious";
  intensity?: 0 | 1 | 2 | 3;
  pace?: "very_slow" | "slow" | "normal" | "fast" | "very_fast";
  energy?: "very_low" | "low" | "normal" | "high" | "very_high";
  volume?: "whisper" | "soft" | "normal" | "loud";
  delivery?: Array<
    | "restrained"
    | "hesitant"
    | "firm"
    | "gentle"
    | "cold"
    | "playful"
    | "breathless"
    | "tearful"
  >;
  pause_before_ms?: number;
  pause_after_ms?: number;
}

export const LinePerformanceSchema = z.object({
  emotion: z.enum(["neutral","happy","sad","angry","anxious","afraid","excited","tired","sarcastic","tender","serious"]).optional(),
  intensity: z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3)]).optional(),
  pace: z.enum(["very_slow","slow","normal","fast","very_fast"]).optional(),
  energy: z.enum(["very_low","low","normal","high","very_high"]).optional(),
  volume: z.enum(["whisper","soft","normal","loud"]).optional(),
  delivery: z.array(z.enum(["restrained","hesitant","firm","gentle","cold","playful","breathless","tearful"])).optional(),
  pause_before_ms: z.number().int().min(0).max(30000).optional(),
  pause_after_ms: z.number().int().min(0).max(30000).optional(),
});

export const PortraitSchema = z.object({
  character: z.string().min(1),
  expression: z.string().min(1),
  position: z.enum(["left", "center", "right"]).default("center")
});

export const DialogueDraftEventSchema = z.object({
  type: z.literal("dialogue"),
  speaker: z.string().min(1),
  text: z.string().min(1),
  portrait: PortraitSchema.nullish(),
  // §14.5: an invalid performance is DROPPED (catch → undefined) while the
  // line body survives. `as never` satisfies zod 4's catch-typing without
  // changing the runtime fallback value.
  performance: LinePerformanceSchema.catch(undefined as never).optional(),
});

export const NarrationDraftEventSchema = z.object({
  type: z.literal("narration"),
  text: z.string().min(1),
  performance: LinePerformanceSchema.catch(undefined as never).optional(),
});

/** Bridge events are plain narration lines, 1–2 per interaction. */
export const InputBridgeEventSchema = NarrationDraftEventSchema;

export const InputBridgeSchema = z.object({
  events: z.array(InputBridgeEventSchema).min(1).max(2),
});

const InputSpecSchema = z.object({
  kind: z.enum([
    "free_text",
    "guided_text",
    "question",
    "action",
    "short_answer",
  ]),
  placeholder: z.string().min(1),
  max_length: z.number().int().positive(),
});

const InteractionOptionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

const ChoiceInteractionSchema = z.object({
  type: z.literal("interaction"),
  interaction_id: z.string().min(1),
  prompt: z.string().min(1),
  mode: z.literal("choice"),
  options: z.array(InteractionOptionSchema).min(1),
});

const InputInteractionSchema = z.object({
  type: z.literal("interaction"),
  interaction_id: z.string().min(1),
  prompt: z.string().min(1),
  mode: z.literal("input"),
  input: InputSpecSchema,
  input_bridge: InputBridgeSchema,
});

const HybridInteractionSchema = z.object({
  type: z.literal("interaction"),
  interaction_id: z.string().min(1),
  prompt: z.string().min(1),
  mode: z.literal("hybrid"),
  options: z.array(InteractionOptionSchema).min(1),
  input: InputSpecSchema,
  input_bridge: InputBridgeSchema,
});

export const InteractionEventSchema = z.discriminatedUnion("mode", [
  ChoiceInteractionSchema,
  InputInteractionSchema,
  HybridInteractionSchema,
]);

const StoryThreadSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  status: z.enum(["new", "active", "ready", "resolved", "abandoned"]),
  last_touched_turn: z.number().int().nonnegative(),
});

const CharacterStateSchema = z.object({
  location: z.string().optional(),
  emotion: z.string().optional(),
  current_goal: z.string().optional(),
  relationship_to_player: z.string().optional(),
  known_facts: z.array(z.string()).optional(),
});

export const StoryStateSchema = z.object({
  scene: z.object({
    id: z.string().min(1),
    location: z.string().min(1),
    time: z.string().optional(),
    purpose: z.string().min(1),
  }),
  canon: z.record(z.string(), z.unknown()),
  characters: z.record(z.string(), CharacterStateSchema),
  open_threads: z.array(StoryThreadSchema),
  recent_summary: z.string(),
  player_profile: z.object({
    recent_tendencies: z.array(z.string()),
  }),
});

export const StoryStatePatchSchema = z.object({
  scene: z
    .object({
      id: z.string().min(1).optional(),
      location: z.string().min(1).optional(),
      time: z.string().optional(),
      purpose: z.string().min(1).optional(),
    })
    .optional(),
  canon: z.record(z.string(), z.unknown()).optional(),
  characters: z
    .record(z.string(), CharacterStateSchema.partial())
    .optional(),
  open_threads: z.array(StoryThreadSchema).optional(),
  recent_summary: z.string().optional(),
  player_profile: z
    .object({
      recent_tendencies: z.array(z.string()).optional(),
    })
    .optional(),
});

export const BranchCandidateSchema = z.object({
  id: z.string().min(1),
  interaction_id: z.string().min(1),
  source: z.enum(["choice", "input_preview"]),
  status: z.enum([
    "queued",
    "generating",
    "ready",
    "selected",
    "discarded",
    "failed",
  ]),
  events: z.array(
    z.discriminatedUnion("type", [
      DialogueDraftEventSchema,
      NarrationDraftEventSchema,
      InteractionEventSchema,
      z.object({
        type: z.literal("end"),
        ending_id: z.string().min(1),
        text: z.string().min(1),
      }),
      // Legacy choice event for backward compatibility
      z.object({
        type: z.literal("choice"),
        prompt: z.string().min(1),
        options: z.array(
          z.object({
            id: z.string().min(1),
            text: z.string().min(1),
          }),
        ).min(2).max(5),
      }),
    ])
  ),
  state_patch: StoryStatePatchSchema.optional(),
});
