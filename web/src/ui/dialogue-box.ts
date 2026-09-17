/**
 * DialogueBox — the core VN dialogue panel: speaker nameplate, typewriter
 * text reveal, line-id chip (config.game.show_line_ids) and the advance
 * hint. One click types out the rest; the next click advances (§9.3).
 */
import type { RuntimePlayableEventWire } from "../runtime/game-view-model.js";
import { setText, show } from "./dom.js";
import { Typewriter } from "./typewriter.js";

export interface DialogueBoxHooks {
  onAdvance(): void;
}

/**
 * Upper bound on waiting for webfont subsets before the reveal starts.
 * The CJK webfont (vendored in web/public/fonts) keeps Google's
 * unicode-range subsetting with font-display: swap: a character painted
 * in the local fallback re-renders — and the line reflows — the moment
 * its subset lands mid-reveal. That per-character fallback→webfont swap
 * is the "text flickers while typing" bug, so the reveal is gated on
 * every face the line needs being loaded. Subsets now load from the local
 * host in ~ms, so the gate is cheap; the cap keeps a pathological case
 * (slow disk, huge subset burst) from freezing the dialogue box.
 */
const FONT_READY_TIMEOUT_MS = 1500;

export class DialogueBox {
  private readonly root: HTMLElement;
  private readonly speakerEl: HTMLElement;
  private readonly lineIdEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly hooks: DialogueBoxHooks;
  /**
   * One persistent text node mutated in place: replacing `textContent`
   * per character destroys and recreates the node every beat (childList
   * churn on each reveal step); mutating `.data` is an in-place patch.
   */
  private readonly textNode: Text;
  /** Bumped by every setLine/clear — a late font gate for a dead line no-ops. */
  private lineEpoch = 0;

  private typewriter: Typewriter | null = null;
  private charsPerSec = 32;
  private currentLineId: string | null = null;
  private showLineIds = false;

  constructor(root: HTMLElement, hooks: DialogueBoxHooks) {
    this.root = root;
    this.hooks = hooks;
    this.speakerEl = root.querySelector(".dialogue__speaker") as HTMLElement;
    this.lineIdEl = root.querySelector(".dialogue__line-id") as HTMLElement;
    this.textEl = root.querySelector(".dialogue__text") as HTMLElement;
    this.hintEl = root.querySelector(".dialogue__hint") as HTMLButtonElement;
    this.textNode = document.createTextNode("");
    this.textEl.replaceChildren(this.textNode);
    this.root.addEventListener("click", (event) => {
      // The hint is a button; clicking it must not double-fire.
      if (event.target === this.hintEl) return;
      this.pressAdvance();
    });
    this.hintEl.addEventListener("click", () => this.pressAdvance());
  }

  /** Present a line; the typewriter restarts only when the line changed. */
  setLine(line: RuntimePlayableEventWire, showLineIds: boolean): void {
    this.showLineIds = showLineIds;
    if (line.line_id === this.currentLineId) return;
    this.currentLineId = line.line_id;
    const epoch = ++this.lineEpoch;

    const isNarration = line.type === "narration";
    const speaker = isNarration ? "旁白" : (line.speaker ?? "");
    setText(this.speakerEl, speaker);
    this.root.classList.toggle("dialogue--narration", isNarration);
    setText(this.lineIdEl, showLineIds ? line.line_id : "");
    show(this.lineIdEl, showLineIds);

    this.typewriter?.stop();
    this.textNode.data = "";
    show(this.hintEl, false);
    this.typewriter = new Typewriter(
      line.text,
      {
        onUpdate: (full) => {
          this.textNode.data = full;
        },
        onDone: () => show(this.hintEl, true),
      },
      this.charsPerSec,
    );
    // Prewarm the subsets for the whole line (and the nameplate — its 600
    // weight is a separate face set) now; the reveal starts once they are
    // loaded (or the gate times out / fails).
    void this.waitForLineFonts(line.text, speaker).then(() => {
      if (this.lineEpoch !== epoch) return;
      this.typewriter?.start();
    });
  }

  setCharsPerSecond(charsPerSec: number): void {
    this.charsPerSec = charsPerSec;
    this.typewriter?.setCharsPerSecond(charsPerSec);
  }

  get isTyping(): boolean {
    return this.typewriter !== null && !this.typewriter.isDone;
  }

  /** First press finishes the reveal; the next press advances. */
  pressAdvance(): void {
    if (this.typewriter !== null && !this.typewriter.isDone) {
      this.typewriter.skip();
      return;
    }
    this.hooks.onAdvance();
  }

  clear(): void {
    this.lineEpoch += 1;
    this.typewriter?.stop();
    this.typewriter = null;
    this.currentLineId = null;
    this.textNode.data = "";
    setText(this.speakerEl, "");
    setText(this.lineIdEl, "");
    show(this.hintEl, false);
  }

  /**
   * Resolve once every webfont subset needed by the line (body text at its
   * computed weight, speaker name at the nameplate's) is loaded. The CJK
   * webfont's unicode-range subsets are fetched lazily on first use —
   * normally mid-reveal, which re-renders already-painted characters.
   * `document.fonts.load` fetches them up front instead. Fail-open on
   * every path: no fonts API, an invalid computed font, a rejected load or
   * a slow network must never block the story.
   */
  private async waitForLineFonts(text: string, speaker: string): Promise<void> {
    const fonts = document.fonts;
    if (fonts === undefined || typeof fonts.load !== "function") return;
    const loads: Array<Promise<unknown>> = [];
    try {
      const textStyle = getComputedStyle(this.textEl);
      loads.push(fonts.load(`${textStyle.fontSize} ${textStyle.fontFamily}`, text));
      const plateStyle = getComputedStyle(this.speakerEl);
      loads.push(
        fonts.load(
          `${plateStyle.fontWeight} ${plateStyle.fontSize} ${plateStyle.fontFamily}`,
          speaker,
        ),
      );
    } catch {
      return;
    }
    await Promise.race([
      Promise.all(loads).catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, FONT_READY_TIMEOUT_MS);
      }),
    ]);
  }
}
