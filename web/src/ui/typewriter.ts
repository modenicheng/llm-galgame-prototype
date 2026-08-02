/**
 * Typewriter — character-by-character text reveal for the dialogue box.
 *
 * Pure timing logic, no DOM: the caller supplies `onUpdate(full)` and
 * `onDone()`. CJK sentence-end punctuation gets an extra beat so the rhythm
 * feels like a voiced reading, not a metronome.
 */

export interface TypewriterHooks {
  onUpdate(full: string): void;
  onDone(): void;
}

/** Characters that stretch the pause before the next character. */
const PUNCTUATION = new Set(["，", "。", "！", "？", "、", "；", "：", "…", "—", "～"]);
const PUNCTUATION_DELAY_MULTIPLIER = 2.5;

function clampCps(cps: number): number {
  return Math.min(120, Math.max(1, cps));
}

export class Typewriter {
  private readonly text: string;
  private readonly hooks: TypewriterHooks;
  private cps: number;
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;

  constructor(text: string, hooks: TypewriterHooks, charsPerSec = 32) {
    this.text = text;
    this.hooks = hooks;
    this.cps = clampCps(charsPerSec);
  }

  get isDone(): boolean {
    return this.finished;
  }

  get progress(): number {
    return this.index;
  }

  /** Begin (or resume) typing from the current position. */
  start(): void {
    if (this.finished || this.timer !== null) return;
    this.schedule();
  }

  /** Restart the pacing from the current position after a speed change. */
  setCharsPerSecond(charsPerSec: number): void {
    this.cps = clampCps(charsPerSec);
    if (this.timer === null || this.finished) return;
    this.stop();
    this.schedule();
  }

  /** Reveal the full text immediately. */
  skip(): void {
    if (this.finished) return;
    this.stop();
    this.finished = true;
    this.index = this.text.length;
    this.hooks.onUpdate(this.text);
    this.hooks.onDone();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.index >= this.text.length) {
      this.finish();
      return;
    }
    const nextChar = this.text[this.index] ?? "";
    const delay =
      (1000 / this.cps) *
      (PUNCTUATION.has(nextChar) ? PUNCTUATION_DELAY_MULTIPLIER : 1);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.index += 1;
      this.hooks.onUpdate(this.text.slice(0, this.index));
      this.schedule();
    }, delay);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.hooks.onDone();
  }
}
