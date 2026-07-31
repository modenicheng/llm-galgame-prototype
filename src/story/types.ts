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
  /**
   * Optional hint describing the player's likely intent when picking this
   * option. Used by the autocomplete system to generate continuations.
   */
  intent_hint?: string;
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
export interface InteractionEvent {
  type: "interaction";
  /** Unique identifier for this interaction point. */
  interaction_id: string;
  /** Prompt text displayed to the player. */
  prompt: string;
  /** The interaction mode. */
  mode: InteractionMode;
  /** Curated options (required for `choice` and `hybrid` modes). */
  options?: InteractionOption[];
  /** Open-ended input specification (required for `input` and `hybrid`). */
  input?: InputSpec;
}

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
 * Optional planning metadata returned by the model. This is never shown
 * to the player; it helps the runtime anticipate upcoming branches and
 * resource needs.
 */
export interface PlanningPatch {
  /** One-sentence description of the next planned scene. */
  next_scene_plan?: string;
  /** Thread identifiers the model intends to advance soon. */
  thread_hints?: string[];
  /** Per-character narrative directions. */
  character_directions?: Record<string, string>;
  /** Interaction modes the model anticipates within the next few turns. */
  anticipated_interactions?: string[];
}

/**
 * The top-level envelope returned by the LLM for each generation request.
 * Replaces the old raw-JSONL protocol.
 */
export interface GenerationEnvelope {
  /** Ordered narrative events for this segment. */
  events: GeneratedEvent[];
  /** Partial state updates the runtime applies after loading events. */
  state_patch: StoryStatePatch;
  /** Optional planning hints for the prefetch scheduler. */
  planning_notes?: PlanningPatch;
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
export type BranchSource = "choice" | "autocomplete" | "input_preview";

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
 * creates one `BranchCandidate` per choice option (or autocomplete
 * suggestion), tracks its generation lifecycle, and activates it if
 * the player selects it.
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
  /** For autocomplete branches: the text the player typed so far. */
  predicted_input?: string;
  /** For autocomplete branches: the predicted intent. */
  intent?: string;
  /** Ordered narrative events for this branch. */
  events: GeneratedEvent[];
  /** Optional state patch produced by the branch generation. */
  state_patch?: StoryStatePatch;
}

// ---------------------------------------------------------------------------
// AutocompleteResult — real-time input prediction
// ---------------------------------------------------------------------------

/**
 * A single autocomplete suggestion returned during the player's text input.
 * Multiple results may be returned for the same draft to show alternatives.
 */
export interface AutocompleteResult {
  /** Identifies the draft being completed. */
  draft_id: string;
  /** Monotonic revision number; higher means a more recent prediction. */
  revision: number;
  /** The suggested text to append to the player's input. */
  suffix: string;
  /** What the model believes the player intends to say/do. */
  intent: string;
  /** Confidence score in [0, 1]. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Zod schemas for runtime validation
// ---------------------------------------------------------------------------

export const PortraitSchema = z.object({
  character: z.string().min(1),
  expression: z.string().min(1),
  position: z.enum(["left", "center", "right"]).default("center")
});

export const DialogueDraftEventSchema = z.object({
  type: z.literal("dialogue"),
  speaker: z.string().min(1),
  text: z.string().min(1),
  portrait: PortraitSchema.nullish()
});

export const NarrationDraftEventSchema = z.object({
  type: z.literal("narration"),
  text: z.string().min(1)
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
  intent_hint: z.string().optional(),
});

export const InteractionEventSchema = z.object({
  type: z.literal("interaction"),
  interaction_id: z.string().min(1),
  prompt: z.string().min(1),
  mode: z.enum(["choice", "input", "hybrid"]),
  options: z.array(InteractionOptionSchema).min(1).optional(),
  input: InputSpecSchema.optional(),
});

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

export const PlanningPatchSchema = z.object({
  next_scene_plan: z.string().optional(),
  thread_hints: z.array(z.string()).optional(),
  character_directions: z.record(z.string(), z.string()).optional(),
  anticipated_interactions: z.array(z.string()).optional(),
});

export const GenerationEnvelopeSchema = z.object({
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
  state_patch: StoryStatePatchSchema,
  planning_notes: PlanningPatchSchema.optional(),
});

export const BranchCandidateSchema = z.object({
  id: z.string().min(1),
  interaction_id: z.string().min(1),
  source: z.enum(["choice", "autocomplete", "input_preview"]),
  status: z.enum([
    "queued",
    "generating",
    "ready",
    "selected",
    "discarded",
    "failed",
  ]),
  predicted_input: z.string().optional(),
  intent: z.string().optional(),
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

export const AutocompleteResultSchema = z.object({
  draft_id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  suffix: z.string(),
  intent: z.string(),
  confidence: z.number().min(0).max(1),
});
