/**
 * image-gen — gpt-image-2 / 2.5 的 HTTP 客户端（OpenAI Images API 兼容形态）。
 *
 * 设计要点：
 *  - 原生 fetch + 手工组装请求体（generations 用 JSON，edits 用 multipart），
 *    不经 SDK，保证新参数（input_fidelity / xhigh 等）可完整透传；
 *  - 所有入参先经 validate.ts 校验，非法参数在本地抛 ImageParamError，绝不发出；
 *  - 429/5xx/网络错误按指数退避重试（默认 2 次），4xx 业务错误不重试；
 *  - stream=true 走 SSE：partial_image 事件逐张抛出，completed 事件收敛为最终结果；
 *  - fetchImpl / sleepImpl 可注入，单测全程无网络。
 *
 * 约定：baseUrl 填到 /v1 这一层（如 https://api.openai.com/v1，兼容中转站）；
 * 裸域名（无路径）自动补 /v1。
 */

import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  resolveEditParams,
  resolveGenerationParams,
  toGenerationRequestBody,
} from "./validate.js";
import { formatSizeSpec } from "./types.js";
import type {
  GeneratedImage,
  GenerationParamsInput,
  EditParamsInput,
  ImageFileInput,
  ImageGenResult,
  ImageStreamEvent,
  ImageUsage,
  ResolvedEditParams,
  ResolvedGenerationParams,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** 图像生成耗时波动大（xhigh 大图可超 2 分钟），默认放宽到 5 分钟。 */
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_RETRIES = 2;

const GENERATIONS_PATH = "/images/generations";
const EDITS_PATH = "/images/edits";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

/** API / 网络层失败。`status` 为 HTTP 状态码（0 = 未能拿到响应，如网络中断）。 */
export class ImageApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(status: number, message: string, code?: string, requestId?: string) {
    super(message);
    this.name = "ImageApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

export interface ImageGenClientOptions {
  apiKey: string;
  /** 填到 /v1 这一层；缺省 https://api.openai.com/v1。 */
  baseUrl?: string;
  /** 单次请求超时（含重试各次独立计时）。缺省 300000。 */
  timeoutMs?: number;
  /** 429/5xx/网络错误的最大重试次数。缺省 2。 */
  maxRetries?: number;
  /** Injectable fetch implementation for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleep for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface ImageGenClient {
  /** 文生图；stream=true 时内部消费 SSE 并只返回最终结果。 */
  generate(params: GenerationParamsInput): Promise<ImageGenResult>;
  /** 图片编辑（垫图 / mask / input_fidelity）。 */
  edit(params: EditParamsInput): Promise<ImageGenResult>;
  /** 文生图流式版本：强制 stream=true，逐个 yield partial / completed 事件。 */
  generateStream(params: GenerationParamsInput): AsyncGenerator<ImageStreamEvent>;
  /** 图片编辑流式版本。 */
  editStream(params: EditParamsInput): AsyncGenerator<ImageStreamEvent>;
}

/** 规范化 baseUrl：去尾斜杠；裸域名（无路径）按 OpenAI 惯例补 /v1。 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new ImageApiError(0, "baseUrl 不能为空（应填到 /v1 这一层，如 https://api.openai.com/v1）");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ImageApiError(0, `baseUrl 不是合法 URL: ${input}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ImageApiError(0, `baseUrl 必须以 http(s):// 开头，收到: ${input}`);
  }
  return url.pathname === "" || url.pathname === "/" ? `${trimmed}/v1` : trimmed;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 非 2xx 响应 → ImageApiError（解析服务端 error.message / type / code）。 */
async function toApiError(res: Response): Promise<ImageApiError> {
  const text = await res.text().catch(() => "");
  let message = text;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown; type?: unknown; code?: unknown };
      message?: unknown;
    };
    const serverError = parsed.error;
    if (typeof serverError?.message === "string") message = serverError.message;
    else if (typeof parsed.message === "string") message = parsed.message;
    if (typeof serverError?.type === "string") code = serverError.type;
    else if (typeof serverError?.code === "string") code = serverError.code;
  } catch {
    // 非 JSON 错误体，保留原文
  }
  const requestId = res.headers.get("x-request-id") ?? undefined;
  return new ImageApiError(
    res.status,
    `HTTP ${res.status}${code !== undefined ? ` [${code}]` : ""}: ${message.length > 0 ? message : "(空响应)"}`,
    code,
    requestId,
  );
}

const imageUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});

const imageResponseSchema = z.object({
  created: z.number().optional(),
  data: z
    .array(
      z.object({
        b64_json: z.string().optional(),
        url: z.string().optional(),
        revised_prompt: z.string().optional(),
      }),
    )
    .min(1),
  usage: imageUsageSchema.optional(),
});

function toUsage(raw: z.infer<typeof imageUsageSchema> | undefined): ImageUsage | undefined {
  if (raw === undefined) return undefined;
  return {
    ...(raw.input_tokens !== undefined ? { inputTokens: raw.input_tokens } : {}),
    ...(raw.output_tokens !== undefined ? { outputTokens: raw.output_tokens } : {}),
    ...(raw.total_tokens !== undefined ? { totalTokens: raw.total_tokens } : {}),
  };
}

/** 响应 JSON → ImageGenResult（b64_json 解码为 bytes）。 */
function toResult(json: unknown, resolved: ResolvedGenerationParams): ImageGenResult {
  const parsed = imageResponseSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.path.join(".") || "root").join(", ");
    throw new ImageApiError(200, `响应结构不符合 Images API 预期（字段: ${detail}）`);
  }
  const images: GeneratedImage[] = parsed.data.data.map((item) => {
    if (typeof item.b64_json !== "string" || item.b64_json.length === 0) {
      throw new ImageApiError(
        200,
        "响应项缺少 b64_json（gpt-image 系列固定返回 base64 数据；若使用中转请确认其未改写响应结构，或关闭了 b64 转发）",
      );
    }
    return {
      bytes: Buffer.from(item.b64_json, "base64"),
      format: resolved.outputFormat ?? "png",
      ...(item.revised_prompt !== undefined ? { revisedPrompt: item.revised_prompt } : {}),
    };
  });
  const usage = toUsage(parsed.data.usage);
  return {
    model: resolved.model,
    size: resolved.size,
    images,
    ...(usage !== undefined ? { usage } : {}),
    ...(parsed.data.created !== undefined ? { created: parsed.data.created } : {}),
  };
}

/* ------------------------------ SSE 解析 ------------------------------ */

/** 找到下一个 SSE 块边界（空行），返回块结束位置与下一块起点。 */
function findBlockBoundary(text: string): { end: number; next: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(text);
  if (match === null || match.index === undefined) return null;
  return { end: match.index, next: match.index + match[0].length };
}

/** 提取一个 SSE 块内的 data 载荷（多行 data 按规范以 \n 连接；event:/注释行忽略）。 */
function extractDataPayload(block: string): string | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

/** 把 SSE 字节流解析为 data 载荷序列。 */
async function* parseSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = findBlockBoundary(buffer);
        if (boundary === null) break;
        const payload = extractDataPayload(buffer.slice(0, boundary.end));
        buffer = buffer.slice(boundary.next);
        if (payload !== null) yield payload;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const payload = extractDataPayload(buffer);
      if (payload !== null) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

/* ------------------------------ 客户端 ------------------------------ */

interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: BodyInit;
}

function toBlobPart(data: Uint8Array): BlobPart {
  // TS 5.7+ 的 Uint8Array<ArrayBufferLike> 与 BlobPart 的协变差异需要一次窄化。
  return data as unknown as BlobPart;
}

function toBlob(file: ImageFileInput): Blob {
  return new Blob([toBlobPart(file.data)], { type: file.contentType });
}

function buildEditFormData(resolved: ResolvedEditParams): FormData {
  const form = new FormData();
  form.append("model", resolved.model);
  form.append("prompt", resolved.prompt);
  form.append("n", String(resolved.n));
  form.append("background", resolved.background);
  form.append("moderation", resolved.moderation);
  form.append("stream", String(resolved.stream));
  form.append("size", formatSizeSpec(resolved.size));
  form.append("quality", resolved.quality);
  if (resolved.outputFormat !== undefined) form.append("output_format", resolved.outputFormat);
  if (resolved.outputCompression !== undefined) {
    form.append("output_compression", String(resolved.outputCompression));
  }
  if (resolved.partialImages !== undefined) {
    form.append("partial_images", String(resolved.partialImages));
  }
  if (resolved.user !== undefined) form.append("user", resolved.user);
  if (resolved.inputFidelity !== undefined) form.append("input_fidelity", resolved.inputFidelity);
  for (const image of resolved.images) {
    form.append("image[]", toBlob(image), image.filename);
  }
  if (resolved.mask !== undefined) {
    form.append("mask", toBlob(resolved.mask), resolved.mask.filename);
  }
  return form;
}

/**
 * 创建图像生成客户端。所有方法入参先经本地校验，非法参数抛 ImageParamError
 * （不会发出网络请求）。
 */
export function createImageClient(options: ImageGenClientOptions): ImageGenClient {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new ImageApiError(0, "apiKey 不能为空（.env 中配置 IMAGE_GEN_API_KEY）");
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleepImpl ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ImageApiError(0, `timeoutMs 必须是正数，收到 ${options.timeoutMs}`);
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new ImageApiError(0, `maxRetries 必须是非负整数，收到 ${options.maxRetries}`);
  }

  const authHeaders = {
    Authorization: `Bearer ${options.apiKey.trim()}`,
  };

  /** 发送请求：429/5xx/网络错误指数退避重试；非 2xx 终态转为 ImageApiError。 */
  async function sendWithRetry(prepare: () => PreparedRequest): Promise<Response> {
    const attempts = maxRetries + 1;
    let lastNetworkError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const request = prepare();
      let response: Response;
      try {
        response = await fetchImpl(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastNetworkError = error;
        if (attempt < attempts - 1) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        break;
      }
      if (response.ok) return response;
      if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts - 1) {
        throw await toApiError(response);
      }
      await sleep(backoffDelay(attempt));
    }
    throw new ImageApiError(
      0,
      `网络请求失败（已尝试 ${attempts} 次）: ${errMessage(lastNetworkError)}`,
    );
  }

  function backoffDelay(attempt: number): number {
    return Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  }

  async function generateJson(
    resolved: ResolvedGenerationParams,
  ): Promise<ImageGenResult> {
    const response = await sendWithRetry(() => ({
      url: `${baseUrl}${GENERATIONS_PATH}`,
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(toGenerationRequestBody(resolved)),
    }));
    const json: unknown = await response.json().catch(() => {
      throw new ImageApiError(response.status, "成功响应但 body 不是合法 JSON");
    });
    return toResult(json, resolved);
  }

  async function editJson(resolved: ResolvedEditParams): Promise<ImageGenResult> {
    const form = buildEditFormData(resolved);
    const response = await sendWithRetry(() => ({
      url: `${baseUrl}${EDITS_PATH}`,
      headers: { ...authHeaders },
      body: form,
    }));
    const json: unknown = await response.json().catch(() => {
      throw new ImageApiError(response.status, "成功响应但 body 不是合法 JSON");
    });
    return toResult(json, resolved);
  }

  /** SSE 流：partial 事件逐个抛出，completed 事件收敛并结束。 */
  async function* streamEvents(
    resolved: ResolvedGenerationParams,
    path: string,
    form?: FormData,
  ): AsyncGenerator<ImageStreamEvent> {
    const response = await sendWithRetry(() =>
      form === undefined
        ? {
            url: `${baseUrl}${path}`,
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify(toGenerationRequestBody(resolved)),
          }
        : {
            url: `${baseUrl}${path}`,
            headers: { ...authHeaders },
            body: form,
          },
    );
    if (response.body === null) {
      throw new ImageApiError(response.status, "响应没有 body，无法读取 SSE 流");
    }
    let partialSeen = 0;
    for await (const payload of parseSseData(response.body)) {
      if (payload === "[DONE]") break;
      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        throw new ImageApiError(200, `SSE 事件不是合法 JSON: ${payload.slice(0, 200)}`);
      }
      const record = event as {
        type?: unknown;
        b64_json?: unknown;
        partial_image_index?: unknown;
        usage?: unknown;
        code?: unknown;
        message?: unknown;
      };

      if (record.type === "error" || (record.code !== undefined && record.type === undefined)) {
        const message =
          typeof record.message === "string" ? record.message : JSON.stringify(payload).slice(0, 200);
        const code = typeof record.code === "string" ? record.code : undefined;
        throw new ImageApiError(500, `流式生成失败: ${message}`, code);
      }
      if (record.type === "image_generation.partial_image") {
        if (typeof record.b64_json !== "string" || record.b64_json.length === 0) {
          throw new ImageApiError(200, "partial_image 事件缺少 b64_json");
        }
        const index =
          typeof record.partial_image_index === "number" ? record.partial_image_index : partialSeen;
        partialSeen += 1;
        yield { type: "partial", index, bytes: Buffer.from(record.b64_json, "base64") };
        continue;
      }
      if (record.type === "image_generation.completed") {
        if (typeof record.b64_json !== "string" || record.b64_json.length === 0) {
          throw new ImageApiError(200, "completed 事件缺少 b64_json");
        }
        const usageRaw = imageUsageSchema.safeParse(record.usage);
        const usage = usageRaw.success ? toUsage(usageRaw.data) : undefined;
        const image: GeneratedImage = {
          bytes: Buffer.from(record.b64_json, "base64"),
          format: resolved.outputFormat ?? "png",
        };
        const result: ImageGenResult = {
          model: resolved.model,
          size: resolved.size,
          images: [image],
          ...(usage !== undefined ? { usage } : {}),
        };
        yield { type: "completed", result };
        return;
      }
      // 未知事件类型：忽略（向前兼容）
    }
    throw new ImageApiError(200, "SSE 流在 completed 事件之前结束");
  }

  async function collectStream(
    resolved: ResolvedGenerationParams,
    path: string,
    form?: FormData,
  ): Promise<ImageGenResult> {
    let result: ImageGenResult | undefined;
    for await (const event of streamEvents(resolved, path, form)) {
      if (event.type === "completed") result = event.result;
    }
    if (result === undefined) {
      throw new ImageApiError(200, "流式响应未返回最终图像");
    }
    return result;
  }

  return {
    async generate(params) {
      const resolved = resolveGenerationParams(params);
      if (!resolved.stream) return generateJson(resolved);
      // stream=true 的非流式调用：内部消费 SSE，丢弃部分图，仅返回最终结果。
      return collectStream(resolved, GENERATIONS_PATH);
    },

    async edit(params) {
      const resolved = resolveEditParams(params);
      if (!resolved.stream) return editJson(resolved);
      return collectStream(resolved, EDITS_PATH, buildEditFormData(resolved));
    },

    async *generateStream(params) {
      const resolved = resolveGenerationParams({ ...params, stream: true });
      yield* streamEvents(resolved, GENERATIONS_PATH);
    },

    async *editStream(params) {
      const resolved = resolveEditParams({ ...params, stream: true });
      yield* streamEvents(resolved, EDITS_PATH, buildEditFormData(resolved));
    },
  };
}
