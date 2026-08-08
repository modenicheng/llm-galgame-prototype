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
import { removeMarkdownFence } from "../model-jsonl.js";
import { parseDslLine } from "./line-parser.js";
import { DslSegmentParser } from "./segment-validator.js";
import type {
  DslSegmentResult,
  EventGroupDraft,
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
  options: { expectedNonce: string; allowedReasons: readonly SegmentEndReason[] },
): DslSegmentResult {
  const parser = new DslSegmentParser(options);
  const groups: EventGroupDraft[] = [];

  const stripped = removeMarkdownFence(text);
  for (const rawLine of stripped.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line === "```") continue;
    const parsed = parseDslLine(line);
    const emitted = parser.pushLine(parsed);
    groups.push(...emitted);
  }

  const result = parser.finish();
  return { groups, status: result.status };
}
