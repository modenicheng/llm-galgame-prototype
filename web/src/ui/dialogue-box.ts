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

export class DialogueBox {
  private readonly root: HTMLElement;
  private readonly speakerEl: HTMLElement;
  private readonly lineIdEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly hooks: DialogueBoxHooks;

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

    const isNarration = line.type === "narration";
    setText(this.speakerEl, isNarration ? "旁白" : (line.speaker ?? ""));
    this.root.classList.toggle("dialogue--narration", isNarration);
    setText(this.lineIdEl, showLineIds ? line.line_id : "");
    show(this.lineIdEl, showLineIds);

    this.typewriter?.stop();
    setText(this.textEl, "");
    show(this.hintEl, false);
    this.typewriter = new Typewriter(
      line.text,
      {
        onUpdate: (full) => setText(this.textEl, full),
        onDone: () => show(this.hintEl, true),
      },
      this.charsPerSec,
    );
    this.typewriter.start();
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
    this.typewriter?.stop();
    this.typewriter = null;
    this.currentLineId = null;
    setText(this.textEl, "");
    setText(this.speakerEl, "");
    setText(this.lineIdEl, "");
    show(this.hintEl, false);
  }
}
