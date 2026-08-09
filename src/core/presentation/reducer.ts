import type {
  CharacterPatchCue,
  CharacterPresentationState,
  PresentationDefaults,
  StageCue,
  VisualState,
  VisualStateReducer,
} from "./types.js";

/**
 * Factory for the pure visual-state reducer (docs §53).
 *
 * The returned function applies a list of stage cues to a VisualState and
 * returns the next state. It never mutates its inputs and never touches
 * the DOM, the filesystem, or audio playback — it only computes state.
 *
 * Cue semantics:
 * - `background`   → set `background` (logical asset id).
 * - `bgm`          → set `bgm`, or clear it when the id is "stop" (§21).
 * - `sound_effect` → one-shot; leaves no residue in VisualState.
 * - `character_patch` → KEEP/SET/RESET per present field (§11–§14).
 *   A patch for a character with no entry on stage and no defaults entry
 *   is a NO-OP (unknown character, no art).
 */
export function createVisualStateReducer(
  defaults: PresentationDefaults,
): VisualStateReducer {
  return (state, cues) => {
    let next: VisualState = state;
    // Lazily-created copy of the characters map; keeps the common
    // "cues only touch background/bgm" path allocation-free while
    // guaranteeing the input state is never mutated.
    let characters: Record<string, CharacterPresentationState> | undefined;

    for (const cue of cues) {
      switch (cue.type) {
        case "background": {
          next = { ...next, background: cue.assetId };
          break;
        }
        case "bgm": {
          if (cue.assetId === "stop") {
            const cleared: VisualState = { ...next };
            delete cleared.bgm;
            next = cleared;
          } else {
            next = { ...next, bgm: cue.assetId };
          }
          break;
        }
        case "sound_effect": {
          // One-shot; no persistent visual state.
          break;
        }
        case "character_patch": {
          const working = characters ?? state.characters;
          // Exit: remove the character from the stage entirely. The entry
          // is gone — a later line first-touches them again at defaults.
          if (cue.exit) {
            if (Object.hasOwn(working, cue.character)) {
              if (!characters) {
                characters = { ...state.characters };
              }
              delete characters[cue.character];
            }
            break;
          }
          const existing = working[cue.character];
          const entryDefaults = defaults.defaultFor(cue.character);
          if (!existing && !entryDefaults) {
            // Unknown character with no art — cue is a NO-OP.
            break;
          }
          if (!characters) {
            characters = { ...state.characters };
          }
          const entry: CharacterPresentationState = existing
            ? { ...existing }
            : { ...entryDefaults! };
          applyPatch(entry, cue, entryDefaults);
          characters[cue.character] = entry;
          // Stage occupancy (§19): one slot, one character. When a
          // character ends up VISIBLE at a position, every other visible
          // character at that position is hidden — the engine enforces the
          // slot instead of relying on the model to remember `hide`. The
          // evicted character keeps its state (a `show` or explicit
          // placement brings them back).
          if (entry.visible && entry.position) {
            for (const [otherId, otherEntry] of Object.entries(characters)) {
              if (
                otherId !== cue.character &&
                otherEntry.visible &&
                otherEntry.position === entry.position
              ) {
                characters[otherId] = { ...otherEntry, visible: false };
              }
            }
          }
          break;
        }
      }
    }

    if (characters) {
      next = { ...next, characters };
    }
    return next;
  };
}

/**
 * Apply the present fields of a character patch to a working copy of the
 * entry. Absent fields (and `{op:"keep"}`) are preserved untouched.
 *
 * RESET restores the field to the character's defaults; when no defaults
 * entry exists (possible only for a pre-existing on-stage entry), the
 * current value is kept — except `visible`, which always resets to true.
 */
function applyPatch(
  entry: CharacterPresentationState,
  cue: CharacterPatchCue,
  entryDefaults: CharacterPresentationState | undefined,
): void {
  if (cue.spriteSet) {
    if (cue.spriteSet.op === "set") {
      entry.spriteSet = cue.spriteSet.value;
    } else if (cue.spriteSet.op === "reset" && entryDefaults) {
      entry.spriteSet = entryDefaults.spriteSet;
    }
  }
  if (cue.variant) {
    if (cue.variant.op === "set") {
      entry.variant = cue.variant.value;
    } else if (cue.variant.op === "reset" && entryDefaults) {
      entry.variant = entryDefaults.variant;
    }
  }
  if (cue.position) {
    if (cue.position.op === "set") {
      entry.position = cue.position.value;
    } else if (cue.position.op === "reset" && entryDefaults) {
      entry.position = entryDefaults.position;
    }
  }
  if (cue.visible) {
    if (cue.visible.op === "set") {
      entry.visible = cue.visible.value;
    } else if (cue.visible.op === "reset") {
      entry.visible = true;
    }
  }
  if (cue.displayName) {
    if (cue.displayName.op === "set") {
      entry.displayName = cue.displayName.value;
    } else if (cue.displayName.op === "reset" && entryDefaults) {
      entry.displayName = entryDefaults.displayName;
    }
  }
}
