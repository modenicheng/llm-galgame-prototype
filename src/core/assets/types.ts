import type {
  CharacterPosition,
  CharacterRegistry,
  CharacterRegistryEntry,
} from "../presentation/types.js";

/**
 * Asset catalog types (docs §57–§60).
 *
 * The full catalog carries real file paths (`src`); the model-facing
 * projection strips them and keeps only logical ids + descriptions (§59).
 */

export interface BackgroundAsset {
  id: string;
  src: string;
  description: string;
}

export interface BgmAsset {
  id: string;
  src: string;
  description: string;
}

export interface SoundEffectAsset {
  id: string;
  src: string;
  description: string;
}

export interface SpriteVariant {
  id: string;
  src: string;
  description?: string;
}

export interface SpriteSet {
  id: string;
  description?: string;
  variants: Record<string, SpriteVariant>;
}

/**
 * Legacy 身份绑定（C2 起 frozen）：身份真源移至 `src/core/characters/`
 * （CharacterRoster/CharacterRegistry）。`characters` 段继续作为兼容
 * 边界存在（bootstrap legacy 模式、旧 parser），直到 F1/M1 的
 * characters.yaml 迁移完成；新内容不得在此新增身份字段。
 */
export interface CharacterAssetBinding {
  characterId: string;
  scriptName: string;
  displayName: string;
  spriteSet: string;
  defaultVariant: string;
  defaultPosition: CharacterPosition;
  /**
   * Sprite sets the character may use, incl. cross-set outfit swaps
   * (`[spriteSet:variant]` in dialogue). Defaults to [spriteSet] — a
   * character normally only renders with its own art (docs §15).
   */
  allowedSpriteSets: string[];
}

export interface AssetCatalog {
  guidance: string;
  backgrounds: Record<string, BackgroundAsset>;
  bgm: Record<string, BgmAsset>;
  soundEffects: Record<string, SoundEffectAsset>;
  spriteSets: Record<string, SpriteSet>;
  characters: Record<string, CharacterAssetBinding>;
}

/**
 * Model-facing projection: logical ids + descriptions, NO file paths
 * (docs §59). This is what gets serialized into the prompt.
 */
export interface ModelAssetCatalog {
  guidance: string;
  backgrounds: Record<string, { description: string }>;
  bgm: Record<string, { description: string }>;
  soundEffects: Record<string, { description: string }>;
  spriteSets: Record<
    string,
    { description?: string; variants: Record<string, { description?: string }> }
  >;
  characters: Record<
    string,
    {
      scriptName: string;
      displayName: string;
      spriteSet: string;
      defaultVariant: string;
      defaultPosition: CharacterPosition;
      allowedSpriteSets: string[];
    }
  >;
}

/**
 * Browser-facing projection: logical id → controlled URL (spec §5.2).
 * No filesystem paths are exposed; `url` is always a root-relative
 * path under the /game-assets/ prefix.
 */
export interface PublicAssetManifest {
  backgrounds: Record<string, { url: string }>;
  bgm: Record<string, { url: string }>;
  soundEffects: Record<string, { url: string }>;
  spriteSets: Record<string, { variants: Record<string, { url: string }> }>;
}

export interface AssetResolver {
  resolveBackground(id: string): { src: string } | undefined;
  resolveBgm(id: string): { src: string } | undefined;
  resolveSoundEffect(id: string): { src: string } | undefined;
  resolveSprite(spriteSet: string, variant: string): { src: string } | undefined;
}

// Re-exported for convenience so asset consumers do not need to reach
// into ../presentation for the registry types they build catalogs from.
export type { CharacterPosition, CharacterRegistry, CharacterRegistryEntry };
