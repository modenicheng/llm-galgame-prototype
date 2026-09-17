import type { SegmentEndReason } from "./types.js";

const CHARACTER_POSITIONS: ReadonlySet<string> = new Set([
  "far_left",
  "left",
  "center",
  "right",
  "far_right",
]);

export interface DslClosingRepair {
  line: string;
  kind: "end_keyword";
}

/** 台词头槽位写反的修复结果：from/to 用于修复事件文案。 */
export interface DslVisualSwapRepair {
  line: string;
  kind: "visual_swap";
  from: string;
  to: string;
}

/**
 * Repair the observed, unambiguous manglings of the closing sentinel —
 * every real-world variant found in the 2026-09-17 session audit:
 *
 *   `@ <expected nonce> <allowed reason>`   end keyword omitted (spaced)
 *   `@<expected nonce> <allowed reason>`    end keyword omitted (glued to @)
 *   `@¬end <expected nonce> <reason>`       junk char before the keyword
 *   `@eend <expected nonce> <reason>`       keyword typo (letters only)
 *   `@end<expected nonce> <reason>`         keyword glued to the nonce
 *   `@el <expected nonce> <reason>`         keyword garbled beyond recall
 *
 * The match is anchored on BOTH the exact expected nonce and an allowed
 * reason — per-request random values no legitimate line carries — so any
 * `@… <nonce> <reason>` shape is safe to canonicalize. It never guesses a
 * nonce/reason, never touches a line without the leading `@`, and leaves
 * every other malformed or truncated line to the strict parser (missing
 * reason stays SENTINEL_MISSING_REASON: the reason is not derivable).
 */
export function repairDslClosingLine(
  raw: string,
  expectedNonce: string,
  allowedReasons: readonly SegmentEndReason[],
): DslClosingRepair | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("@")) return null;
  // Canonical sentinel: never a repair (it must not emit a repair event);
  // `@ end …` (keyword spaced from the @) deliberately does not match and
  // stays repairable below.
  if (/^@end\s+\S+\s+(?:buffer|interaction|ending)$/.test(trimmed)) return null;
  const match = /^@(.+)\s+(buffer|interaction|ending)$/.exec(trimmed);
  if (match === null) return null;
  const reason = match[2]! as SegmentEndReason;
  if (!allowedReasons.includes(reason)) return null;

  const head = match[1]!.trim();
  const canonical: DslClosingRepair = { line: `@end ${expectedNonce} ${reason}`, kind: "end_keyword" };

  // Case A — end omitted entirely: `@ <nonce> <reason>`.
  if (head === expectedNonce) return canonical;

  // Case B — `@<junk-keyword> <nonce> <reason>` (one or two tokens; the
  // keyword token may itself contain "end", be a typo of it, or be pure
  // junk). Safe: the nonce+reason pair is already sentinel-specific. An
  // exact `end` keyword is NOT junk — that is the canonical form and must
  // not emit a spurious repair event.
  const tokens = head.split(/\s+/);
  if (
    tokens.length === 2 &&
    tokens[1] === expectedNonce &&
    isJunkKeyword(tokens[0]!)
  ) {
    return canonical;
  }
  // Case C — keyword glued to the nonce in one token: `enda2ac`, `¬end81ab`.
  if (head.endsWith(expectedNonce)) {
    const prefix = head.slice(0, -expectedNonce.length);
    if (isJunkKeyword(prefix)) return canonical;
  }
  return null;
}

/**
 * Printable junk that can stand where the `end` keyword belonged: any short
 * run of non-space, non-digit, non-Han characters — ASCII typos (`eend`,
 * `el`), stray symbols (`¬end`), or the keyword itself. Digits are excluded
 * so a different nonce (`107b8`) can never masquerade as junk + nonce.
 */
function isJunkKeyword(token: string): boolean {
  return (
    token.length >= 1 &&
    token.length <= 6 &&
    /^[^\s\d]+$/u.test(token) &&
    !/\p{Script=Han}/u.test(token)
  );
}

/**
 * Repair the swapped dialogue-header bracket observed across seeds
 * (2026-09-17 sim audit): the model treats the variant slot as a
 * "whose sprite" slot and writes `raspberry[raspberry|smug]: …` — a
 * registered character id inside the bracket. An id can never be a variant
 * name, so dropping it is deterministic:
 *
 *   `苏遥[raspberry|smug]: …` → `苏遥[smug]: …`
 *   `苏遥[raspberry|left]: …` → `苏遥[|left]: …`
 *   `苏遥[raspberry]: …`      → `苏遥: …` (visual unchanged)
 *
 * Only an exact registered id in the FIRST slot triggers; every other
 * malformed bracket stays with the strict parser / catalog validation.
 */
export function repairSwappedVisualSlots(
  raw: string,
  knownSpeakers: ReadonlySet<string> | undefined,
): DslVisualSwapRepair | null {
  if (knownSpeakers === undefined || knownSpeakers.size === 0) return null;
  const line = raw.trim();
  // The name slot `(显示名)` may sit between the visual bracket and the
  // colon and must survive the repair verbatim.
  const match = /^([^\[\]:]{1,24})\[([^\[\]]*)\]((?:\([^)]*\))?(?:\s*:))/.exec(line);
  if (match === null) return null;
  const content = match[2]!;
  const segments = content.split("|");
  const first = segments[0]!;
  if (!knownSpeakers.has(first)) return null;
  const speaker = match[1]!;
  const tail = line.slice(match[0].length) ;
  if (segments.length === 2) {
    const rest = segments[1]!;
    // `[raspberry|]` — empty second slot is the forbidden all-empty form;
    // nothing deterministic to drop down to.
    if (rest === "") return null;
    // A position word keeps its slot semantics via the position-only form;
    // anything else becomes the variant.
    const normalized = CHARACTER_POSITIONS.has(rest) ? `|${rest}` : rest;
    return {
      kind: "visual_swap",
      line: `${speaker}[${normalized}]${match[3]}${tail}`,
      from: `[${content}]`,
      to: `[${normalized}]`,
    };
  }
  return {
    kind: "visual_swap",
    line: `${speaker}${match[3]}${tail}`,
    from: `[${content}]`,
    to: "(省略)",
  };
}

