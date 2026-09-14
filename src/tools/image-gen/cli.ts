/**
 * image-gen CLI — gpt-image-2 / 2.5 生成与编辑的命令行入口（core 之上的薄兼容层）。
 *
 * 用法（在仓库根目录）：
 *   npm run image -- generate "<提示词>" [选项]
 *   npm run image -- edit "<提示词>" --image <图片路径> [--image ...] [选项]
 *   npm run image -- help
 *
 * 退出码：0 成功；2 参数/配置错误（未发出网络请求）；1 API/网络错误。
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import process from "node:process";
import {
  createImageClient,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  ImageApiError,
} from "./client.js";
import { loadEnvConfig } from "./env.js";
import { defaultBasename, loadImageFile, saveImages, savePartialImages } from "./files.js";
import { ImageParamError, MAX_EDIT_IMAGES, resolveGenerationParams } from "./validate.js";
import type {
  EditParamsInput,
  GenerationParamsInput,
  ImageFileInput,
  ImageGenResult,
  ImageStreamEvent,
  ImageUsage,
} from "./types.js";

const USAGE = `image-gen — gpt-image-2 / 2.5 图像生成工具

用法:
  npm run image -- generate "<提示词>" [选项]
  npm run image -- edit    "<提示词>" --image <图片路径> [--image ...] [选项]
  npm run image -- help

共用选项（未提供时按 .env 可选默认值 > 内置默认 回退）:
  --model <id>            gpt-image-2 | gpt-image-2.5-sunburst | gpt-image-2.5-flare（含日期快照，默认 gpt-image-2）
  --size <WxH|auto>       auto（默认）/ 1024x1024 / 1536x1024 / 1024x1536 / 任意 16 倍数尺寸（≤3840x2160，宽高比 1:3~3:1）
  --quality <档位>        auto | low | medium | high；xhigh / max 仅 2.5 系列
  --n <1-10>              生成张数（默认 1）
  --background <模式>     auto | transparent | opaque
  --format <png|jpeg|webp>
  --compression <0-100>   仅 jpeg/webp 有效
  --moderation <low|auto>
  --stream                流式（SSE 逐步精化，配合 --partial-images 0-3）
  --save-partials         保存部分图预览（仅流式有效）
  --user <标识>           终端用户标识
  --out <目录>            输出目录（默认 output/image-gen 或 IMAGE_GEN_OUTPUT_DIR）
  --timeout <毫秒>        单次请求超时（默认 300000）
  --retries <次数>        429/5xx 重试次数（默认 2）

edit 专属选项:
  --image <路径>          参考图（png/jpg/webp，可重复，最多 ${MAX_EDIT_IMAGES} 张）
  --mask <路径>           mask 图（透明区域为重绘区）
  --input-fidelity <h|l>  input_fidelity high | low（对参考图的高保真程度）

示例:
  npm run image -- generate "雨夜校园天台，少女回望镜头，赛璐璐风格" --size 1024x1536 --quality high
  npm run image -- generate "角色立绘" --background transparent --format png --n 2
  npm run image -- edit "把背景换成黄昏" --image ./photo.png --input-fidelity high
`;

interface SharedValues {
  model?: string;
  size?: string;
  quality?: string;
  n?: string;
  background?: string;
  format?: string;
  compression?: string;
  moderation?: string;
  stream: boolean;
  "partial-images"?: string;
  user?: string;
  out?: string;
  timeout?: string;
  retries?: string;
  "save-partials": boolean;
}

interface EditValues extends SharedValues {
  image?: string[];
  mask?: string;
  "input-fidelity"?: string;
}

const sharedOptions = {
  model: { type: "string" },
  size: { type: "string" },
  quality: { type: "string" },
  n: { type: "string" },
  background: { type: "string" },
  format: { type: "string" },
  compression: { type: "string" },
  moderation: { type: "string" },
  stream: { type: "boolean", default: false },
  "partial-images": { type: "string" },
  user: { type: "string" },
  out: { type: "string" },
  timeout: { type: "string" },
  retries: { type: "string" },
  "save-partials": { type: "boolean", default: false },
} as const;

const editOptions = {
  ...sharedOptions,
  image: { type: "string", multiple: true },
  mask: { type: "string" },
  "input-fidelity": { type: "string" },
} as const;

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** parseArgs 包装：未知 flag / 缺值 → ImageParamError（退出码 2，不发请求）。 */
function parseCli(
  options: NonNullable<Parameters<typeof parseArgs>[0]>["options"],
  argv: string[],
): { values: Record<string, unknown>; positionals: string[] } {
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: true });
    return { values: parsed.values as Record<string, unknown>, positionals: parsed.positionals };
  } catch (error) {
    throw new ImageParamError([`命令行参数错误: ${errMessage(error)}`, "用法见: npm run image -- help"]);
  }
}

function parseGenerate(argv: string[]): { values: SharedValues; positionals: string[] } {
  const parsed = parseCli(sharedOptions, argv);
  return { values: parsed.values as unknown as SharedValues, positionals: parsed.positionals };
}

function parseEdit(argv: string[]): { values: EditValues; positionals: string[] } {
  const parsed = parseCli(editOptions, argv);
  return { values: parsed.values as unknown as EditValues, positionals: parsed.positionals };
}

function requirePrompt(positionals: readonly string[]): string {
  if (positionals.length !== 1) {
    throw new ImageParamError([
      `需要恰好 1 个提示词位置参数，收到 ${positionals.length} 个`,
      '示例: npm run image -- generate "雨夜校园天台" --size 1024x1536',
    ]);
  }
  return positionals[0] ?? "";
}

function intOption(label: string, raw: string | undefined, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < min) {
    throw new ImageParamError([`${label} 必须是不小于 ${min} 的整数，收到 "${raw}"`]);
  }
  return Number(trimmed);
}

function baseParams(values: SharedValues, prompt: string): GenerationParamsInput {
  return {
    prompt,
    model: values.model,
    size: values.size,
    quality: values.quality,
    n: values.n,
    background: values.background,
    moderation: values.moderation,
    outputFormat: values.format,
    outputCompression: values.compression,
    stream: values.stream,
    partialImages: values["partial-images"],
    user: values.user,
  };
}

function formatUsage(usage: ImageUsage | undefined): string | null {
  if (usage === undefined) return null;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`input=${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`output=${usage.outputTokens}`);
  if (usage.totalTokens !== undefined) parts.push(`total=${usage.totalTokens}`);
  return parts.length > 0 ? `tokens: ${parts.join(" ")}` : null;
}

async function reportResult(result: ImageGenResult, outDir: string, baseName?: string): Promise<void> {
  const name = baseName ?? defaultBasename(result.model, result.size);
  const paths = await saveImages(result.images, outDir, name);
  for (const filePath of paths) console.log(`已保存: ${filePath}`);
  for (const image of result.images) {
    if (image.revisedPrompt !== undefined) console.log(`revised prompt: ${image.revisedPrompt}`);
  }
  const usage = formatUsage(result.usage);
  if (usage !== null) console.log(usage);
}

async function consumeStream(
  stream: AsyncGenerator<ImageStreamEvent>,
  outDir: string,
  baseName: string,
  savePartials: boolean,
): Promise<ImageGenResult> {
  const partials: Uint8Array[] = [];
  for await (const event of stream) {
    if (event.type === "partial") {
      partials.push(event.bytes);
      console.error(`  已收到部分图 #${event.index + 1}（约 ${Math.round(event.bytes.length / 1024)} KB）`);
      continue;
    }
    if (savePartials && partials.length > 0) {
      const partialPaths = await savePartialImages(partials, outDir, baseName);
      for (const partialPath of partialPaths) console.error(`  部分图已保存: ${partialPath}`);
    }
    return event.result;
  }
  throw new ImageApiError(200, "流式响应未返回最终图像");
}

async function runGenerate(argv: string[]): Promise<void> {
  const { values, positionals } = parseGenerate(argv);
  const prompt = requirePrompt(positionals);
  const env = loadEnvConfig();
  const client = createImageClient({
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    timeoutMs: intOption("--timeout", values.timeout, 1) ?? env.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: intOption("--retries", values.retries, 0) ?? env.maxRetries ?? DEFAULT_MAX_RETRIES,
  });
  const params = baseParams(values, prompt);
  const outDir = values.out ?? env.outputDir;

  if (!values.stream) {
    await reportResult(await client.generate(params), outDir);
    return;
  }
  // 先解析一次以确定输出文件名前缀（client 内部会再校验一次，双保险）。
  const resolved = resolveGenerationParams(params, env.fallbacks);
  const baseName = defaultBasename(resolved.model, resolved.size);
  console.error(`流式生成中… model=${resolved.model} size=${values.size ?? resolved.size}`);
  const result = await consumeStream(
    client.generateStream(params),
    outDir,
    baseName,
    values["save-partials"],
  );
  await reportResult(result, outDir, baseName);
}

async function runEdit(argv: string[]): Promise<void> {
  const { values, positionals } = parseEdit(argv);
  const prompt = requirePrompt(positionals);
  const env = loadEnvConfig();
  const client = createImageClient({
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    timeoutMs: intOption("--timeout", values.timeout, 1) ?? env.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: intOption("--retries", values.retries, 0) ?? env.maxRetries ?? DEFAULT_MAX_RETRIES,
  });

  const imagePaths = values.image ?? [];
  if (imagePaths.length === 0) {
    throw new ImageParamError([
      `edit 需要 --image <图片路径>（png/jpg/webp，可重复提供，最多 ${MAX_EDIT_IMAGES} 张）`,
    ]);
  }
  const images: ImageFileInput[] = [];
  for (const imagePath of imagePaths) images.push(await loadImageFile(imagePath));
  const mask = values.mask !== undefined ? await loadImageFile(values.mask) : undefined;

  const params: EditParamsInput = {
    ...baseParams(values, prompt),
    images,
    ...(mask !== undefined ? { mask } : {}),
    inputFidelity: values["input-fidelity"],
  };
  const outDir = values.out ?? env.outputDir;

  if (!values.stream) {
    await reportResult(await client.edit(params), outDir);
    return;
  }
  const resolved = resolveGenerationParams(params, env.fallbacks);
  const baseName = defaultBasename(resolved.model, resolved.size);
  console.error(`流式编辑中… model=${resolved.model} images=${images.length}`);
  const result = await consumeStream(
    client.editStream(params),
    outDir,
    baseName,
    values["save-partials"],
  );
  await reportResult(result, outDir, baseName);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command === "generate") return runGenerate(rest);
  if (command === "edit") return runEdit(rest);
  console.error(`未知命令 "${command}"\n\n${USAGE}`);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  if (error instanceof ImageParamError) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (error instanceof ImageApiError) {
    console.error(`API 调用失败（status=${error.status}）: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.error(`未预期的错误: ${errMessage(error)}`);
  process.exitCode = 1;
});
