/**
 * 滚动前情梗概（recap）纯函数：确定性摘要与追加/截断。
 *
 * 设计约束（2026-09-17 上下文审计）：
 * - 每个滑出窗口的 chunk 独立压缩成一条记录后追加，不把旧梗概喂回
 *   压缩器——避免滚动改写带来的复利漂移；事实保持可追溯到原文。
 * - 追加只做尾部截断（最老的记录先丢）：近期前情比开场前情更重要。
 * - 确定性摘要只挑"决策骨架"（交互提问 + 玩家选择/输入）和 chunk 的
 *   收尾行，不解读剧情——保真优先，解读交给 LLM 端口（可用时）。
 */
import type { StoredEvent } from "../schema.js";
import { serializeStoryContext } from "./context-builder.js";

/** recap 文本的总长度上限：更早的记录被截掉（按整行丢弃）。
 * 2026-09-19 从 600 放宽——细节优先的前情梗概单条即可到 500 字。 */
export const RECAP_MAX_CHARS = 1800;

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized;
}

/**
 * 确定性摘要（LLM 不可用或失败时的回退，也可独立使用）：
 * 保留 [交互]/[玩家] 行（决策骨架）与 chunk 最后一条文本行（剧情落点），
 * 分号连接成单行。
 */
export function deterministicRecapDigest(
  events: readonly StoredEvent[],
): string {
  const text = serializeStoryContext([...events]);
  if (text.trim() === "") return "";
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const picked: string[] = [];
  let lastTextLine = "";
  for (const line of lines) {
    if (line.startsWith("[交互]") || line.startsWith("[玩家]")) {
      picked.push(truncate(line, 80));
    } else {
      lastTextLine = line;
    }
  }
  if (lastTextLine !== "") {
    picked.push(truncate(lastTextLine, 120));
  }
  const digest = picked.join("；");
  return digest === "" ? "" : truncate(digest, 360);
}

/**
 * 追加一条新记录并维持总长上限：超限时从头部整行丢弃（保留更近的
 * 前情）；截断后以 "…" 开头表示有过丢弃。单行超长时硬截。
 */
export function appendRecap(
  previous: string,
  digest: string,
  maxChars: number = RECAP_MAX_CHARS,
): string {
  const prev = previous.trim();
  const next = prev === "" ? digest.trim() : `${prev}\n${digest.trim()}`;
  if (next.length <= maxChars) return next;

  let tail = next.slice(next.length - maxChars);
  const firstNewline = tail.indexOf("\n");
  if (firstNewline === -1) {
    // 整段没有换行（单条巨长记录）：硬截并标记。
    return `…${tail}`;
  }
  tail = tail.slice(firstNewline + 1);
  return tail.startsWith("…") ? tail : `…${tail}`;
}
