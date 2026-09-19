import type {
  CharacterRegistry,
  PresentationDefaults,
  VisualState,
} from "./types.js";
import type {
  CharacterDefinition,
  CharacterRegistry as RosterCharacterRegistry,
  CharacterRuntimeState,
} from "../characters/types.js";
import { resolveCharacterLabel } from "../characters/types.js";

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
 * internal character character id or the script name, so both cue shapes work.
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

// ---------------------------------------------------------------------------
// v2（C4）：从 C2 CharacterRoster（src/core/characters）派生的 presentation
// 缺省——身份真源是 roster；legacy scriptName 注册表不再参与 v2 语义。
// ---------------------------------------------------------------------------

/** v2 双状态域：VisualState（舞台）+ CharacterRuntimeState（名牌）的只读对。 */
export interface V2StageState {
  visualState: VisualState;
  characterState: CharacterRuntimeState;
}

/**
 * v2 组装的缺省 provider：presentation 缺省从 roster 的 defaultLook 派生
 * （spriteSet/variant = looks[defaultLook]，position = defaultPosition，
 * displayName = 当前名牌快照——由 compiler 在首次登台时写入，provider
 * 兜底用 initialLabel）；无 presentation 的角色没有缺省（返回 undefined，
 * reducer 对其 cue no-op——v2 compiler 本就不会为无立绘角色生成 cue）。
 */
export function createPresentationDefaultsFromRoster(
  registry: RosterCharacterRegistry,
): PresentationDefaults {
  return {
    defaultFor(characterId: string) {
      const definition = registry.get(characterId);
      return presentationDefaultsFor(definition, undefined);
    },
  };
}

/** 单角色 presentation 缺省（displayName 优先用当时名牌快照）。 */
export function presentationDefaultsFor(
  definition: CharacterDefinition | undefined,
  labelState: CharacterRuntimeState | undefined,
): ReturnType<PresentationDefaults["defaultFor"]> {
  if (definition === undefined || definition.presentation === undefined) {
    return undefined;
  }
  const look = definition.presentation.looks[definition.presentation.defaultLook];
  if (look === undefined) {
    // roster 校验保证 defaultLook ∈ looks；这里只是防御（不伪造 sprite）。
    return undefined;
  }
  return {
    spriteSet: look.spriteSet,
    variant: look.variant,
    position: definition.presentation.defaultPosition,
    displayName: resolveCharacterLabel(labelState, definition),
    visible: true,
  };
}
