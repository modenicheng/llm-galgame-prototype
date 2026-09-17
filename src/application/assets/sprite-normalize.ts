/**
 * 立绘 presentation 派生管线（docs/asset-management.md「立绘 presentation」）。
 *
 * resources.yaml 的 `sprite_sets.<id>.presentation`（rotate/crop/normalize）
 * 不改动原始文件：host 启动时把处理后的 PNG 写入派生目录并重写 manifest
 * URL。处理顺序固定为 rotate → crop → 裁透明边 → 同套统一画布 —— 最后一
 * 步把该套所有变体贴到同一个 union 画布上，保证「同一套立绘裁切后规格一
 * 致」且表情差分逐像素对齐。
 *
 * `height` 不触发文件处理，只是投影给浏览器的展示占比。
 *
 * 纯图像运算（rotateImage/cropImage/alphaBBox/composeVariantCanvases）与
 * 文件系统（normalizeSprites）分开导出，便于合成 PNG 的单元测试。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import type { AssetCatalog, SpritePresentation, SpriteSet } from "../../core/assets/types.js";

/** 派生文件布局/参数指纹版本：算法变化时递增，自动失效旧缓存。 */
const PIPELINE_VERSION = "v1";
/** alpha ≥ 此值视为不透明像素（容忍压缩噪点，避免 bbox 被孤点撑爆）。 */
const ALPHA_THRESHOLD = 8;

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, row-major
}

export interface VariantBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// 纯图像运算
// ---------------------------------------------------------------------------

/** 顺时针旋转（度）。90 的倍数走无损重排，任意角双线性采样。 */
export function rotateImage(image: RGBAImage, degrees: number): RGBAImage {
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0) return image;
  const { width, height, data } = image;

  if (normalized === 90 || normalized === 180 || normalized === 270) {
    const swap = normalized !== 180;
    const outWidth = swap ? height : width;
    const outHeight = swap ? width : height;
    const out = new Uint8Array(outWidth * outHeight * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let dx: number;
        let dy: number;
        if (normalized === 90) {
          dx = height - 1 - y;
          dy = x;
        } else if (normalized === 180) {
          dx = width - 1 - x;
          dy = height - 1 - y;
        } else {
          dx = y;
          dy = width - 1 - x;
        }
        const src = (y * width + x) * 4;
        const dst = (dy * outWidth + dx) * 4;
        out[dst] = data[src]!;
        out[dst + 1] = data[src + 1]!;
        out[dst + 2] = data[src + 2]!;
        out[dst + 3] = data[src + 3]!;
      }
    }
    return { width: outWidth, height: outHeight, data: out };
  }

  // 任意角：dest→source 逆映射 + 双线性采样。
  return generalizedRotate(image, (normalized * Math.PI) / 180);
}

/** 任意角双线性旋转（y-down 屏幕坐标，顺时针为正），dest→source 逆映射。 */
function generalizedRotate(image: RGBAImage, rad: number): RGBAImage {
  const { width, height, data } = image;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const outWidth = Math.max(1, Math.ceil(Math.abs(width * cos) + Math.abs(height * sin)));
  const outHeight = Math.max(1, Math.ceil(Math.abs(width * sin) + Math.abs(height * cos)));
  const out = new Uint8Array(outWidth * outHeight * 4);
  const cx = width / 2;
  const cy = height / 2;
  const outCx = outWidth / 2;
  const outCy = outHeight / 2;

  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const dx = x + 0.5 - outCx;
      const dy = y + 0.5 - outCy;
      // R(-θ)：y-down 坐标下的逆旋转。
      const sx = cx + cos * dx + sin * dy - 0.5;
      const sy = cy - sin * dx + cos * dy - 0.5;
      const dst = (y * outWidth + x) * 4;
      bilinearSample(data, width, height, sx, sy, out, dst);
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

/** 直通 alpha 的双线性采样（颜色按 alpha 加权，避免透明黑边）。 */
function bilinearSample(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  out: Uint8Array,
  dst: number,
): void {
  if (x < -1 || y < -1 || x > width || y > height) {
    out[dst + 3] = 0;
    return;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let j = 0; j < 2; j += 1) {
    for (let i = 0; i < 2; i += 1) {
      const px = Math.min(width - 1, Math.max(0, x0 + i));
      const py = Math.min(height - 1, Math.max(0, y0 + j));
      const w = (i === 0 ? 1 - fx : fx) * (j === 0 ? 1 - fy : fy);
      const src = (py * width + px) * 4;
      const alpha = (data[src + 3]! / 255) * w;
      r += data[src]! * alpha;
      g += data[src + 1]! * alpha;
      b += data[src + 2]! * alpha;
      a += alpha;
    }
  }
  if (a <= 0) {
    out[dst + 3] = 0;
    return;
  }
  out[dst] = Math.round(Math.min(255, r / a));
  out[dst + 1] = Math.round(Math.min(255, g / a));
  out[dst + 2] = Math.round(Math.min(255, b / a));
  out[dst + 3] = Math.round(Math.min(255, a * 255));
}

/** 旋转后按源图像素硬裁切（越界部分以透明补齐，不做静默收缩）。 */
export function cropImage(
  image: RGBAImage,
  crop: { left: number; top: number; width: number; height: number },
): RGBAImage {
  const out = new Uint8Array(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y += 1) {
    const sy = y + crop.top;
    if (sy < 0 || sy >= image.height) continue;
    for (let x = 0; x < crop.width; x += 1) {
      const sx = x + crop.left;
      if (sx < 0 || sx >= image.width) continue;
      const src = (sy * image.width + sx) * 4;
      const dst = (y * crop.width + x) * 4;
      out[dst] = image.data[src]!;
      out[dst + 1] = image.data[src + 1]!;
      out[dst + 2] = image.data[src + 2]!;
      out[dst + 3] = image.data[src + 3]!;
    }
  }
  return { width: crop.width, height: crop.height, data: out };
}

/** 非透明像素包围盒（alpha ≥ 阈值）。整图透明返回 undefined。 */
export function alphaBBox(image: RGBAImage): VariantBox | undefined {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3]! >= ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return undefined;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * 同套统一画布：所有变体贴到同一 union 画布，保留各自相对偏移 ——
 * 输出规格逐套一致、差分逐像素对齐。空套（全透明变体）抛错。
 */
export function composeVariantCanvases(
  images: RGBAImage[],
): { canvas: { width: number; height: number }; outputs: RGBAImage[]; offsets: Array<{ x: number; y: number }> } {
  if (images.length === 0) throw new Error("composeVariantCanvases: 空变体集");
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const boxes: VariantBox[] = [];
  for (const image of images) {
    const box = alphaBBox(image);
    if (box === undefined) {
      throw new Error("composeVariantCanvases: 变体整图透明，无法归一化");
    }
    boxes.push(box);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  const canvasWidth = maxX - minX;
  const canvasHeight = maxY - minY;
  const outputs = images.map((image, index) => {
    const box = boxes[index]!;
    const out = new Uint8Array(canvasWidth * canvasHeight * 4);
    for (let y = 0; y < box.height; y += 1) {
      for (let x = 0; x < box.width; x += 1) {
        const src = ((box.y + y) * image.width + (box.x + x)) * 4;
        const dst = ((box.y - minY + y) * canvasWidth + (box.x - minX + x)) * 4;
        out[dst] = image.data[src]!;
        out[dst + 1] = image.data[src + 1]!;
        out[dst + 2] = image.data[src + 2]!;
        out[dst + 3] = image.data[src + 3]!;
      }
    }
    return { width: canvasWidth, height: canvasHeight, data: out };
  });
  return {
    canvas: { width: canvasWidth, height: canvasHeight },
    outputs,
    offsets: boxes.map((box) => ({ x: box.x - minX, y: box.y - minY })),
  };
}

// ---------------------------------------------------------------------------
// 文件系统管线（host 启动时调用）
// ---------------------------------------------------------------------------

export interface SpriteNormalizeOptions {
  /** 原始资产根（catalog 文件所在目录）。 */
  assetRoot: string;
  /** 派生输出根（如 <repo>/output/derived-game-assets）。 */
  derivedRoot: string;
  /** 派生文件的公开 URL 前缀。 */
  urlPrefix: string;
}

export interface SpriteNormalizeResult {
  /** set → variant → 派生 URL（仅含触发了文件处理的 set）。 */
  urls: Record<string, Record<string, string>>;
  /** set → 有效 height（含未触发文件处理的纯 height set）。 */
  heights: Record<string, number>;
  /** set → 派生画布规格（union 画布，同套所有变体一致）。 */
  specs: Record<string, { width: number; height: number }>;
}

/** set 级 + variant 级 presentation 的浅合并。 */
export function effectivePresentation(
  set: SpriteSet,
  variantId: string,
): SpritePresentation | undefined {
  const setLevel = set.presentation;
  const variantLevel = set.variants[variantId]?.presentation;
  if (setLevel === undefined && variantLevel === undefined) return undefined;
  return { ...(setLevel ?? {}), ...(variantLevel ?? {}) };
}

function needsProcessing(presentation: SpritePresentation): boolean {
  return presentation.rotate !== undefined || presentation.crop !== undefined || presentation.normalize === true;
}

interface CacheVariantEntry {
  srcMtimeMs: number;
  width: number;
  height: number;
}

interface SetCacheMeta {
  version: string;
  fingerprint: string;
  canvas: { width: number; height: number };
  variants: Record<string, CacheVariantEntry>;
}

function fingerprintOf(presentation: SpritePresentation): string {
  return createHash("sha256").update(`${PIPELINE_VERSION}|${JSON.stringify(presentation)}`).digest("hex");
}

function decodePng(buffer: Buffer, where: string): RGBAImage {
  try {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  } catch (error) {
    throw new Error(`立绘 PNG 解码失败 ${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function encodePng(image: RGBAImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

async function readPngFile(filePath: string, where: string): Promise<RGBAImage> {
  return decodePng(await readFile(filePath), where);
}

/**
 * 对 catalog 中配置了 presentation 的 sprite set 做派生（含磁盘缓存）；
 * 未配置的 set 不出现在结果里，host 沿用原始 URL。
 * 同套所有变体输出同一规格画布；任何解码/写盘失败都抛错（启动即失败，
 * 与 catalog 校验同纪律），带 set/variant 定位信息。
 */
export async function normalizeSprites(
  catalog: AssetCatalog,
  options: SpriteNormalizeOptions,
): Promise<SpriteNormalizeResult> {
  const result: SpriteNormalizeResult = { urls: {}, heights: {}, specs: {} };
  const derivedRoot = path.resolve(options.derivedRoot);

  for (const [setId, set] of Object.entries(catalog.spriteSets)) {
    if (set.presentation?.height !== undefined) {
      result.heights[setId] = set.presentation.height;
    }

    // height 只在 set 级存在（loader 已保证）；变体级参数仅覆盖
    // rotate/crop/normalize。
    if (set.presentation?.height !== undefined) {
      result.heights[setId] = set.presentation.height;
    }

    const processed = new Map<string, { presentation: SpritePresentation; src: string }>();
    for (const [variantId, variant] of Object.entries(set.variants)) {
      const presentation = effectivePresentation(set, variantId);
      if (presentation !== undefined && needsProcessing(presentation)) {
        processed.set(variantId, { presentation, src: variant.src });
      }
    }
    if (processed.size === 0) continue;

    const derivedDir = path.join(derivedRoot, setId);
    const metaPath = path.join(derivedDir, ".meta.json");

    // 指纹 = 全套变体的有效 presentation（含未处理变体的空参数），任一
    // 变体参数变化即整套失效重derive，保证 union 画布一致性。
    const fingerprintInput: Record<string, SpritePresentation> = {};
    for (const variantId of Object.keys(set.variants)) {
      fingerprintInput[variantId] = effectivePresentation(set, variantId) ?? {};
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");

    const srcMtimes = new Map<string, number>();
    for (const [variantId, entry] of processed) {
      srcMtimes.set(variantId, (await stat(path.resolve(options.assetRoot, entry.src))).mtimeMs);
    }

    const cached = await tryLoadCache(metaPath, fingerprint, srcMtimes, derivedDir);
    if (cached !== null) {
      result.specs[setId] = { width: cached.canvas.width, height: cached.canvas.height };
      result.urls[setId] = Object.fromEntries(
        [...processed.keys()].map((variantId) => [
          variantId,
          `${options.urlPrefix}${setId}/${variantId}.png`,
        ]),
      );
      continue;
    }

    const processedImages: RGBAImage[] = [];
    for (const [variantId, entry] of processed) {
      let image = await readPngFile(path.resolve(options.assetRoot, entry.src), `sprite_sets.${setId}.variants.${variantId}`);
      if (entry.presentation.rotate !== undefined && entry.presentation.rotate % 360 !== 0) {
        image = rotateImage(image, entry.presentation.rotate);
      }
      if (entry.presentation.crop !== undefined) {
        image = cropImage(image, entry.presentation.crop);
      }
      processedImages.push(image);
    }

    const { canvas, outputs } = composeVariantCanvases(processedImages);
    await mkdir(derivedDir, { recursive: true });
    const variants: Record<string, CacheVariantEntry> = {};
    for (const [index, variantId] of [...processed.keys()].entries()) {
      await writeFile(path.join(derivedDir, `${variantId}.png`), encodePng(outputs[index]!));
      variants[variantId] = {
        srcMtimeMs: srcMtimes.get(variantId)!,
        width: canvas.width,
        height: canvas.height,
      };
    }
    const meta: SetCacheMeta = {
      version: PIPELINE_VERSION,
      fingerprint,
      canvas,
      variants,
    };
    await writeFile(metaPath, JSON.stringify(meta, null, 2));

    result.specs[setId] = { width: canvas.width, height: canvas.height };
    result.urls[setId] = Object.fromEntries(
      [...processed.keys()].map((variantId) => [
        variantId,
        `${options.urlPrefix}${setId}/${variantId}.png`,
      ]),
    );
  }

  for (const setId of Object.keys(result.heights)) {
    if (result.heights[setId] === undefined) delete result.heights[setId];
  }
  return result;
}

/** 指纹一致 + 每个变体源 mtime 未变 + 派生文件存在 → 视为有效缓存。 */
async function tryLoadCache(
  metaPath: string,
  fingerprint: string,
  srcMtimes: Map<string, number>,
  derivedDir: string,
): Promise<SetCacheMeta | null> {
  let meta: SetCacheMeta;
  try {
    meta = JSON.parse(await readFile(metaPath, "utf8")) as SetCacheMeta;
  } catch {
    return null;
  }
  if (meta.version !== PIPELINE_VERSION || meta.fingerprint !== fingerprint) return null;
  for (const [variantId, mtime] of srcMtimes) {
    const entry = meta.variants[variantId];
    if (entry === undefined || entry.srcMtimeMs !== mtime) return null;
    try {
      const derived = await stat(path.join(derivedDir, `${variantId}.png`));
      if (!derived.isFile() || derived.size === 0) return null;
    } catch {
      return null;
    }
  }
  return meta;
}
