import type {
  CharacterRegistry,
  PresentationDefaults,
  VisualState,
} from "./types.js";

/**
 * The empty visual state: no background, no bgm, no characters on stage.
 * The reducer and the runtime both start from this (docs §52).
 */
export function createInitialVisualState(): VisualState {
  return { characters: {} };
}

/**
 * Build the defaults provider used by the reducer for first-touch
 * initialization and RESET, from a character registry (docs §7, §11–§14).
 *
 * `defaultFor` resolves via `resolveById`, which accepts either the
 * internal character id or the script name, so both cue shapes work.
 */
export function createDefaultsFromRegistry(
  registry: CharacterRegistry,
): PresentationDefaults {
  return {
    defaultFor(characterId: string) {
      const entry = registry.resolveById(characterId);
      if (!entry) {
        return undefined;
      }
      return {
        spriteSet: entry.spriteSet,
        variant: entry.defaultVariant,
        position: entry.defaultPosition,
        displayName: entry.displayName,
        visible: true,
      };
    },
  };
}
