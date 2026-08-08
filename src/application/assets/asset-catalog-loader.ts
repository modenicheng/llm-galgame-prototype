import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type {
  AssetCatalog,
  BackgroundAsset,
  BgmAsset,
  CharacterAssetBinding,
  SoundEffectAsset,
  SpriteSet,
  SpriteVariant,
} from "../../core/assets/types.js";

// ---------------------------------------------------------------------------
// Raw YAML shape (snake_case, docs §58)
// ---------------------------------------------------------------------------

const POSITIONS = ["far_left", "left", "center", "right", "far_right"] as const;

const AssetEntrySchema = z.object({
  src: z.string().min(1),
  description: z.string(),
});

const SpriteVariantSchema = z.object({
  src: z.string().min(1),
  description: z.string().optional(),
});

const SpriteSetSchema = z.object({
  description: z.string().optional(),
  variants: z.record(z.string(), SpriteVariantSchema),
});

const CharacterBindingSchema = z.object({
  script_name: z.string().min(1),
  display_name: z.string().min(1),
  sprite_set: z.string().min(1),
  default_variant: z.string().min(1),
  default_position: z.enum(POSITIONS),
});

const ResourceYamlSchema = z.object({
  guidance: z.string(),
  backgrounds: z.record(z.string(), AssetEntrySchema),
  bgm: z.record(z.string(), AssetEntrySchema),
  sound_effects: z.record(z.string(), AssetEntrySchema),
  sprite_sets: z.record(z.string(), SpriteSetSchema),
  characters: z.record(z.string(), CharacterBindingSchema),
});

type ResourceYaml = z.infer<typeof ResourceYamlSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate the asset catalog YAML (docs §57–§58).
 *
 * Parses with the `yaml` package, validates with a zod schema, and maps
 * the snake_case YAML keys onto the camelCase AssetCatalog. Descriptions
 * (and guidance) are trimmed of leading/trailing whitespace.
 *
 * Throws a descriptive Error naming the YAML file on any failure.
 */
export async function loadAssetCatalog(filePath: string): Promise<AssetCatalog> {
  const absolutePath = path.resolve(filePath);

  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new Error(
      `无法读取资产目录 ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new Error(
      `资产目录 YAML 解析失败 ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    throw new Error(`资产目录格式错误 ${absolutePath}: YAML 顶层必须是一个对象。`);
  }

  const result = ResourceYamlSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`资产目录校验失败 ${absolutePath}: ${detail}`);
  }

  return mapToCatalog(result.data);
}

// ---------------------------------------------------------------------------
// snake_case → camelCase mapping
// ---------------------------------------------------------------------------

function mapToCatalog(data: ResourceYaml): AssetCatalog {
  const backgrounds: Record<string, BackgroundAsset> = {};
  for (const [id, asset] of Object.entries(data.backgrounds)) {
    backgrounds[id] = {
      id,
      src: asset.src,
      description: asset.description.trim(),
    };
  }

  const bgm: Record<string, BgmAsset> = {};
  for (const [id, asset] of Object.entries(data.bgm)) {
    bgm[id] = {
      id,
      src: asset.src,
      description: asset.description.trim(),
    };
  }

  const soundEffects: Record<string, SoundEffectAsset> = {};
  for (const [id, asset] of Object.entries(data.sound_effects)) {
    soundEffects[id] = {
      id,
      src: asset.src,
      description: asset.description.trim(),
    };
  }

  const spriteSets: Record<string, SpriteSet> = {};
  for (const [id, set] of Object.entries(data.sprite_sets)) {
    const variants: Record<string, SpriteVariant> = {};
    for (const [variantId, variant] of Object.entries(set.variants)) {
      variants[variantId] = {
        id: variantId,
        src: variant.src,
        ...(variant.description !== undefined
          ? { description: variant.description.trim() }
          : {}),
      };
    }
    spriteSets[id] = {
      id,
      ...(set.description !== undefined ? { description: set.description.trim() } : {}),
      variants,
    };
  }

  const characters: Record<string, CharacterAssetBinding> = {};
  for (const [characterId, binding] of Object.entries(data.characters)) {
    characters[characterId] = {
      characterId,
      scriptName: binding.script_name,
      displayName: binding.display_name,
      spriteSet: binding.sprite_set,
      defaultVariant: binding.default_variant,
      defaultPosition: binding.default_position,
    };
  }

  return {
    guidance: data.guidance.trim(),
    backgrounds,
    bgm,
    soundEffects,
    spriteSets,
    characters,
  };
}
