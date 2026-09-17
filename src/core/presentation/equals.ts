/**
 * Structural equality for VisualState (docs/llm-outputs-refactor.md §53).
 *
 * Pure data comparison — used by the event-group compiler to detect
 * redundant stage cues (a cue that leaves the visual state unchanged is
 * dropped instead of played) and by tests. Field-by-field on purpose: the
 * states are small, and object identity must NOT be the comparison (the
 * reducer clones on every write).
 */
import type {
  CharacterPresentationState,
  VisualState,
} from "./types.js";

function characterEquals(a: CharacterPresentationState, b: CharacterPresentationState): boolean {
  return (
    a.spriteSet === b.spriteSet &&
    a.variant === b.variant &&
    a.position === b.position &&
    a.displayName === b.displayName &&
    a.visible === b.visible
  );
}

/** True when both states describe exactly the same stage picture. */
export function visualStateEquals(a: VisualState, b: VisualState): boolean {
  if (a.background !== b.background || a.bgm !== b.bgm) return false;

  const aIds = Object.keys(a.characters);
  const bIds = Object.keys(b.characters);
  if (aIds.length !== bIds.length) return false;

  for (const id of aIds) {
    const aEntry = a.characters[id];
    const bEntry = b.characters[id];
    if (aEntry === undefined || bEntry === undefined) return false;
    if (!characterEquals(aEntry, bEntry)) return false;
  }
  return true;
}
