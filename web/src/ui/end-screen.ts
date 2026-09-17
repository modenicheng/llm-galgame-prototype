/**
 * EndScreen + ErrorBanner — the terminal overlays. EndScreen renders the
 * ending event (with a 朱砂 seal accent); ErrorBanner is the transient
 * error strip.
 */
import { asRecord, setText, show } from "./dom.js";
import { ENDING_GRADES } from "@core/protocol/gal-dsl/types.js";

/** 档位徽章文案（TE 真结局 / HE 圆满 / NE 平淡 / BE 坏结局）。 */
const GRADE_LABELS: Record<string, string> = {
  TE: "TE · 真结局",
  HE: "HE · 圆满",
  NE: "NE · 平淡",
  BE: "BE · 坏结局",
};

export interface EndScreenHooks {
  onRestart(): void;
}

export interface EndingLike {
  ending_id: string;
  text: string;
  /** @ending 结局档位（TE|HE|NE|BE）；缺省/非法由 asEnding 归一为 null。 */
  grade: string | null;
  /** @ending 结尾词（结局标题）；缺省为 null → UI 回退「剧终」。 */
  title: string | null;
}

/** Narrow an unknown ending wire object, or null. */
export function asEnding(value: unknown): EndingLike | null {
  const record = asRecord(value);
  if (record === null) return null;
  const text = record.text;
  const endingId = record.ending_id;
  if (typeof text !== "string" || typeof endingId !== "string") return null;
  const grade =
    typeof record.grade === "string" && (ENDING_GRADES as readonly string[]).includes(record.grade)
      ? record.grade
      : null;
  const title = typeof record.title === "string" && record.title.trim() !== "" ? record.title : null;
  return { ending_id: endingId, text, grade, title };
}

export class EndScreen {
  private readonly root: HTMLElement;
  private readonly gradeEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly sessionEl: HTMLElement;
  private readonly restartBtn: HTMLButtonElement;

  constructor(root: HTMLElement, hooks: EndScreenHooks) {
    this.root = root;
    this.gradeEl = root.querySelector(".end-grade") as HTMLElement;
    this.titleEl = root.querySelector(".end-title") as HTMLElement;
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
    // 结尾词（@ending 的标题）：模型没写时回退「剧终」。
    setText(this.titleEl, parsed.title ?? "剧终");
    // 档位徽章：undefined → 按 NE 缺省（现场漏写局发中档奖品）；样式按
    // 档位换色（.end-grade--te/he/ne/be）。
    const grade = parsed.grade ?? "NE";
    this.gradeEl.className = `end-grade end-grade--${grade.toLowerCase()}`;
    setText(this.gradeEl, GRADE_LABELS[grade] ?? grade);
    show(this.gradeEl, true);
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
