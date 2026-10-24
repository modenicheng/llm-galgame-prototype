/**
 * image-gen — 文件 IO 助手。core（validate/client）保持无文件依赖；
 * CLI 与外部脚本共用这里的读写函数。仅支持 png / jpeg / webp。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ImageParamError } from "./validate.js";
import { formatSizeSpec, type GeneratedImage, type GptImageModelId, type ImageFileInput, type ImageOutputFormat, type ImageSizeSpec } from "./types.js";

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** 输出扩展名：jpeg → .jpg，其余与格式同名。 */
export function extForFormat(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把本地图片读取为 ImageFileInput（按扩展名判断 MIME；缺失/不支持/不可读抛 ImageParamError）。 */
export async function loadImageFile(filePath: string): Promise<ImageFileInput> {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_BY_EXT[ext];
  if (contentType === undefined) {
    throw new ImageParamError([
      `不支持的图片格式: ${filePath}（仅支持 .png / .jpg / .jpeg / .webp）`,
    ]);
  }
  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch (error) {
    throw new ImageParamError([`无法读取图片 ${filePath}: ${errMessage(error)}`]);
  }
  return { filename: path.basename(filePath), contentType, data };
}

/** 默认文件名前缀：{本地时间戳}-{model}-{size}，如 20260914-103045-gpt-image-2-1024x1536。 */
export function defaultBasename(
  model: GptImageModelId,
  size: ImageSizeSpec,
  now: Date = new Date(),
): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const timestamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${timestamp}-${model}-${formatSizeSpec(size)}`;
}

/** 把结果图片写入 dir（自动建目录），返回写入路径列表。 */
export async function saveImages(
  images: readonly GeneratedImage[],
  dir: string,
  baseName: string,
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const [index, image] of images.entries()) {
    const fileName = `${baseName}-${String(index + 1).padStart(2, "0")}.${extForFormat(image.format)}`;
    const filePath = path.join(dir, fileName);
    await writeFile(filePath, image.bytes);
    paths.push(filePath);
  }
  return paths;
}

/** 保存流式部分图预览（SSE partial 图为 png）。 */
export async function savePartialImages(
  partials: readonly Uint8Array[],
  dir: string,
  baseName: string,
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const [index, bytes] of partials.entries()) {
    const fileName = `${baseName}-partial${String(index + 1).padStart(2, "0")}.png`;
    const filePath = path.join(dir, fileName);
    await writeFile(filePath, bytes);
    paths.push(filePath);
  }
  return paths;
}
