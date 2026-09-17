/**
 * DSL tokenizer — presentation layer over the CORE line parser.
 *
 * Grammar classification is single-sourced: `parseDslLine` (core, the same
 * function the runtime uses, knownSpeakers included) decides what a line
 * IS; this module only slices the raw line into colored spans for that
 * classification. A parse failure renders as a plain line plus the error
 * (the badge layer shows it) — the dashboard never invents its own grammar.
 */
import { parseDslLine } from "@core/protocol/gal-dsl/line-parser.js";
import { DslProtocolError } from "@core/protocol/gal-dsl/types.js";

export type DslTokenCls =
  | "kw"
  | "id"
  | "speaker"
  | "slot"
  | "text"
  | "narr"
  | "prompt"
  | "dim"
  | "reason-buffer"
  | "reason-interaction"
  | "reason-ending";

export interface DslToken {
  cls: DslTokenCls;
  text: string;
}

export interface DslLineRender {
  /** Parser verdict: line kind, or null when unparseable / a fence line. */
  kind: string | null;
  error: string | null;
  tokens: DslToken[];
}

/** Same dialogue regex the parser accepts — used here only for slicing. */
const DIALOGUE_SLICE = /^([^\[\]:]+?)(\[[^\]]*\])?(\([^)]*\))?(:)(\s*)(.*)$/;

function token(cls: DslTokenCls, text: string): DslToken | null {
  return text.length > 0 ? { cls, text } : null;
}

function tokensFromDialogue(line: string): DslToken[] {
  const match = DIALOGUE_SLICE.exec(line);
  if (match === null) return [{ cls: "text", text: line }];
  const parts = [
    token("speaker", match[1] ?? ""),
    token("slot", match[2] ?? ""),
    token("slot", match[3] ?? ""),
    token("dim", (match[4] ?? "") + (match[5] ?? "")),
    token("text", match[6] ?? ""),
  ];
  return parts.filter((t): t is DslToken => t !== null);
}

/**
 * Render one complete DSL line. Mirrors the runtime: markdown fences are
 * dimmed and treated as no-kind; a DslProtocolError keeps the raw text and
 * carries the message for the badge.
 */
export function renderDslLine(raw: string, knownSpeakers?: ReadonlySet<string>): DslLineRender {
  const line = raw.trim();
  if (line.startsWith("```")) {
    return { kind: null, error: null, tokens: [{ cls: "dim", text: raw }] };
  }
  let parsed;
  try {
    parsed = parseDslLine(line, knownSpeakers);
  } catch (error) {
    if (error instanceof DslProtocolError) {
      return { kind: null, error: error.message, tokens: [{ cls: "text", text: raw }] };
    }
    throw error;
  }
  switch (parsed.kind) {
    case "segment_end": {
      const match = /^(@end)(\s+)(\S+)(?:\s+(\S+))?/.exec(line);
      if (match === null) return { kind: parsed.kind, error: null, tokens: [{ cls: "kw", text: raw }] };
      const reason = match[4];
      const reasonCls: DslTokenCls =
        reason === "ending"
          ? "reason-ending"
          : reason === "interaction"
            ? "reason-interaction"
            : "reason-buffer";
      return {
        kind: parsed.kind,
        error: null,
        tokens: [
          { cls: "kw", text: match[1]! },
          { cls: "dim", text: match[2]! },
          { cls: "dim", text: match[3]! },
          ...(reason !== undefined ? [{ cls: reasonCls, text: ` ${reason}` }] : []),
        ],
      };
    }
    case "form_end":
      return { kind: parsed.kind, error: null, tokens: [{ cls: "kw", text: line }] };
    case "form_start": {
      const head = line.startsWith("@") ? 2 : 1;
      // The empty-prompt rule is enforced by the builder (cross-line), not
      // the line parser — mirror it here so replayed/snapshotted documents
      // keep the error squiggle after server verdicts are gone.
      if (line.slice(head).trim() === "") {
        return {
          kind: parsed.kind,
          error: "EMPTY_FORM_PROMPT：交互表单的提示语不能为空。",
          tokens: [
            { cls: "kw", text: line.slice(0, head) },
            { cls: "prompt", text: line.slice(head) },
          ],
        };
      }
      return {
        kind: parsed.kind,
        error: null,
        tokens: [
          { cls: "kw", text: line.slice(0, head) },
          { cls: "prompt", text: line.slice(head) },
        ],
      };
    }
    case "form_option":
      return {
        kind: parsed.kind,
        error: null,
        tokens: [
          { cls: "kw", text: line.slice(0, line.startsWith("@") ? 2 : 1) },
          { cls: "text", text: line.slice(line.startsWith("@") ? 2 : 1) },
        ],
      };
    case "form_input":
      return {
        kind: parsed.kind,
        error: null,
        tokens: [
          { cls: "kw", text: line.slice(0, line.startsWith("@") ? 2 : 1) },
          { cls: "prompt", text: line.slice(line.startsWith("@") ? 2 : 1) },
        ],
      };
    case "beat":
      return { kind: parsed.kind, error: null, tokens: [{ cls: "kw", text: line }] };
    case "background":
    case "bgm":
    case "sound_effect": {
      const match = /^(@?(?:bg|bgm|se))(\s+)(\S+)$/.exec(line);
      if (match === null) return { kind: parsed.kind, error: null, tokens: [{ cls: "kw", text: raw }] };
      return {
        kind: parsed.kind,
        error: null,
        tokens: [
          { cls: "kw", text: match[1]! },
          { cls: "dim", text: match[2]! },
          { cls: "id", text: match[3]! },
        ],
      };
    }
    case "character_cue": {
      const match = /^(@?ch)(\s+)([^:\s]+)(\s*:\s*)([^:\s]+?)(?:(\s+)(\S+))?$/.exec(line);
      if (match === null) {
        // @ch <id> hide|show|exit
        const alt = /^(@?ch)(\s+)(\S+)(\s+)(hide|show|exit)$/.exec(line);
        if (alt === null) {
          return { kind: parsed.kind, error: null, tokens: [{ cls: "kw", text: raw }] };
        }
        return {
          kind: parsed.kind,
          error: null,
          tokens: [
            { cls: "kw", text: alt[1]! },
            { cls: "dim", text: alt[2]! },
            { cls: "id", text: alt[3]! },
            { cls: "dim", text: alt[4]! },
            { cls: "slot", text: alt[5]! },
          ],
        };
      }
      return {
        kind: parsed.kind,
        error: null,
        tokens: [
          { cls: "kw", text: match[1]! },
          { cls: "dim", text: match[2]! },
          { cls: "id", text: match[3]! },
          { cls: "dim", text: match[4]! },
          { cls: "id", text: match[5]! },
          ...(match[7] !== undefined
            ? ([{ cls: "slot", text: `${match[6]}${match[7]}` }] as DslToken[])
            : []),
        ],
      };
    }
    case "dialogue":
      return { kind: parsed.kind, error: null, tokens: tokensFromDialogue(line) };
    case "narration":
      return { kind: parsed.kind, error: null, tokens: [{ cls: "narr", text: raw }] };
  }
}
