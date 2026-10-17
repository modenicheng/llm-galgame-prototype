/**
 * 音乐缓存键（动态音乐生成）：谱面指纹 + 渲染器版本。
 *
 * 浏览器端「缓存的是乐谱而不是音频」——渲染器确定性（同谱同版本 =
 * 同音频），重渲染秒级，因此键只需标识谱面与渲染行为。渲染器任何影响
 * 输出的改动（采样映射/包络/混响/折叠）必须升 MUSIC_RENDERER_VERSION
 * 使旧谱缓存失效。
 */
import { createHash } from "node:crypto";
import type { MusicScore } from "../../shared/music/score.js";

export const MUSIC_RENDERER_VERSION = 2;

/** 递归按键名排序的规范序列化（模型 JSON 键序不稳定，语义同谱必须同键）。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function musicCacheKey(score: MusicScore): string {
  return createHash("sha256")
    .update(`music-v${MUSIC_RENDERER_VERSION}`)
    .update("\0")
    .update(canonicalJson(score))
    .digest("hex")
    .slice(0, 32);
}
