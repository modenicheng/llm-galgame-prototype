/**
 * Core protocol types for the LLM-driven GalGame story engine.
 *
 * These types define the new generation protocol where the model returns a
 * GenerationEnvelope containing both narrative events and a state patch,
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
import {
  CharacterIdSchema,
  CharacterLabelSchema,
} from "../core/characters/types.js";
import type {
  AnyStreamedGroup,
  SegmentEndStatus,
} from "../core/protocol/gal-dsl/types.js";

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
 * Includes `ChoiceEvent` for the branch-prefetch draft shape.
 */
export type GeneratedEvent =
  | DialogueDraftEvent
  | NarrationDraftEvent
  | InteractionEvent
  | EndEvent
  | ChoiceEvent;

/**
 * The top-level result of a generation request: ordered events plus the
 * DSL segment end status. state_patch 已随 §80–§81 删除（StoryState 由
 * reconcile 确定性投影，MA-A2 清除残留契约）。
 */
export interface GenerationEnvelope {
  /** Ordered narrative events for this segment. */
  events: GeneratedEvent[];
  /**
   * DSL mode: fully committed groups, in order (docs §36). v1 会话是
   * EventGroupDraft（解析级草稿）；v2 会话是 CompiledEventGroupV2
   * （compileSegmentV2 语义编译后的组，见 AnyStreamedGroup）。
   */
  groups?: AnyStreamedGroup[];
  /** DSL mode: segment end status (docs §44–§51). */
  segmentEnd?: SegmentEndStatus;
}

// ---------------------------------------------------------------------------
// StoryState — simplified in-memory story memory
// ---------------------------------------------------------------------------

/** Per-character mutable state. */
export interface CharacterState {
  location?: string;
}

/**
 * 确定性投影产物（设计 §3.2）：location ← background cue，characters ←
 * 台词/character_patch cue，recent_summary ← 最近 ≤3 条文本。rich 字段
 * （canon/open_threads/player_profile/角色 emotion 等）自 state_patch 应用
 * 路径删除后无写入者，已随 MA-A2 清除；语义记录由记忆子层 facts 承载。
 */
export interface StoryState {
  scene: {
    id: string;
    location: string;
    time?: string;
    purpose: string;
  };
  /** Mutable character state keyed by character identifier. */
  characters: Record<string, CharacterState>;
  /** 1–3 sentence summary of the most recent events. */
  recent_summary: string;
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
    | "serious"
    | "surprised"
    | "disgusted";
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
  emotion: z.enum(["neutral","happy","sad","angry","anxious","afraid","excited","tired","sarcastic","tender","serious","surprised","disgusted"]).optional(),
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

// ---------------------------------------------------------------------------
// C2 强事件身份：严格新事件 schema vs 宽松 legacy 读取器
// ---------------------------------------------------------------------------

/**
 * 严格新格式对白事件（C2）：`characterId` 必填（稳定 roster ID，不是显示
 * 名），`displayLabel` 必填（发射时刻的名牌）。旧 `speaker` 字段不在此
 * schema 中——strict 对象会拒绝混写；它只经上方 `DialogueDraftEventSchema`
 * （宽松 legacy 读取器）在兼容/wire 过渡边界读取。不做“新字段 optional
 * 式兼容”：缺 characterId 的新格式对白一律非法。
 */
export const CharacterDialogueEventSchema = z.strictObject({
  type: z.literal("dialogue"),
  characterId: CharacterIdSchema,
  displayLabel: CharacterLabelSchema,
  text: z.string().min(1),
  // §14.5：非法 performance 丢弃（catch → undefined），台词正文保留。
  performance: LinePerformanceSchema.catch(undefined as never).optional(),
});

const InputSpecSchema = z.object({
  kind: z.enum([
    "free_text",
    "guided_text",
    "question",
    "action",
    "short_answer",
  ]),
  placeholder: z.string().trim().min(1),
  max_length: z.number().int().min(1).max(2000),
});

const InteractionOptionSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
});

/**
 * §6.3: option ids within one interaction must be unique (case-sensitive).
 * Shared by choice and hybrid schemas.
 */
function validateUniqueOptionIds(
  value: { options: Array<{ id: string }> },
  ctx: z.RefinementCtx,
): void {
  const ids = new Set<string>();

  value.options.forEach((option, index) => {
    if (ids.has(option.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", index, "id"],
        message: `选项 id 重复：${option.id}`,
      });
    }

    ids.add(option.id);
  });
}

const ChoiceInteractionSchema = z
  .strictObject({
    type: z.literal("interaction"),
    interaction_id: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    mode: z.literal("choice"),
    options: z.array(InteractionOptionSchema).min(2).max(5),
  })
  .superRefine(validateUniqueOptionIds);

const InputInteractionSchema = z.strictObject({
  type: z.literal("interaction"),
  interaction_id: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  mode: z.literal("input"),
  input: InputSpecSchema,
});

const HybridInteractionSchema = z
  .strictObject({
    type: z.literal("interaction"),
    interaction_id: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    mode: z.literal("hybrid"),
    options: z.array(InteractionOptionSchema).min(2).max(5),
    input: InputSpecSchema,
  })
  .superRefine(validateUniqueOptionIds);

export const InteractionEventSchema = z.discriminatedUnion("mode", [
  ChoiceInteractionSchema,
  InputInteractionSchema,
  HybridInteractionSchema,
]);

// exactOptional：接口可选字段在 exactOptionalPropertyTypes 下不含 undefined
// （M0 契约审查确立的 zod 惯例；此 schema 嵌入 v2 图契约的入口快照）。
const CharacterStateSchema = z.object({
  location: z.exactOptional(z.string()),
});

export const StoryStateSchema = z.object({
  scene: z.object({
    id: z.string().min(1),
    location: z.string().min(1),
    // exactOptional：StoryState 接口在 exactOptionalPropertyTypes 下要求
    // 可选字段不含 undefined（M0 契约审查确立的 zod 惯例）。
    time: z.exactOptional(z.string()),
    purpose: z.string().min(1),
  }),
  characters: z.record(z.string(), CharacterStateSchema),
  recent_summary: z.string(),
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
});
