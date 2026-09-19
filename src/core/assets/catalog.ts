import type { CharacterRegistry, CharacterRegistryEntry } from "../presentation/types.js";
import type { CharacterRoster } from "../characters/types.js";
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

  return {
    guidance: catalog.guidance,
    backgrounds,
    bgm,
    soundEffects,
    spriteSets,
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
 * Build the v1 presentation CharacterRegistry from a C2 roster (docs §7,
 * §10). `resolveById` accepts the internal id first, then falls back to
 * the script name; `resolveByScriptName` matches dialogue headers.
 *
 * C7：身份真源是 `src/core/characters/`（roster + CharacterRegistry），
 * 资产目录 characters 兼容形状已移除——v1 编译边界的展示注册表由本
 * 函数从 roster 派生（与 F1 的派生规则一致：无 presentation 的角色
 * （玩家）不产生舞台绑定；displayName = initialLabel；allowedSpriteSets
 * = looks 中出现过的素材组，默认组在前）。
 */
export function toCharacterRegistry(roster: CharacterRoster): CharacterRegistry {
  const byId = new Map<string, CharacterRegistryEntry>();
  const byScriptName = new Map<string, CharacterRegistryEntry>();

  for (const definition of roster.characters) {
    const presentation = definition.presentation;
    if (presentation === undefined) continue; // 玩家/无立绘：无舞台绑定
    const defLook = presentation.looks[presentation.defaultLook];
    if (defLook === undefined) continue; // registry 构造已给出结构化诊断
    const allowed = [defLook.spriteSet];
    for (const look of Object.values(presentation.looks)) {
      if (!allowed.includes(look.spriteSet)) allowed.push(look.spriteSet);
    }
    const entry: CharacterRegistryEntry = {
      characterId: definition.id,
      scriptName: definition.name,
      displayName: definition.initialLabel,
      spriteSet: defLook.spriteSet,
      defaultVariant: defLook.variant,
      defaultPosition: presentation.defaultPosition,
      allowedSpriteSets: allowed,
    };
    byId.set(definition.id, entry);
    byScriptName.set(definition.name, entry);
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
