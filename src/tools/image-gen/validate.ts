/**
 * image-gen — 参数归一化与校验。
 *
 * 设计目标：错误参数在本地拦截、绝不发往服务端。规则依据 OpenAI Images API
 * 参考（2026-09 核对）：
 *   - prompt 非空且 ≤32000 字符（gpt-image 系列）
 *   - size："auto" 或 WxH（W/H 均为 16 的倍数、宽高比 1:3~3:1、≤3840×2160、≥256）
 *   - quality：auto/low/medium/high 全系；xhigh/max 仅 2.5 系列；
 *     hd/standard 为 dall-e 专属，本工具不接受
 *   - n：整数 1~10；background：transparent/opaque/auto；moderation：low/auto
 *   - output_format：png/jpeg/webp；output_compression：0~100，仅 jpeg/webp 有意义
 *   - partial_images：0~3，必须配合 stream
 *   - response_format / style：gpt-image 系列不支持，出现即报错
 *   - edits：images 1~16 张；input_fidelity：high/low
 *
 * 输入形态刻意宽松（snake_case 别名、字符串数字），CLI 与 .env 才能复用同一套
 * 校验；输出为完全解析的强类型参数。所有问题一次性收集后以 ImageParamError 抛出。
 */

import {
  GPT_IMAGE_MODELS,
  formatSizeSpec,
  isGptImage25,
  type EditParamsInput,
  type GenerationFallbacks,
  type GenerationParamsInput,
  type GptImageModelId,
  type ImageBackground,
  type ImageFileInput,
  type ImageOutputFormat,
  type ImageQuality,
  type ImageSizeSpec,
  type InputFidelity,
  type ModerationLevel,
  type ResolvedEditParams,
  type ResolvedGenerationParams,
} from "./types.js";
import { GENERATION_DEFAULTS } from "./defaults.js";

/** gpt-image 系列的 prompt 上限。 */
export const MAX_PROMPT_LENGTH = 32_000;
/** size 边长必须是其倍数。 */
const SIZE_MULTIPLE = 16;
/** 工具级最小边长兜底（服务端对过小尺寸必然拒绝或劣化）。 */
const SIZE_MIN_SIDE = 256;
const SIZE_MAX_WIDTH = 3840;
const SIZE_MAX_HEIGHT = 2160;
/** 宽高比允许区间 [1/3, 3]。 */
const ASPECT_MIN = 1 / 3;
const ASPECT_MAX = 3;
/** edits 单次最多参考图数量。 */
export const MAX_EDIT_IMAGES = 16;

/** 参数校验失败。`issues` 为字段级中文原因列表（一次校验全部收集）。 */
export class ImageParamError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`参数校验失败（共 ${issues.length} 处）:\n  - ${issues.join("\n  - ")}`);
    this.name = "ImageParamError";
    this.issues = [...issues];
  }
}

/** 文生图参数的已知键（camelCase，归一化后比对）。 */
const KNOWN_GENERATION_KEYS: readonly string[] = [
  "prompt",
  "model",
  "size",
  "quality",
  "n",
  "background",
  "moderation",
  "outputFormat",
  "outputCompression",
  "stream",
  "partialImages",
  "user",
];
const KNOWN_EDIT_KEYS: readonly string[] = [
  ...KNOWN_GENERATION_KEYS,
  "images",
  "mask",
  "inputFidelity",
];

/** snake_case 别名 → camelCase。 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  output_format: "outputFormat",
  output_compression: "outputCompression",
  partial_images: "partialImages",
  input_fidelity: "inputFidelity",
  response_format: "responseFormat",
};

/** gpt-image 系列明确不支持、禁止发送的参数（值必须给专属报错，而非“未知参数”）。 */
const BANNED_KEYS: Readonly<Record<string, string>> = {
  responseFormat: "gpt-image 系列固定返回 b64_json，不支持 response_format（如需 url 请拿到 bytes 自行保存）",
  style: "style 是 dall-e-3 专属参数，gpt-image 系列不支持",
};

function fmt(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 归一化键名：snake_case → camelCase；同一参数两种写法同时出现即冲突（保留首个）。 */
function normalizeKeys(raw: Readonly<Record<string, unknown>>, issues: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const canonical = KEY_ALIASES[key] ?? key;
    if (canonical in out) {
      issues.push(`参数 ${canonical}（或其别名 ${key}）重复提供，请只保留一种写法`);
      continue;
    }
    out[canonical] = value;
  }
  return out;
}

/** 只挑出已定义（!== undefined）的键，用于分层合并。 */
function definedEntries(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 已知键 + 禁用键检查（在归一化之后进行）。 */
function checkKeys(
  normalized: Readonly<Record<string, unknown>>,
  known: readonly string[],
  issues: string[],
): void {
  for (const [key, value] of Object.entries(normalized)) {
    const banned = BANNED_KEYS[key];
    if (banned !== undefined) {
      if (value !== undefined) issues.push(banned);
      continue;
    }
    if (!known.includes(key)) {
      issues.push(`未知参数 ${fmt(key)}（已知参数: ${known.join(", ")}）`);
    }
  }
}

/** 字符串枚举字段；未提供返回 undefined，非法则记入 issues。 */
function enumField<T extends string>(
  issues: string[],
  label: string,
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  const hit = allowed.find((item) => item === value);
  if (hit === undefined) {
    issues.push(`${label} 必须是 ${allowed.join(" / ")} 之一，收到 ${fmt(value)}`);
    return undefined;
  }
  return hit;
}

/** 整数字段：接受 number（须整数）或整数字符串，范围 [min, max]。 */
function intField(
  issues: string[],
  label: string,
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    issues.push(`${label} 必须是 ${min}~${max} 的整数，收到 ${fmt(value)}`);
    return undefined;
  }
  return n;
}

/** 布尔字段：接受 boolean 或 "true"/"false"/"1"/"0"。 */
function boolField(issues: string[], label: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  issues.push(`${label} 必须是布尔值（true/false），收到 ${fmt(value)}`);
  return undefined;
}

/** 解析 size："auto" 或 "宽x高"。非法/越界记入 issues 并返回 undefined。 */
function sizeField(issues: string[], value: unknown): ImageSizeSpec | undefined {
  if (value === undefined) return undefined;
  if (value === "auto") return "auto";
  if (typeof value !== "string") {
    issues.push(`size 必须是 "auto" 或 "宽x高" 字符串（如 1024x1536），收到 ${fmt(value)}`);
    return undefined;
  }
  const match = /^(\d{2,5})[xX](\d{2,5})$/.exec(value.trim());
  if (match === null) {
    issues.push(`size 必须是 "auto" 或 "宽x高" 字符串（如 1024x1536），收到 ${fmt(value)}`);
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const problems: string[] = [];
  if (width % SIZE_MULTIPLE !== 0 || height % SIZE_MULTIPLE !== 0) {
    problems.push(`宽高须为 ${SIZE_MULTIPLE} 的倍数`);
  }
  if (width < SIZE_MIN_SIDE || height < SIZE_MIN_SIDE) {
    problems.push(`宽高不得小于 ${SIZE_MIN_SIDE}`);
  }
  if (width > SIZE_MAX_WIDTH || height > SIZE_MAX_HEIGHT) {
    problems.push(`最大不超过 ${SIZE_MAX_WIDTH}x${SIZE_MAX_HEIGHT}`);
  }
  const aspect = width / height;
  if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) {
    problems.push("宽高比须在 1:3 ~ 3:1 之间");
  }
  if (problems.length > 0) {
    issues.push(`size ${value} 不合法：${problems.join("；")}`);
    return undefined;
  }
  return { width, height };
}

function promptField(issues: string[], value: unknown): string | undefined {
  if (value === undefined) {
    issues.push("prompt 为必填项（生成内容的文字描述）");
    return undefined;
  }
  if (typeof value !== "string") {
    issues.push(`prompt 必须是字符串，收到 ${fmt(value)}`);
    return undefined;
  }
  if (value.trim().length === 0) {
    issues.push("prompt 不能为空白");
    return undefined;
  }
  if (value.length > MAX_PROMPT_LENGTH) {
    issues.push(`prompt 长度 ${value.length} 超过 gpt-image 系列上限 ${MAX_PROMPT_LENGTH} 字符`);
    return undefined;
  }
  return value;
}

/** ImageFileInput 的结构检查（data 为 Uint8Array，Buffer 亦兼容）。 */
function imageFileField(issues: string[], label: string, value: unknown): ImageFileInput | undefined {
  if (value === undefined) return undefined;
  const candidate = value as Partial<ImageFileInput> | null | undefined;
  const ok =
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.filename === "string" &&
    candidate.filename.length > 0 &&
    typeof candidate.contentType === "string" &&
    candidate.contentType.startsWith("image/") &&
    candidate.data instanceof Uint8Array;
  if (!ok) {
    issues.push(
      `${label} 必须是 { filename, contentType, data } 图片对象（data 为 Uint8Array；本地路径请先用 files.loadImageFile 读取）`,
    );
    return undefined;
  }
  return candidate as ImageFileInput;
}

function imagesField(issues: string[], value: unknown): ImageFileInput[] | undefined {
  if (value === undefined) {
    issues.push("images 为必填项（1~16 张参考图；本地路径请先用 files.loadImageFile 读取）");
    return undefined;
  }
  if (!Array.isArray(value)) {
    issues.push("images 必须是图片对象数组");
    return undefined;
  }
  if (value.length < 1 || value.length > MAX_EDIT_IMAGES) {
    issues.push(`images 需要 1~${MAX_EDIT_IMAGES} 张，收到 ${value.length} 张`);
    return undefined;
  }
  const parsed: ImageFileInput[] = [];
  for (const [index, item] of value.entries()) {
    const file = imageFileField(issues, `images[${index}]`, item);
    if (file !== undefined) parsed.push(file);
  }
  return parsed;
}

function resolveGenerationKeys(merged: Readonly<Record<string, unknown>>, issues: string[]): ResolvedGenerationParams {
  const prompt = promptField(issues, merged.prompt);
  const model = enumField(issues, "model", merged.model, GPT_IMAGE_MODELS) ?? GENERATION_DEFAULTS.model;
  const size = sizeField(issues, merged.size) ?? GENERATION_DEFAULTS.size;
  const quality =
    enumField(issues, "quality", merged.quality, [
      "auto",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ] as const satisfies readonly ImageQuality[]) ?? GENERATION_DEFAULTS.quality;
  const n = intField(issues, "n", merged.n, 1, 10) ?? GENERATION_DEFAULTS.n;
  const background =
    enumField(issues, "background", merged.background, [
      "transparent",
      "opaque",
      "auto",
    ] as const satisfies readonly ImageBackground[]) ?? GENERATION_DEFAULTS.background;
  const moderation =
    enumField(issues, "moderation", merged.moderation, [
      "low",
      "auto",
    ] as const satisfies readonly ModerationLevel[]) ?? GENERATION_DEFAULTS.moderation;
  const outputFormat = enumField(issues, "outputFormat", merged.outputFormat, [
    "png",
    "jpeg",
    "webp",
  ] as const satisfies readonly ImageOutputFormat[]);
  const outputCompression = intField(issues, "outputCompression", merged.outputCompression, 0, 100);
  const stream = boolField(issues, "stream", merged.stream) ?? GENERATION_DEFAULTS.stream;
  const partialImages = intField(issues, "partialImages", merged.partialImages, 0, 3);
  const user = typeof merged.user === "string" ? merged.user : merged.user === undefined ? undefined : String(merged.user);

  // ---- 跨字段规则 ----
  if ((quality === "xhigh" || quality === "max") && !isGptImage25(model)) {
    issues.push(
      `quality "${quality}" 仅 gpt-image-2.5 系列（sunburst/flare）支持，${model} 可用: auto / low / medium / high`,
    );
  }
  if (background === "transparent" && outputFormat === "jpeg") {
    issues.push('background "transparent" 不支持 jpeg 输出（透明通道请用 png 或 webp）');
  }
  if (outputCompression !== undefined && (outputFormat ?? "png") === "png") {
    issues.push("outputCompression 仅对 jpeg/webp 有效（当前输出格式为 png）");
  }
  if (partialImages !== undefined && !stream) {
    issues.push("partialImages 仅在 stream: true 时有意义（SSE 逐步精化预览）");
  }

  return {
    prompt: prompt ?? "",
    model,
    size,
    quality,
    n,
    background,
    moderation,
    stream,
    ...(outputFormat !== undefined ? { outputFormat } : {}),
    ...(outputCompression !== undefined ? { outputCompression } : {}),
    ...(partialImages !== undefined ? { partialImages } : {}),
    ...(user !== undefined ? { user } : {}),
  };
}

/**
 * 合并「显式参数 > fallback 中间层 > 内置默认」三层：归一化键名 → 未知/禁用键
 * 检查 → 分层合并 → 默认补缺。所有问题记入 issues（由调用方统一抛出）。
 */
function mergeLayers(
  params: Readonly<Record<string, unknown>>,
  fallbacks: GenerationFallbacks | undefined,
  knownKeys: readonly string[],
  issues: string[],
): Record<string, unknown> {
  const normalizedParams = normalizeKeys(params, issues);
  checkKeys(normalizedParams, knownKeys, issues);

  let fallbackLayer: Record<string, unknown> = {};
  if (fallbacks !== undefined) {
    const normalizedFallbacks = normalizeKeys(fallbacks, issues);
    checkKeys(normalizedFallbacks, knownKeys, issues);
    fallbackLayer = definedEntries(normalizedFallbacks);
  }

  const merged: Record<string, unknown> = {
    ...fallbackLayer,
    ...definedEntries(normalizedParams),
  };
  for (const [key, value] of Object.entries(GENERATION_DEFAULTS)) {
    if (!(key in merged)) merged[key] = value;
  }
  return merged;
}

/**
 * 合并、归一化并校验文生图参数。
 * 任何问题（含未知键、禁用参数）一次性收集后抛出 ImageParamError。
 */
export function resolveGenerationParams(
  params: GenerationParamsInput,
  fallbacks?: GenerationFallbacks,
): ResolvedGenerationParams {
  const issues: string[] = [];
  const merged = mergeLayers(params as Record<string, unknown>, fallbacks, KNOWN_GENERATION_KEYS, issues);
  const resolved = resolveGenerationKeys(merged, issues);
  if (issues.length > 0) throw new ImageParamError(issues);
  return resolved;
}

/**
 * 合并、归一化并校验图片编辑参数（= 文生图参数 + images/mask/inputFidelity）。
 */
export function resolveEditParams(
  params: EditParamsInput,
  fallbacks?: GenerationFallbacks,
): ResolvedEditParams {
  const issues: string[] = [];
  const merged = mergeLayers(params as Record<string, unknown>, fallbacks, KNOWN_EDIT_KEYS, issues);
  const generation = resolveGenerationKeys(merged, issues);
  const images = imagesField(issues, merged.images);
  const mask = imageFileField(issues, "mask", merged.mask);
  const inputFidelity = enumField(issues, "inputFidelity", merged.inputFidelity, [
    "high",
    "low",
  ] as const satisfies readonly InputFidelity[]);
  if (issues.length > 0) throw new ImageParamError(issues);

  return {
    ...generation,
    images: images ?? [],
    ...(mask !== undefined ? { mask } : {}),
    ...(inputFidelity !== undefined ? { inputFidelity } : {}),
  };
}

/** 供 env.ts 提前校验 fallback 层时复用。 */
export function isKnownModel(value: unknown): value is GptImageModelId {
  return (GPT_IMAGE_MODELS as readonly string[]).includes(String(value));
}

/** size 值是否合法（不抛错版本，用于 .env 预检）。 */
export function isValidSize(value: unknown): boolean {
  const issues: string[] = [];
  return sizeField(issues, value) !== undefined;
}

/** 把解析后的参数映射为 /v1/images/generations 的 JSON 请求体（snake_case，缺省键不发送）。 */
export function toGenerationRequestBody(p: ResolvedGenerationParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: p.model,
    prompt: p.prompt,
    n: p.n,
    background: p.background,
    moderation: p.moderation,
    stream: p.stream,
    size: formatSizeSpec(p.size),
    quality: p.quality,
  };
  if (p.outputFormat !== undefined) body.output_format = p.outputFormat;
  if (p.outputCompression !== undefined) body.output_compression = p.outputCompression;
  if (p.partialImages !== undefined) body.partial_images = p.partialImages;
  if (p.user !== undefined) body.user = p.user;
  return body;
}
