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
  private readonly sessionEl: HTMLElement;
  private readonly restartBtn: HTMLButtonElement;

  constructor(root: HTMLElement, hooks: EndScreenHooks) {
    this.root = root;
    this.textEl = root.querySelector(".end-text") as HTMLElement;
    this.sessionEl = root.querySelector(".end-session") as HTMLElement;
    this.restartBtn = root.querySelector(".end-restart") as HTMLButtonElement;
    this.restartBtn.addEventListener("click", () => hooks.onRestart());
  }

  /** Present the ending. Returns true when the payload was usable. */
  show(ending: unknown, sessionId?: string): boolean {
    const parsed = asEnding(ending);
    if (parsed === null) return false;
    setText(this.textEl, parsed.text);
    // Booth ops: the session id travels with the ending so a problem report
    // screenshot is self-contained.
    if (sessionId !== undefined) {
      setText(this.sessionEl, `会话 ${sessionId}`);
      show(this.sessionEl, true);
    } else {
      show(this.sessionEl, false);
    }
    this.setRestartPending(false);
    show(this.root, true);
    return true;
  }

  hide(): void {
    show(this.root, false);
  }

  /** Restart-in-flight state: the button is disabled until the new session lands. */
  setRestartPending(pending: boolean): void {
    this.restartBtn.disabled = pending;
    setText(this.restartBtn, pending ? "正在开启新一局…" : "重新开始");
  }
}

/** Optional recovery action attached to an error banner. */
export interface ErrorBannerAction {
  label: string;
  onAction: () => void;
}

export class ErrorBanner {
  private readonly root: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly actionBtn: HTMLButtonElement | null;
  private action: ErrorBannerAction | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.textEl = root.querySelector(".banner__text") as HTMLElement;
    this.actionBtn = root.querySelector(".banner__action") as HTMLButtonElement | null;
    this.actionBtn?.addEventListener("click", () => {
      this.action?.onAction();
    });
  }

  /** Present the error; an optional action (e.g. 重开一局) offers recovery. */
  show(message: string, action?: ErrorBannerAction): void {
    setText(this.textEl, message);
    this.action = action ?? null;
    if (this.actionBtn !== null) {
      if (action !== undefined) {
        setText(this.actionBtn, action.label);
        this.actionBtn.disabled = false;
        this.actionBtn.hidden = false;
      } else {
        this.actionBtn.hidden = true;
      }
    }
    show(this.root, true);
  }

  hide(): void {
    show(this.root, false);
  }

  /** Disable the action while its effect is pending (e.g. restart in flight). */
  setActionPending(pending: boolean): void {
    if (this.actionBtn === null || this.action === null) return;
    this.actionBtn.disabled = pending;
  }
}
