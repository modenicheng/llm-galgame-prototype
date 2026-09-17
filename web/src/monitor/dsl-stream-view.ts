/**
 * DslStreamView — live rendering of ONE writer attempt's DSL stream.
 *
 * Line assembly reuses the core StreamLineDecoder, so the dashboard splits
 * chunks exactly like the runtime does (\n / \r\n, dropped empty lines,
 * truncated tail kept partial until finish). Completed lines render through
 * renderDslLine (core parseDslLine); the still-streaming tail renders as a
 * neutral partial row. Server-side parse verdicts (writer.line events) are
 * authoritative and patch the badge when they land.
 */
import { StreamLineDecoder } from "@core/protocol/gal-dsl/stream-decoder.js";
import { renderDslLine } from "./dsl-tokens.js";
import { el } from "../ui/dom.js";

const KIND_BADGES: Record<string, string> = {
  dialogue: "台词",
  narration: "旁白",
  form_start: "表单",
  form_option: "选项",
  form_input: "输入框",
  form_end: "表单结束",
  segment_end: "@end",
  background: "背景",
  bgm: "BGM",
  sound_effect: "音效",
  character_cue: "立绘",
  beat: "beat",
};

export class DslStreamView {
  private readonly container: HTMLElement;
  private readonly rowsEl: HTMLElement;
  private readonly partialRow: HTMLElement;
  private readonly partialCode: HTMLElement;
  private decoder = new StreamLineDecoder();
  /** Text after the last newline (the still-streaming tail), tracked here. */
  private pendingTail = "";
  private knownSpeakers: ReadonlySet<string> | undefined;
  private rows: HTMLElement[] = [];
  private badges: (HTMLElement | null)[] = [];
  private rowKinds: (string | null)[] = [];

  // Auto-follow lives in WriterPanel (the scroll host). This view's own
  // container is never scrollable, so a per-view pinned heuristic would be
  // dead code with a diverging threshold.

  constructor(container: HTMLElement) {
    this.container = container;
    this.rowsEl = el("div", "dsl-rows");
    this.partialRow = el("div", "dsl-row is-partial");
    this.partialRow.appendChild(el("span", "dsl-no", ""));
    this.partialCode = el("code", "dsl-code");
    this.partialRow.appendChild(this.partialCode);
    // The partial row lives INSIDE rowsEl: completed rows are inserted
    // before it, so it must be a child of the same parent.
    this.rowsEl.appendChild(this.partialRow);
    container.appendChild(this.rowsEl);
  }

  reset(knownSpeakers?: ReadonlySet<string>): void {
    this.decoder = new StreamLineDecoder();
    this.pendingTail = "";
    this.knownSpeakers = knownSpeakers;
    this.rows = [];
    this.badges = [];
    this.rowKinds = [];
    this.rowsEl.textContent = "";
    this.rowsEl.appendChild(this.partialRow); // textContent="" dropped it
    this.partialCode.textContent = "";
  }

  /** Feed raw delta text (may contain partial lines). */
  append(text: string): void {
    this.pendingTail += text;
    const cut = this.pendingTail.lastIndexOf("\n");
    if (cut !== -1) this.pendingTail = this.pendingTail.slice(cut + 1);
    for (const line of this.decoder.push(text)) {
      this.appendCompletedLine(line);
    }
    this.refreshPartial();
  }

  /** Attempt settled — flush the truncated tail as its own (partial) line. */
  finish(): void {
    const tail = this.decoder.flush();
    if (tail !== null) {
      this.appendCompletedLine(tail);
    }
    this.pendingTail = "";
    this.partialCode.textContent = "";
  }

  /** Apply the server-side parse verdict for a completed line. */
  applyServerLine(lineIndex: number, kind: string | null, error: string | null): void {
    const row = this.rows[lineIndex - 1];
    if (row === undefined) return;
    const badge = this.badges[lineIndex - 1];
    if (badge === null || badge === undefined) return;
    this.styleBadge(badge, kind, error);
    this.rowKinds[lineIndex - 1] = kind;
    row.classList.toggle("has-error", error !== null);
  }

  /** Mark the DSL row (or full interaction form) currently shown to the player. */
  highlight(lineIndex: number | null): HTMLElement | null {
    for (const row of this.rows) {
      row.classList.remove("is-current-player", "is-current-block");
      row.removeAttribute("aria-current");
    }
    if (lineIndex === null) return null;
    const current = this.rows[lineIndex - 1];
    if (current === undefined) return null;

    current.classList.add("is-current-player");
    current.setAttribute("aria-current", "true");

    if (this.rowKinds[lineIndex - 1] === "form_start") {
      for (let index = lineIndex - 1; index < this.rows.length; index += 1) {
        this.rows[index]!.classList.add("is-current-block");
        if (this.rowKinds[index] === "form_end") break;
      }
    } else {
      current.classList.add("is-current-block");
    }
    return current;
  }

  /** Feed the whole replayed text of a finished attempt (task switch). */
  replay(text: string): void {
    this.append(text);
    this.finish();
  }

  private appendCompletedLine(raw: string): void {
    const index = this.rows.length + 1;
    const render = renderDslLine(raw, this.knownSpeakers);
    const row = el("div", "dsl-row");
    row.appendChild(el("span", "dsl-no", String(index)));
    const code = el("code", "dsl-code");
    for (const tok of render.tokens) {
      const span = el("span", `tok-${tok.cls}`);
      span.textContent = tok.text;
      code.appendChild(span);
    }
    row.appendChild(code);
    let badge: HTMLElement | null = null;
    if (render.kind !== null || render.error !== null) {
      badge = el("span", "dsl-badge");
      this.styleBadge(badge, render.kind, render.error);
      row.appendChild(badge);
      row.classList.toggle("has-error", render.error !== null);
    }
    // Keep the partial row last.
    this.rowsEl.insertBefore(row, this.partialRow);
    this.rows.push(row);
    this.badges.push(badge);
    this.rowKinds.push(render.kind);
  }

  private refreshPartial(): void {
    this.partialCode.textContent = this.pendingTail;
  }

  private styleBadge(badge: HTMLElement, kind: string | null, error: string | null): void {
    if (error !== null) {
      badge.textContent = "✗ 校验";
      badge.className = "dsl-badge is-error";
      badge.setAttribute("title", error);
      return;
    }
    badge.textContent = KIND_BADGES[kind ?? ""] ?? (kind ?? "");
    badge.className = kind === "segment_end" ? "dsl-badge is-end" : "dsl-badge";
    badge.removeAttribute("title");
  }
}
