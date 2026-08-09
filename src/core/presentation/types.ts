/**
 * Presentation domain types — the shared vocabulary between the Gal DSL
 * parser, the visual state reducer, the asset catalog, and the stage
 * renderer (docs/llm-outputs-refactor.md §11–§19, §52–§56, §58).
 *
 * This module is pure data + pure types. It never touches the DOM, the
 * filesystem, audio playback, or the LLM.
 */

// ---------------------------------------------------------------------------
// Stage cues
// ---------------------------------------------------------------------------

/** Discrete character slots (docs §9). Renderer owns pixel coordinates. */
export type CharacterPosition =
  | "far_left"
  | "left"
  | "center"
  | "right"
  | "far_right";

/**
 * KEEP / SET / RESET semantics for presentation fields (docs §11).
 *
 * - omitted            → KEEP
 * - explicit value     → SET
 * - explicit empty     → RESET (back to character defaults)
 */
export type PatchValue<T> =
  | { op: "keep" }
  | { op: "set"; value: T }
  | { op: "reset" };

/**
 * A character presentation patch (docs §11–§19).
 *
 * `character` is the character KEY: the script name as written by the
 * model in a dialogue header (`苏遥[...]`) or the internal character id
 * in a `ch` cue. The compiler resolves it to the stable `characterId`
 * via the CharacterRegistry and rewrites this field in place.
 */
export interface CharacterPatchCue {
  type: "character_patch";
  character: string;
  spriteSet?: PatchValue<string>;
  variant?: PatchValue<string>;
  position?: PatchValue<CharacterPosition>;
  visible?: PatchValue<boolean>;
  displayName?: PatchValue<string>;
  /**
   * Exit the stage entirely: removes the character from VisualState (the
   * renderer drops its DOM node; a later line first-touches them again at
   * defaults). Mutually exclusive with the patch fields above (§19).
   */
  exit?: boolean;
}

/**
 * One stage command. A group's prelude is an ordered list of these; the
 * reducer applies them to the VisualState. `sound_effect` is one-shot and
 * leaves no residue in VisualState.
 */
export type StageCue =
  | { type: "background"; assetId: string }
  | { type: "bgm"; assetId: string }
  | { type: "sound_effect"; assetId: string }
  | CharacterPatchCue;

// ---------------------------------------------------------------------------
// Visual state
// ---------------------------------------------------------------------------

/** Persistent per-character presentation (docs §52). */
export interface CharacterPresentationState {
  spriteSet: string;
  variant: string;
  position: CharacterPosition;
  displayName: string;
  visible: boolean;
}

/**
 * The authoritative visual state: what is (or will be) on stage
 * (docs §52). `background` / `bgm` are logical asset ids; the renderer
 * resolves them to URLs via the asset catalog.
 */
export interface VisualState {
  background?: string;
  bgm?: string;
  characters: Record<string, CharacterPresentationState>;
}

/** Pure state transition: (state, cues) → next state (docs §53). */
export type VisualStateReducer = (state: VisualState, cues: StageCue[]) => VisualState;

// ---------------------------------------------------------------------------
// Character registry — script name → internal identity + presentation defaults
// ---------------------------------------------------------------------------

/**
 * One character's binding (docs §7, §10, §58). The registry is the single
 * source of truth for script_name → characterId mapping and for the
 * presentation defaults used by RESET and by first-touch initialization.
 */
export interface CharacterRegistryEntry {
  /** Stable internal id (e.g. "suyao"). Used by StoryState, TTS, assets. */
  characterId: string;
  /** The name the model writes in dialogue headers (e.g. "苏遥"). */
  scriptName: string;
  /** Default name shown in the UI (e.g. "苏遥" — overridable via `()`). */
  displayName: string;
  /** Default sprite set id (e.g. "suyao"). */
  spriteSet: string;
  /** Default variant id (e.g. "normal"). */
  defaultVariant: string;
  /** Default slot (e.g. "left"). */
  defaultPosition: CharacterPosition;
  /**
   * Sprite sets the character may use (docs §15): the compiler drops any
   * `[spriteSet:variant]` patch outside this list. Defaults to [spriteSet].
   */
  allowedSpriteSets: string[];
}

export interface CharacterRegistry {
  /** Resolve a dialogue-header script name to a character entry. */
  resolveByScriptName(scriptName: string): CharacterRegistryEntry | undefined;
  /** Resolve an internal id (or script name) to a character entry. */
  resolveById(id: string): CharacterRegistryEntry | undefined;
  /** All registered entries. */
  entries(): CharacterRegistryEntry[];
}

/** Defaults provider used by the reducer for RESET and first-touch init. */
export interface PresentationDefaults {
  defaultFor(characterId: string): CharacterPresentationState | undefined;
}
