import { access, readFile } from "node:fs/promises";
import path, { resolve, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type {
  AssetCatalog,
  BackgroundAsset,
  BgmAsset,
  BgmPlayback,
  SoundEffectAsset,
  SpriteSet,
  SpriteVariant,
} from "../../core/assets/types.js";

// ---------------------------------------------------------------------------
// Raw YAML shape (snake_case, docs §58)
// ---------------------------------------------------------------------------

const AssetEntrySchema = z.object({
  src: z.string().min(1),
  description: z.string(),
});

/**
 * BGM 播放微调（裁切窗口/淡入淡出）。
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

const SpriteVariantSchema = z.object({
  src: z.string().min(1),
  description: z.string().optional(),
});

const SpriteSetSchema = z.object({
  description: z.string().optional(),
  variants: z.record(z.string(), SpriteVariantSchema),
});

const ResourceYamlSchema = z.object({
  guidance: z.string(),
  backgrounds: z.record(z.string(), AssetEntrySchema),
  bgm: z.record(z.string(), BgmAssetEntrySchema),
  bgm_playback: BgmPlaybackSchema.optional(),
  sound_effects: z.record(z.string(), AssetEntrySchema),
  sprite_sets: z.record(z.string(), SpriteSetSchema),
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

  // C7：资源目录不再承载角色身份（真源是 characters.yaml roster / canon）。
  // 顶层出现 characters 键时显式报错，防止静默丢弃让作者以为绑定仍生效。
  if (Object.hasOwn(parsed, "characters")) {
    throw new Error(
      `资产目录校验失败 ${absolutePath}: characters 身份定义已迁移（真源是 characters.yaml /` +
        ` 世界 canon roster）；资源目录只承载素材，请删除本段。`,
    );
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

  // C7：角色→素材的交叉校验随 characters 身份段一并移除——look 绑定由
  // CharacterRegistry 构造时按 sprite_sets 注册表校验（core/characters）。

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
      };
    }
    spriteSets[id] = {
      id,
      ...(set.description !== undefined ? { description: set.description.trim() } : {}),
      variants,
    };
  }

  // C7：资源目录不承载角色身份——AssetCatalog.characters 兼容形状已移除，
  // 身份真源是 characters.yaml roster / 世界 canon（C2 CharacterRegistry）。

  return {
    guidance: data.guidance.trim(),
    backgrounds,
    bgm,
    soundEffects,
    spriteSets,
  };
}
