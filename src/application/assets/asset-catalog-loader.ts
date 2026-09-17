import { access, readFile } from "node:fs/promises";
import path, { resolve, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type {
  AssetCatalog,
  BackgroundAsset,
  BgmAsset,
  BgmPlayback,
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

/**
 * BGM 播放微调（docs/asset-management.md「BGM 裁切与淡入淡出」）。
 * 全局默认在顶层 bgm_playback，每曲 playback 覆盖同名字段；单位秒。
 */
const BgmPlaybackFieldsSchema = {
  start: z.number().finite().min(0).optional(),
  end: z.number().finite().gt(0).optional(),
  fade_in: z.number().finite().min(0).optional(),
  fade_out: z.number().finite().min(0).optional(),
};

const BgmPlaybackSchema = z
  .object({ ...BgmPlaybackFieldsSchema })
  .refine(
    (v) => Object.keys(v).length > 0,
    "playback 至少要有一个字段（start/end/fade_in/fade_out）",
  )
  .refine(
    (v) => v.end === undefined || v.start === undefined || v.end > v.start,
    "playback 的 end 必须大于 start",
  );

const BgmAssetEntrySchema = AssetEntrySchema.extend({
  playback: BgmPlaybackSchema.optional(),
});

/**
 * 立绘呈现参数（docs/asset-management.md「立绘 presentation」）。
 * height 是整套立绘的舞台显示占比：变体之间身高必须一致，所以只在
 * set 级开放，变体级 schema 不含 height（避免差分切换时跳变）。
 */
const SpritePresentationCoreSchema = {
  rotate: z
    .number()
    .finite()
    .refine((v) => Math.abs(v) <= 180, "rotate 取值范围 ±180 度")
    .optional(),
  crop: z
    .object({
      left: z.number().int().min(0),
      top: z.number().int().min(0),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
    })
    .optional(),
  normalize: z.boolean().optional(),
};

const SpritePresentationSchema = z
  .object({ ...SpritePresentationCoreSchema, height: z.number().finite().gt(0).lte(1.2).optional() })
  .refine(
    (v) =>
      v.rotate !== undefined ||
      v.crop !== undefined ||
      v.normalize !== undefined ||
      v.height !== undefined,
    "presentation 至少要有一个字段（rotate/crop/normalize/height）",
  );

const SpriteVariantPresentationSchema = z
  .object({ ...SpritePresentationCoreSchema })
  .refine(
    (v) => v.rotate !== undefined || v.crop !== undefined || v.normalize !== undefined,
    "变体级 presentation 至少要有一个字段（rotate/crop/normalize；height 只能在 set 级配置）",
  );

const SpriteVariantSchema = z.object({
  src: z.string().min(1),
  description: z.string().optional(),
  presentation: SpriteVariantPresentationSchema.optional(),
});

const SpriteSetSchema = z.object({
  description: z.string().optional(),
  presentation: SpritePresentationSchema.optional(),
  variants: z.record(z.string(), SpriteVariantSchema),
});

const CharacterBindingSchema = z.object({
  script_name: z.string().min(1),
  display_name: z.string().min(1),
  sprite_set: z.string().min(1),
  default_variant: z.string().min(1),
  default_position: z.enum(POSITIONS),
  allowed_sprite_sets: z.array(z.string().min(1)).optional(),
});

const ResourceYamlSchema = z.object({
  guidance: z.string(),
  backgrounds: z.record(z.string(), AssetEntrySchema),
  bgm: z.record(z.string(), BgmAssetEntrySchema),
  bgm_playback: BgmPlaybackSchema.optional(),
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

  const assetRoot = path.dirname(absolutePath);
  const catalog = mapToCatalog(result.data);
  await validateCatalog(catalog, assetRoot);
  return catalog;
}

// ---------------------------------------------------------------------------
// Startup validation (cross-references + file existence + path escape)
// ---------------------------------------------------------------------------

async function validateCatalog(
  catalog: AssetCatalog,
  assetRoot: string,
): Promise<void> {
  const rootResolved = resolve(assetRoot);

  for (const [id, asset] of Object.entries(catalog.bgm)) {
    const { start, end } = asset.playback ?? {};
    // 单条配置的 start<end 已由 schema 把关；这里拦住「默认合并后」才出现的
    // 交叉窗口（如全局 end=90、某曲 start=120）。
    if (start !== undefined && end !== undefined && end <= start) {
      throw new Error(
        `资产目录校验失败: bgm.${id}.playback 窗口无效（end ${end} 必须大于 start ${start}）`,
      );
    }
  }

  for (const [characterId, binding] of Object.entries(catalog.characters)) {
    // hasOwn: prototype keys (e.g. "constructor") must not satisfy the lookup.
    const set = catalog.spriteSets[binding.spriteSet];
    if (set === undefined || !Object.hasOwn(catalog.spriteSets, binding.spriteSet)) {
      throw new Error(
        `资产目录校验失败: characters.${characterId}.sprite_set "${binding.spriteSet}" 不存在于 sprite_sets`,
      );
    }
    if (!Object.hasOwn(set.variants, binding.defaultVariant)) {
      throw new Error(
        `资产目录校验失败: characters.${characterId}.default_variant "${binding.defaultVariant}" 不存在于 sprite_set "${binding.spriteSet}"`,
      );
    }
    if (!binding.allowedSpriteSets.includes(binding.spriteSet)) {
      throw new Error(
        `资产目录校验失败: characters.${characterId}.allowed_sprite_sets 必须包含自身的 sprite_set "${binding.spriteSet}"`,
      );
    }
    for (const allowed of binding.allowedSpriteSets) {
      if (!Object.hasOwn(catalog.spriteSets, allowed)) {
        throw new Error(
          `资产目录校验失败: characters.${characterId}.allowed_sprite_sets 引用不存在的 sprite_set "${allowed}"`,
        );
      }
    }
  }

  const srcs: Array<{ where: string; src: string }> = [
    ...Object.entries(catalog.backgrounds).map(([id, a]) => ({ where: `backgrounds.${id}`, src: a.src })),
    ...Object.entries(catalog.bgm).map(([id, a]) => ({ where: `bgm.${id}`, src: a.src })),
    ...Object.entries(catalog.soundEffects).map(([id, a]) => ({ where: `sound_effects.${id}`, src: a.src })),
    ...Object.entries(catalog.spriteSets).flatMap(([id, set]) =>
      Object.entries(set.variants).map(([v, vv]) => ({ where: `sprite_sets.${id}.variants.${v}`, src: vv.src })),
    ),
  ];

  for (const { where, src } of srcs) {
    const filePath = resolve(rootResolved, src);
    if (filePath !== rootResolved && !filePath.startsWith(rootResolved + sep)) {
      throw new Error(`资产目录校验失败: ${where}.src "${src}" 逃逸素材根目录`);
    }
    try {
      await access(filePath);
    } catch {
      throw new Error(`资产目录校验失败: ${where}.src 文件不存在: ${filePath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// snake_case → camelCase mapping
// ---------------------------------------------------------------------------

/** 全局默认（bgm_playback）与每曲 playback 按字段合并，每曲优先；双方都缺省时返回 undefined。 */
function mergeBgmPlayback(
  defaults: ResourceYaml["bgm_playback"],
  perTrack: ResourceYaml["bgm"][string]["playback"],
): BgmPlayback | undefined {
  if (defaults === undefined && perTrack === undefined) return undefined;
  const out: BgmPlayback = {};
  const start = perTrack?.start ?? defaults?.start;
  const end = perTrack?.end ?? defaults?.end;
  const fadeIn = perTrack?.fade_in ?? defaults?.fade_in;
  const fadeOut = perTrack?.fade_out ?? defaults?.fade_out;
  if (start !== undefined) out.start = start;
  if (end !== undefined) out.end = end;
  if (fadeIn !== undefined) out.fadeIn = fadeIn;
  if (fadeOut !== undefined) out.fadeOut = fadeOut;
  return out;
}

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
    const playback = mergeBgmPlayback(data.bgm_playback, asset.playback);
    bgm[id] = {
      id,
      src: asset.src,
      description: asset.description.trim(),
      ...(playback !== undefined ? { playback } : {}),
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
        ...(variant.presentation !== undefined
          ? { presentation: variant.presentation }
          : {}),
      };
    }
    spriteSets[id] = {
      id,
      ...(set.description !== undefined ? { description: set.description.trim() } : {}),
      ...(set.presentation !== undefined ? { presentation: set.presentation } : {}),
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
      allowedSpriteSets: binding.allowed_sprite_sets ?? [binding.sprite_set],
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
