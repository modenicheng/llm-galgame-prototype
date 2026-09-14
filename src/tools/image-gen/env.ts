/**
 * image-gen — .env 配置加载（读 process.env，本身无副作用；
 * CLI 已 `import "dotenv/config"`，外部脚本调用前也需自行加载 dotenv）。
 *
 * 必填：
 *   IMAGE_GEN_BASE_URL — API 地址，填到 /v1 这一层（如 https://api.openai.com/v1）
 *   IMAGE_GEN_API_KEY  — API Key（.env 已被 .gitignore 忽略）
 *
 * 可选（作为参数默认回退的中间层，显式传参优先）：
 *   IMAGE_GEN_MODEL / IMAGE_GEN_SIZE / IMAGE_GEN_QUALITY
 *   IMAGE_GEN_TIMEOUT_MS / IMAGE_GEN_MAX_RETRIES / IMAGE_GEN_OUTPUT_DIR
 */

import { GPT_IMAGE_MODELS, type GptImageModelId } from "./types.js";
import { ImageParamError, isKnownModel, isValidSize } from "./validate.js";

export const DEFAULT_OUTPUT_DIR = "output/image-gen";

const KNOWN_QUALITIES: readonly string[] = ["auto", "low", "medium", "high", "xhigh", "max"];

export interface ImageGenEnvConfig {
  baseUrl: string;
  apiKey: string;
  /** 中间默认层（仅含 .env 中实际配置的项），传给 resolveParams 的 fallbacks。 */
  fallbacks: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
  maxRetries?: number;
  outputDir: string;
}

function trimEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value.trim() : undefined;
}

/** 解析非负整数字符串；空/未设返回 undefined，非法或小于 min 记入 issues。 */
function intEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  issues: string[],
  min: number,
): number | undefined {
  const raw = trimEnv(env, key);
  if (raw === undefined || raw.length === 0) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    issues.push(`${key} 必须是不小于 ${min} 的整数，收到 "${raw}"`);
    return undefined;
  }
  return Number(raw);
}

/**
 * 从环境变量读取配置；必填项缺失或可选项非法时抛 ImageParamError（问题一次列全）。
 * 可传入自定义 env 便于测试。
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): ImageGenEnvConfig {
  const issues: string[] = [];

  const baseUrl = trimEnv(env, "IMAGE_GEN_BASE_URL");
  if (baseUrl === undefined || baseUrl.length === 0) {
    issues.push(
      "缺少 IMAGE_GEN_BASE_URL（API 地址，填到 /v1 这一层，如 https://api.openai.com/v1；可复制 .env.example 为 .env 后填写）",
    );
  }
  const apiKey = trimEnv(env, "IMAGE_GEN_API_KEY");
  if (apiKey === undefined || apiKey.length === 0) {
    issues.push(
      "缺少 IMAGE_GEN_API_KEY（在仓库根目录 .env 中填写 API Key；.env 已被 .gitignore 忽略，不会入库）",
    );
  }

  const fallbacks: Record<string, unknown> = {};
  const model = trimEnv(env, "IMAGE_GEN_MODEL");
  if (model !== undefined && model.length > 0) {
    if (!isKnownModel(model)) {
      issues.push(
        `IMAGE_GEN_MODEL "${model}" 不是 gpt-image-2/2.5 系列模型（可用: ${GPT_IMAGE_MODELS.join(", ")}）`,
      );
    } else {
      fallbacks.model = model as GptImageModelId;
    }
  }
  const size = trimEnv(env, "IMAGE_GEN_SIZE");
  if (size !== undefined && size.length > 0) {
    if (!isValidSize(size)) {
      issues.push(`IMAGE_GEN_SIZE "${size}" 不合法（"auto" 或 "宽x高"，宽高须为 16 的倍数，如 1024x1536）`);
    } else {
      fallbacks.size = size;
    }
  }
  const quality = trimEnv(env, "IMAGE_GEN_QUALITY");
  if (quality !== undefined && quality.length > 0) {
    if (!KNOWN_QUALITIES.includes(quality)) {
      issues.push(`IMAGE_GEN_QUALITY "${quality}" 不合法（${KNOWN_QUALITIES.join(" / ")}；xhigh/max 仅 2.5 系列）`);
    } else {
      fallbacks.quality = quality;
    }
  }

  const timeoutMs = intEnv(env, "IMAGE_GEN_TIMEOUT_MS", issues, 1);
  const maxRetries = intEnv(env, "IMAGE_GEN_MAX_RETRIES", issues, 0);
  const outputDir = trimEnv(env, "IMAGE_GEN_OUTPUT_DIR");

  if (issues.length > 0) throw new ImageParamError(issues);

  return {
    baseUrl: baseUrl ?? "",
    apiKey: apiKey ?? "",
    fallbacks,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    outputDir: outputDir !== undefined && outputDir.length > 0 ? outputDir : DEFAULT_OUTPUT_DIR,
  };
}
