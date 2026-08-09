/**
 * Gal DSL protocol types — the model-facing line language
 * (docs/llm-outputs-refactor.md §4–§51).
 *
 * Layering (docs §40):
 *
 *   StreamLineDecoder → DslLineParser → EventGroupBuilder → SegmentValidator
 *
 * This module contains ONLY the shared shapes for that pipeline. The
 * implementations live in stream-decoder.ts, line-parser.ts,
 * interaction-builder.ts, group-builder.ts, segment-validator.ts and
 * compiler.ts. Nothing here touches the runtime, the wire, or the LLM.
 */
import type {
  CharacterPosition,
  StageCue,
  VisualState,
  VisualStateReducer,
  CharacterRegistry,
  CharacterPresentationState,
} from "../../presentation/types.js";
import type { AssetCatalog } from "../../assets/types.js";

export type { StageCue } from "../../presentation/types.js";

// ---------------------------------------------------------------------------
// Single parsed line (docs §42)
// ---------------------------------------------------------------------------

/** Content of the `[ ... ]` visual slot of a dialogue header (docs §8–§9, §12, §15). */
export interface DialogueVisualSpec {
  /**
   * Whether the header carried any bracket content (`[anxious]`, `[|left]`,
   * `[]`, ...). `false` for a plain `苏遥: ...`.
   */
  hasVisual: boolean;
  /**
   * `[]` → visual reset (spriteSet/variant/position → defaults, visible →
   * true). Mutually exclusive with spriteSet/variant/position.
   */
  resetVisual: boolean;
  /** Sprite-set override from `[placeholder_char:anxious]` (docs §8). */
  spriteSet?: string;
  /** Variant from `[anxious]` or `[placeholder_char:anxious]`. */
  variant?: string;
  /** Position from `[anxious|left]` / `[|left]` (docs §9). */
  position?: CharacterPosition;
}

/** Content of the `( ... )` name slot of a dialogue header (docs §10, §13). */
export interface DialogueNameSpec {
  /** Whether the header carried any paren content. */
  hasName: boolean;
  /** `()` → displayName reset to the character default. */
  resetName: boolean;
  /** Explicit display-name override, e.g. `(神秘女子)`. */
  displayName?: string;
}

export type DslLine =
  | { kind: "narration"; text: string }
  | {
      kind: "dialogue";
      speaker: string;
      text: string;
      visual: DialogueVisualSpec;
      name: DialogueNameSpec;
    }
  | { kind: "background"; assetId: string }
  | { kind: "bgm"; assetId: string }
  | { kind: "sound_effect"; assetId: string }
  /**
   * `ch <character_id>:<variant> [position]` → action "set";
   * `ch <character_id> hide|show|exit` → action "hide" | "show" | "exit"
   * (docs §17–§19; exit removes the character from the stage entirely).
   */
  | {
      kind: "character_cue";
      characterId: string;
      variant?: string;
      position?: CharacterPosition;
      action: "set" | "show" | "hide" | "exit";
    }
  | { kind: "beat" }
  | { kind: "form_start"; prompt: string }
  | { kind: "form_option"; text: string }
  | { kind: "form_input"; placeholder: string }
  | { kind: "form_end" }
  | { kind: "segment_end"; nonce: string; reason: SegmentEndReason };

// ---------------------------------------------------------------------------
// Interaction draft (docs §24–§31)
// ---------------------------------------------------------------------------

/** Interaction mode derived by the parser from the form content (docs §28). */
export type InteractionMode = "choice" | "input" | "hybrid";

/**
 * The parser-level interaction: just creative content. All machine fields
 * (interaction_id, option ids, InputSpec kind/max_length) are added by the
 * runtime compiler (docs §30–§31).
 */
export interface DslInteractionDraft {
  prompt: string;
  optionTexts: string[];
  inputPlaceholder?: string;
  mode: InteractionMode;
}

// ---------------------------------------------------------------------------
// Event groups (docs §36–§39)
// ---------------------------------------------------------------------------

export type MainEventDraft =
  | {
      type: "dialogue";
      speaker: string;
      text: string;
      /** `[...]` visual spec of the dialogue header (docs §8–§12). */
      visual: DialogueVisualSpec;
      /** `(...)` name spec of the dialogue header (docs §10, §13). */
      name: DialogueNameSpec;
    }
  | { type: "narration"; text: string }
  | { type: "interaction"; interaction: DslInteractionDraft }
  | { type: "beat" };

/**
 * An atomic playback unit: ordered stage cues followed by one main event
 * (docs §36). `prelude` includes the character patches derived from the
 * dialogue header itself (`苏遥[anxious]` → character_patch cue).
 */
export interface EventGroupDraft {
  prelude: StageCue[];
  main: MainEventDraft;
}

// ---------------------------------------------------------------------------
// Segment end sentinel (docs §44–§51)
// ---------------------------------------------------------------------------

export type SegmentEndReason = "buffer" | "interaction" | "ending";

export type SegmentEndStatus =
  | { kind: "complete"; nonce: string; reason: SegmentEndReason }
  | { kind: "incomplete" };

export interface DslSegmentResult {
  /** Fully committed groups, in order (truncated tail never enters). */
  groups: EventGroupDraft[];
  status: SegmentEndStatus;
}

// ---------------------------------------------------------------------------
// Protocol errors (docs §15, §28, §103)
// ---------------------------------------------------------------------------

export type DslErrorCode =
  | "INVALID_VISUAL_BRACKET"
  | "INVALID_NAME_PAREN"
  | "INVALID_CH_CUE"
  | "FORM_LINE_OUTSIDE_FORM"
  | "FORM_END_WITHOUT_OPEN"
  | "FORM_ALREADY_OPEN"
  | "CONTENT_INSIDE_OPEN_FORM"
  | "EMPTY_FORM"
  | "EMPTY_FORM_PROMPT"
  | "EMPTY_OPTION_TEXT"
  | "EMPTY_INPUT_PLACEHOLDER"
  | "MULTIPLE_INPUT_FIELDS"
  | "SENTINEL_NOT_LAST"
  | "SENTINEL_NONCE_MISMATCH"
  | "SENTINEL_DUPLICATE"
  | "SENTINEL_INVALID_REASON"
  | "SENTINEL_MISSING_REASON"
  | "UNKNOWN_LINE";

/**
 * A structural violation of the DSL. The message doubles as the repair
 * instruction embedded in the next user prompt (docs §8.5).
 */
export class DslProtocolError extends Error {
  readonly code: DslErrorCode;
  constructor(code: DslErrorCode, message: string) {
    super(message);
    this.name = "DslProtocolError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Compiler output (docs §36, §62, §63)
// ---------------------------------------------------------------------------

export type CompiledMainEvent =
  | { type: "dialogue"; characterId: string; speaker: string; text: string }
  | { type: "narration"; text: string }
  | { type: "interaction"; interaction: DslInteractionDraft }
  | { type: "beat" };

/** A compiled group: character keys resolved to stable ids (docs §36). */
export interface CompiledEventGroup {
  prelude: StageCue[];
  main: CompiledMainEvent;
}

/** 素材语义校验诊断码（spec §7）。 */
export type AssetDiagnosticCode =
  | "UNKNOWN_BACKGROUND"
  | "UNKNOWN_BGM"
  | "UNKNOWN_SOUND_EFFECT"
  | "UNKNOWN_SPRITE_VARIANT"
  | "FORBIDDEN_SPRITE_SET";

/**
 * One dropped-cue diagnostic: which asset kind was unknown and the id
 * the model referenced (spec §7). Recorded by the compiler when an
 * optional catalog is supplied; the cue is dropped (keep current state).
 */
export interface AssetDiagnostic {
  code: AssetDiagnosticCode;
  id: string;
}

export interface CompileEventGroupsOptions {
  registry: CharacterRegistry;
  /**
   * Visual state after everything committed BEFORE this segment — the
   * "tail state" the next generation must see (docs §54–§55).
   */
  tailState: VisualState;
  /** Pure reducer from presentation/reducer.ts (defaults injected). */
  reduce: VisualStateReducer;
  /** Character presentation defaults (usually derived from the registry). */
  defaultsFor: (characterId: string) => CharacterPresentationState | undefined;
  /**
   * Optional asset catalog enabling semantic validation of prelude cues
   * (spec §7). When present, cues referencing unknown asset ids / sprite
   * variants are dropped (graceful degradation) instead of played; when
   * absent, cues pass through verbatim (backward compatible).
   */
  catalog?: AssetCatalog;
  /**
   * Optional collector for dropped-cue diagnostics (spec §7). Only
   * populated when `catalog` is supplied.
   */
  diagnostics?: AssetDiagnostic[];
}

export interface CompileEventGroupsResult {
  groups: CompiledEventGroup[];
  /** Visual state after all groups applied — the new tail state. */
  tailState: VisualState;
}
