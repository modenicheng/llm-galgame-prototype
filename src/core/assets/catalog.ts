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

/** Registry fallback when no asset catalog is wired (Game without `assets.catalog`). */
export const EMPTY_CHARACTER_REGISTRY: CharacterRegistry = {
  resolveByScriptName(): undefined {
    return undefined;
  },
  resolveById(): undefined {
    return undefined;
  },
  entries(): CharacterRegistryEntry[] {
    return [];
  },
};

/**
 * Build the CharacterRegistry from catalog character bindings (docs §7,
 * §10). `resolveById` accepts the internal id first, then falls back to
 * the script name; `resolveByScriptName` matches dialogue headers.
 *
 * C2 legacy bridge：身份真源已移至 `src/core/characters/`（roster +
 * CharacterRegistry）。本函数留在兼容边界——bootstrap legacy 模式与旧
 * parser 仍由资产目录派生注册表；新内容格式不得新增依赖。
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

/**
 * 原型链安全的立绘存在性检查（C2 角色 registry 资源绑定校验用）：
 * `catalog.spriteSets["toString"]` 这类原型成员绝不能算“素材存在”。
 */
export function hasSpriteVariant(
  catalog: AssetCatalog,
  spriteSet: string,
  variant: string,
): boolean {
  if (!Object.hasOwn(catalog.spriteSets, spriteSet)) return false;
  const set = catalog.spriteSets[spriteSet];
  if (set === undefined) return false;
  return Object.hasOwn(set.variants, variant);
}
