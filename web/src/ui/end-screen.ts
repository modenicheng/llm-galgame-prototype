/**
 * EndScreen + ErrorBanner — the terminal overlays. EndScreen renders the
 * ending event (with a 朱砂 seal accent); ErrorBanner is the transient
 * error strip.
 */
import { asRecord, setText, show } from "./dom.js";

export interface EndScreenHooks {
  onRestart(): void;
}

export interface EndingLike {
  ending_id: string;
  text: string;
}

/** Narrow an unknown ending wire object, or null. */
export function asEnding(value: unknown): EndingLike | null {
  const record = asRecord(value);
  if (record === null) return null;
  const text = record.text;
  const endingId = record.ending_id;
  if (typeof text !== "string" || typeof endingId !== "string") return null;
  return { ending_id: endingId, text };
}

export class EndScreen {
  private readonly root: HTMLElement;
  private readonly textEl: HTMLElement;

  constructor(root: HTMLElement, hooks: EndScreenHooks) {
    this.root = root;
    this.textEl = root.querySelector(".end-text") as HTMLElement;
    (root.querySelector(".end-restart") as HTMLButtonElement).addEventListener(
      "click",
      () => hooks.onRestart(),
    );
  }

  /** Present the ending. Returns true when the payload was usable. */
  show(ending: unknown): boolean {
    const parsed = asEnding(ending);
    if (parsed === null) return false;
    setText(this.textEl, parsed.text);
    show(this.root, true);
    return true;
  }

  hide(): void {
    show(this.root, false);
  }
}

export class ErrorBanner {
  private readonly root: HTMLElement;
  private readonly textEl: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.textEl = root.querySelector(".banner__text") as HTMLElement;
  }

  show(message: string): void {
    setText(this.textEl, message);
    show(this.root, true);
  }

  hide(): void {
    show(this.root, false);
  }
}
