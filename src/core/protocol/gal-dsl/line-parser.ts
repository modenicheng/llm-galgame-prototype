/**
 * Gal DSL line parser — parses ONE complete, already-trimmed line into a
 * DslLine (docs/llm-outputs-refactor.md §42).
 *
 * Grammar (in check order):
 *   @end <nonce> <reason>        → segment_end
 *   /?                            → form_end
 *   ? <prompt>                    → form_start
 *   + <text>                      → form_option
 *   = <placeholder>               → form_input
 *   beat                          → beat
 *   bg|bgm|se <id>                → background | bgm | sound_effect
 *   ch <id>:<variant> [position]  → character_cue set
 *   ch <id> hide|show             → character_cue hide|show
 *   <speaker>[<visual>](<name>): <text> → dialogue
 *   otherwise                     → narration
 *
 * Pure text → structured data. No runtime, wire, or LLM dependencies.
 */
import type { CharacterPosition } from "../../presentation/types.js";
import { DslProtocolError } from "./types.js";
import type {
  DialogueNameSpec,
  DialogueVisualSpec,
  DslLine,
  SegmentEndReason,
} from "./types.js";

const CHARACTER_POSITIONS: ReadonlySet<string> = new Set([
  "far_left",
  "left",
  "center",
  "right",
  "far_right",
]);

function isCharacterPosition(token: string): token is CharacterPosition {
  return CHARACTER_POSITIONS.has(token);
}

/** True when the line looks like `keyword` / `keyword <rest>` (reserved prefix). */
function hasKeywordPrefix(line: string, keyword: string): boolean {
  return line === keyword || line.startsWith(`${keyword} `) || line.startsWith(`${keyword}\t`);
}

/**
 * Parse the `[ ... ]` visual slot of a dialogue header (docs §8–§9, §12, §15).
 * Undefined → no visual slot. "" (`[]`) → visual reset. Otherwise
 * `[variant]`, `[spriteSet:variant]`, `[|position]`, `[spriteSet:variant|position]`.
 */
function parseVisual(content: string | undefined): DialogueVisualSpec {
  if (content === undefined) {
    return { hasVisual: false, resetVisual: false };
  }
  if (content === "") {
    return { hasVisual: true, resetVisual: true };
  }
  const segments = content.split("|");
  // At most one "|"; a trailing "|" (`[a|]`) or an all-empty slot (`[|]`)
  // is forbidden. `[|position]` is the ONE allowed empty-first form.
  if (segments.length > 2) {
    throw new DslProtocolError(
      "INVALID_VISUAL_BRACKET",
      `无效的视觉括号 "[${content}]"：只允许 [variant]、[spriteSet:variant]、[|position]、[spriteSet:variant|position] 或 []。`,
    );
  }
  const positionToken = segments[1];
  if (positionToken === "") {
    throw new DslProtocolError(
      "INVALID_VISUAL_BRACKET",
      `无效的视觉括号 "[${content}]"：只允许 [variant]、[spriteSet:variant]、[|position]、[spriteSet:variant|position] 或 []。`,
    );
  }
  const spec: DialogueVisualSpec = { hasVisual: true, resetVisual: false };
  const first = segments[0]!;
  if (first === "") {
    // `[|position]` — position-only form; positionToken must exist and be valid.
    if (positionToken === undefined || positionToken.includes(":")) {
      throw new DslProtocolError(
        "INVALID_VISUAL_BRACKET",
        `无效的视觉括号 "[${content}]"：位置段不能包含冒号。`,
      );
    }
    if (!isCharacterPosition(positionToken)) {
      throw new DslProtocolError(
        "INVALID_VISUAL_BRACKET",
        `无效的视觉括号 "[${content}]"：位置必须是 far_left|left|center|right|far_right。`,
      );
    }
    spec.position = positionToken;
    return spec;
  }
  const colonIndex = first.indexOf(":");
  if (colonIndex !== -1) {
    const spriteSet = first.slice(0, colonIndex);
    const variant = first.slice(colonIndex + 1);
    if (spriteSet === "" || variant === "" || variant.includes(":")) {
      throw new DslProtocolError(
        "INVALID_VISUAL_BRACKET",
        `无效的视觉括号 "[${content}]"：spriteSet:variant 中冒号必须恰好一个且两侧非空。`,
      );
    }
    spec.spriteSet = spriteSet;
    spec.variant = variant;
  } else {
    spec.variant = first;
  }
  if (positionToken !== undefined) {
    if (positionToken.includes(":")) {
      throw new DslProtocolError(
        "INVALID_VISUAL_BRACKET",
        `无效的视觉括号 "[${content}]"：位置段不能包含冒号。`,
      );
    }
    if (!isCharacterPosition(positionToken)) {
      throw new DslProtocolError(
        "INVALID_VISUAL_BRACKET",
        `无效的视觉括号 "[${content}]"：位置必须是 far_left|left|center|right|far_right。`,
      );
    }
    spec.position = positionToken;
  }
  return spec;
}

/**
 * Parse the `( ... )` name slot of a dialogue header (docs §10, §13).
 * Undefined → no name slot. "" (`()`) → name reset. Otherwise a display
 * name (non-empty after trim).
 */
function parseName(content: string | undefined): DialogueNameSpec {
  if (content === undefined) {
    return { hasName: false, resetName: false };
  }
  if (content === "") {
    return { hasName: true, resetName: true };
  }
  const displayName = content.trim();
  if (displayName === "") {
    throw new DslProtocolError(
      "INVALID_NAME_PAREN",
      `无效的名称括号 "(${content})"：只允许 (显示名) 或 () 复位。`,
    );
  }
  return { hasName: true, resetName: false, displayName };
}

/** Parse ONE complete DSL line into a DslLine. Throws DslProtocolError on violations. */
export function parseDslLine(rawLine: string): DslLine {
  // Callers are expected to trim, but be defensive (also strips "\r").
  const line = rawLine.trim();

  // 1. segment end sentinel: @end <nonce> <reason>
  const endMatch = /^@end\s+(\S+)(?:\s+(\S+))?\s*$/.exec(line);
  if (endMatch !== null) {
    const nonce = endMatch[1]!;
    const reasonToken = endMatch[2];
    if (reasonToken === undefined) {
      throw new DslProtocolError(
        "SENTINEL_MISSING_REASON",
        `@end 缺少 reason（buffer|interaction|ending）："${line}"。`,
      );
    }
    if (reasonToken !== "buffer" && reasonToken !== "interaction" && reasonToken !== "ending") {
      throw new DslProtocolError(
        "SENTINEL_INVALID_REASON",
        `@end 的 reason 必须是 buffer|interaction|ending，收到 "${reasonToken}"。`,
      );
    }
    const reason: SegmentEndReason = reasonToken;
    return { kind: "segment_end", nonce, reason };
  }

  // 2. form end (exact, before the `?` prefix check)
  if (line === "/?") return { kind: "form_end" };

  // 3–5. form prefixes: `?` / `+` / `=` then any whitespace, then the rest.
  // Empty rest is allowed here; the group builder rejects it later.
  if (line.startsWith("?")) return { kind: "form_start", prompt: line.slice(1).trim() };
  if (line.startsWith("+")) return { kind: "form_option", text: line.slice(1).trim() };
  if (line.startsWith("=")) return { kind: "form_input", placeholder: line.slice(1).trim() };

  // 6. beat
  if (line === "beat") return { kind: "beat" };

  // 7. stage cues: bg / bgm / se (bgm stop is a valid assetId "stop")
  const bgMatch = /^bg\s+(\S+)\s*$/.exec(line);
  if (bgMatch !== null) return { kind: "background", assetId: bgMatch[1]! };
  const bgmMatch = /^bgm\s+(\S+)\s*$/.exec(line);
  if (bgmMatch !== null) return { kind: "bgm", assetId: bgmMatch[1]! };
  const seMatch = /^se\s+(\S+)\s*$/.exec(line);
  if (seMatch !== null) return { kind: "sound_effect", assetId: seMatch[1]! };
  if (
    hasKeywordPrefix(line, "bg") ||
    hasKeywordPrefix(line, "bgm") ||
    hasKeywordPrefix(line, "se")
  ) {
    throw new DslProtocolError(
      "UNKNOWN_LINE",
      `无法解析的 bg/bgm/se 指令 "${line}"：缺少资源 id。`,
    );
  }

  // 8. character cue: ch <id>:<variant> [position] | ch <id> hide|show
  const chSetMatch = /^ch\s+(\S+):(\S+)(?:\s+(\S+))?\s*$/.exec(line);
  if (chSetMatch !== null) {
    const characterId = chSetMatch[1]!;
    const variant = chSetMatch[2]!;
    const positionToken = chSetMatch[3];
    if (positionToken !== undefined) {
      if (!isCharacterPosition(positionToken)) {
        throw new DslProtocolError(
          "INVALID_CH_CUE",
          `无效的 ch 位置 "${positionToken}"（ch <id>:<variant> [position]）。`,
        );
      }
      return {
        kind: "character_cue",
        characterId,
        variant,
        position: positionToken,
        action: "set",
      };
    }
    return { kind: "character_cue", characterId, variant, action: "set" };
  }
  const chShowMatch = /^ch\s+(\S+)\s+(hide|show|exit)\s*$/.exec(line);
  if (chShowMatch !== null) {
    const characterId = chShowMatch[1]!;
    const actionToken = chShowMatch[2]!;
    if (actionToken === "exit") {
      return { kind: "character_cue", characterId, action: "exit" };
    }
    const action: "hide" | "show" = actionToken === "hide" ? "hide" : "show";
    return { kind: "character_cue", characterId, action };
  }
  if (line.startsWith("ch")) {
    throw new DslProtocolError(
      "INVALID_CH_CUE",
      `无效的 ch 指令 "${line}"：格式为 ch <id>:<variant> [position] 或 ch <id> hide|show|exit。`,
    );
  }

  // 9. dialogue: <speaker>[<visual>](<name>): <text>
  // Only an ASCII ":" is the delimiter; a full-width "：" line falls through.
  const dialogueMatch = /^([^\[\]:]+?)(?:\[([^\]]*)\])?(?:\(([^)]*)\))?:\s?(.+)$/.exec(line);
  if (dialogueMatch !== null) {
    const speaker = dialogueMatch[1]!;
    const text = dialogueMatch[4]!;
    return {
      kind: "dialogue",
      speaker,
      text,
      visual: parseVisual(dialogueMatch[2]),
      name: parseName(dialogueMatch[3]),
    };
  }

  // 10. narration
  return { kind: "narration", text: line };
}
