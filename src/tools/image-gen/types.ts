/**
 * image-gen — gpt-image-2 / 2.5 图像生成工具的类型定义。
 *
 * 参数全集与规则依据 OpenAI Images API 参考（2026-09 核对）：
 *   POST {baseUrl}/images/generations — 文生图
 *   POST {baseUrl}/images/edits       — 垫图 / mask 局部重绘
 * gpt-image 系列固定返回 b64_json；`response_format` 与 `style` 为该系列
 * 不支持的参数（本工具在校验层直接拒绝，不发送）。
 *
 * 本模块零运行时依赖、零副作用，core/client/files 各层共用这些类型。
 */

/** gpt-image-2 / 2.5 系列模型 ID（含快照版）。 */
export const GPT_IMAGE_MODELS = [
  "gpt-image-2",
  "gpt-image-2-2026-04-21",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-sunburst-2026-09-08",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-flare-2026-09-08",
] as const;

export type GptImageModelId = (typeof GPT_IMAGE_MODELS)[number];

/** 是否为 2.5 系列（`xhigh` / `max` 画质仅 2.5 系列支持）。 */
export function isGptImage25(model: GptImageModelId): boolean {
  return model.startsWith("gpt-image-2.5");
}

export type ImageBackground = "transparent" | "opaque" | "auto";
export type ModerationLevel = "low" | "auto";
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type InputFidelity = "high" | "low";

/**
 * 服务端 quality 取值全集。注意：`xhigh` / `max` 仅 2.5 系列支持；
 * `hd` / `standard` 为 dall-e 系列专属，本工具不接受。
 */
export type ImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

/** 解析后的 size：`"auto"`，或显式宽高（须满足 ÷16、宽高比 1:3~3:1、≤3840×2160）。 */
export type ImageSizeSpec = "auto" | { readonly width: number; readonly height: number };

/** 把 size 规格序列化成 API 字符串（"auto" / "1024x1536"）。 */
export function formatSizeSpec(spec: ImageSizeSpec): string {
  return spec === "auto" ? "auto" : `${spec.width}x${spec.height}`;
}

/** 编辑接口的输入图片（内容已读入内存；core 不做文件 IO，路径读取见 files.ts）。 */
export interface ImageFileInput {
  readonly filename: string;
  /** MIME 类型，仅支持 image/png、image/jpeg、image/webp。 */
  readonly contentType: string;
  readonly data: Uint8Array;
}

/**
 * 文生图输入参数（宽松形态：允许 snake_case 别名与字符串数字，
 * 由 validate.ts 的 resolveGenerationParams 归一化并校验）。
 * 除 prompt 外全部可选，未提供的键按「显式参数 > fallback > 内置默认」回退。
 */
export type GenerationParamsInput = {
  [key: string]: unknown;
  prompt?: unknown;
  model?: unknown;
  size?: unknown;
  quality?: unknown;
  n?: unknown;
  background?: unknown;
  moderation?: unknown;
  outputFormat?: unknown;
  outputCompression?: unknown;
  stream?: unknown;
  partialImages?: unknown;
  user?: unknown;
};

/** 图片编辑输入参数 = 文生图参数 + 编辑专属参数。 */
export type EditParamsInput = GenerationParamsInput & {
  images?: unknown;
  mask?: unknown;
  inputFidelity?: unknown;
};

/** resolveParams 的中间默认层（如来自 .env），键同样走宽松归一化。 */
export type GenerationFallbacks = Readonly<Record<string, unknown>>;

/** 校验完毕、可直接映射为 API 请求体的参数。 */
export type ResolvedGenerationParams = {
  readonly prompt: string;
  readonly model: GptImageModelId;
  readonly size: ImageSizeSpec;
  readonly quality: ImageQuality;
  readonly n: number;
  readonly background: ImageBackground;
  readonly moderation: ModerationLevel;
  /** undefined = 不发送（服务端默认 png）。 */
  readonly outputFormat?: ImageOutputFormat;
  /** undefined = 不发送（仅 jpeg/webp 有意义，服务端默认 100）。 */
  readonly outputCompression?: number;
  readonly stream: boolean;
  /** 仅 stream=true 时有意义；undefined = 不发送。 */
  readonly partialImages?: number;
  readonly user?: string;
};

export type ResolvedEditParams = ResolvedGenerationParams & {
  readonly images: readonly ImageFileInput[];
  readonly mask?: ImageFileInput;
  readonly inputFidelity?: InputFidelity;
};

/** 单张生成结果（bytes 已从 b64_json 解码）。 */
export type GeneratedImage = {
  readonly bytes: Uint8Array;
  /** 落盘扩展名依据：显式 outputFormat，缺省 png（gpt-image 服务端默认）。 */
  readonly format: ImageOutputFormat;
  readonly revisedPrompt?: string;
};

export type ImageUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
};

export type ImageGenResult = {
  readonly model: GptImageModelId;
  readonly size: ImageSizeSpec;
  readonly images: readonly GeneratedImage[];
  readonly usage?: ImageUsage;
  readonly created?: number;
};

/** 流式（SSE）事件：部分图预览或最终完成。 */
export type ImageStreamEvent =
  | { readonly type: "partial"; readonly index: number; readonly bytes: Uint8Array }
  | { readonly type: "completed"; readonly result: ImageGenResult };
