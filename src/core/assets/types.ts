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

export interface CharacterAssetBinding {
  characterId: string;
  scriptName: string;
  displayName: string;
  spriteSet: string;
  defaultVariant: string;
  defaultPosition: CharacterPosition;
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
