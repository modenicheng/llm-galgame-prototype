/**
 * Gal DSL whole-text pipeline — parses one complete model response body
 * (docs/llm-outputs-refactor.md §40–§51).
 *
 * Streaming consumers (the LLM adapter) feed lines one at a time through
 * parseDslLine + DslSegmentParser; this module wraps that same pipeline for
 * callers that already have the full text (tests, whole-text fallbacks).
 *
 * Pure text processing: no runtime, wire, or LLM dependencies.
 */

/** Strip a markdown fence (```json/```jsonl/```) around a model payload. */
export function removeMarkdownFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:jsonl|json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}
import { parseDslLine, parseDslV2Line } from "./line-parser.js";
import { DslSegmentParser, DslSegmentParserV2 } from "./segment-validator.js";
import type {
  DslSegmentResult,
  DslSegmentResultV2,
  EventGroupDraft,
  EventGroupDraftV2,
  SegmentEndReason,
} from "./types.js";

/**
 * Parse a full DSL segment text into committed groups + end status.
 *
 * - Strips a surrounding markdown fence (```json / ```jsonl / ```).
 * - Splits on /\r?\n/, trims each line, drops empties and bare "```" lines.
 * - Feeds each line through parseDslLine + DslSegmentParser.pushLine;
 *   DslProtocolError propagates as-is (the message doubles as the repair
 *   instruction, docs §8.5).
 * - finish() decides complete vs truncated.
 */
export function parseDslSegmentText(
  text: string,
  options: {
    expectedNonce: string;
    allowedReasons: readonly SegmentEndReason[];
    /** Registered speaker names — gates full-width-colon normalization. */
    knownSpeakers?: ReadonlySet<string>;
  },
): DslSegmentResult {
  const parser = new DslSegmentParser(options);
  const groups: EventGroupDraft[] = [];

  const stripped = removeMarkdownFence(text);
  for (const rawLine of stripped.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line === "```") continue;
    const parsed = parseDslLine(line, options.knownSpeakers);
    const emitted = parser.pushLine(parsed);
    groups.push(...emitted);
  }

  const result = parser.finish();
  return { groups, status: result.status };
}

/**
 * Parse a full v2 DSL segment text into draft groups + end status（C4）。
 *
 * 与 parseDslSegmentText 同一行切分规则（去围栏、/\r?\n/、去空行与裸 ``` 行），
 * 但逐行走 parseDslV2Line + DslSegmentParserV2——v2 请求永不进入 v1 语法。
 * 语义编译（能力校验/身份校验/原子提交）在 compiler.compileSegmentV2；
 * 本入口只做解析与分组（整文回放/测试向量用）。
 */
export function parseDslSegmentTextV2(
  text: string,
  options: {
    expectedNonce: string;
    allowedReasons: readonly SegmentEndReason[];
  },
): { groups: EventGroupDraftV2[]; status: DslSegmentResultV2["status"] } {
  const parser = new DslSegmentParserV2(options);
  const groups: EventGroupDraftV2[] = [];

  const stripped = removeMarkdownFence(text);
  let lineIndex = 0;
  for (const rawLine of stripped.split(/\r?\n/)) {
    lineIndex += 1;
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line === "```") continue;
    const parsed = parseDslV2Line(line);
    const emitted = parser.pushLine({ ...parsed, lineIndex: lineIndex - 1 });
    for (const group of emitted) {
      group.source = { attemptId: "attempt:0", lineIndex: lineIndex - 1 };
    }
    groups.push(...emitted);
  }

  const result = parser.finish();
  return { groups, status: result.status };
}
