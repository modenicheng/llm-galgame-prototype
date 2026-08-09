import type { CharacterRegistry, CharacterRegistryEntry } from "../presentation/types.js";
import type { AssetCatalog, AssetResolver, ModelAssetCatalog } from "./types.js";

/**
 * Pure catalog projections (docs §58–§60). No I/O, no prompts — these are
 * plain functions over an in-memory AssetCatalog.
 */

/** Strip file paths; keep only what the model should see (docs §59). */
export function toModelCatalog(catalog: AssetCatalog): ModelAssetCatalog {
  const backgrounds: ModelAssetCatalog["backgrounds"] = {};
  for (const [id, asset] of Object.entries(catalog.backgrounds)) {
    backgrounds[id] = { description: asset.description };
  }

  const bgm: ModelAssetCatalog["bgm"] = {};
  for (const [id, asset] of Object.entries(catalog.bgm)) {
    bgm[id] = { description: asset.description };
  }

  const soundEffects: ModelAssetCatalog["soundEffects"] = {};
  for (const [id, asset] of Object.entries(catalog.soundEffects)) {
    soundEffects[id] = { description: asset.description };
  }

  const spriteSets: ModelAssetCatalog["spriteSets"] = {};
  for (const [id, set] of Object.entries(catalog.spriteSets)) {
    const variants: Record<string, { description?: string }> = {};
    for (const [variantId, variant] of Object.entries(set.variants)) {
      variants[variantId] =
        variant.description !== undefined ? { description: variant.description } : {};
    }
    spriteSets[id] =
      set.description !== undefined ? { description: set.description, variants } : { variants };
  }

  const characters: ModelAssetCatalog["characters"] = {};
  for (const [id, binding] of Object.entries(catalog.characters)) {
    characters[id] = {
      scriptName: binding.scriptName,
      displayName: binding.displayName,
      spriteSet: binding.spriteSet,
      defaultVariant: binding.defaultVariant,
      defaultPosition: binding.defaultPosition,
      allowedSpriteSets: binding.allowedSpriteSets,
    };
  }

  return {
    guidance: catalog.guidance,
    backgrounds,
    bgm,
    soundEffects,
    spriteSets,
    characters,
  };
}

/**
 * Build the CharacterRegistry from catalog character bindings (docs §7,
 * §10). `resolveById` accepts the internal id first, then falls back to
 * the script name; `resolveByScriptName` matches dialogue headers.
 */
export function toCharacterRegistry(catalog: AssetCatalog): CharacterRegistry {
  const byId = new Map<string, CharacterRegistryEntry>();
  const byScriptName = new Map<string, CharacterRegistryEntry>();

  for (const [characterId, binding] of Object.entries(catalog.characters)) {
    const entry: CharacterRegistryEntry = {
      characterId,
      scriptName: binding.scriptName,
      displayName: binding.displayName,
      spriteSet: binding.spriteSet,
      defaultVariant: binding.defaultVariant,
      defaultPosition: binding.defaultPosition,
      allowedSpriteSets: binding.allowedSpriteSets,
    };
    byId.set(characterId, entry);
    byScriptName.set(binding.scriptName, entry);
  }

  return {
    resolveByScriptName(scriptName: string) {
      return byScriptName.get(scriptName);
    },
    resolveById(id: string) {
      return byId.get(id) ?? byScriptName.get(id);
    },
    entries() {
      return [...byId.values()];
    },
  };
}

/** Resolve logical asset ids / sprite ids to concrete file paths. */
export function createAssetResolver(catalog: AssetCatalog): AssetResolver {
  return {
    resolveBackground(id: string) {
      const asset = catalog.backgrounds[id];
      return asset !== undefined ? { src: asset.src } : undefined;
    },
    resolveBgm(id: string) {
      const asset = catalog.bgm[id];
      return asset !== undefined ? { src: asset.src } : undefined;
    },
    resolveSoundEffect(id: string) {
      const asset = catalog.soundEffects[id];
      return asset !== undefined ? { src: asset.src } : undefined;
    },
    resolveSprite(spriteSet: string, variant: string) {
      const set = catalog.spriteSets[spriteSet];
      const asset = set?.variants[variant];
      return asset !== undefined ? { src: asset.src } : undefined;
    },
  };
}
