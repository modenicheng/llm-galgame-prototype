/**
 * BacklogOverlay — the 回看 panel: a scrollable reading history over the
 * stage, one row per past line, newest at the bottom. Clicking a row replays
 * that line's voice from the IndexedDB cache (rows without replayable audio
 * are marked 无音频); clicking the playing row stops the replay. Rows are
 * static text — updates only rebuild the list when its shape changed, so
 * the panel can be refreshed on every app tick without DOM churn.
 */
import { clearChildren, el, setText, show } from "./dom.js";
import type { BacklogEntry } from "../runtime/backlog-store.js";

export interface BacklogOverlayHooks {
  onClose(): void;
  onReplay(lineId: string): void;
  onStopReplay(): void;
}

export class BacklogOverlay {
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly hooks: BacklogOverlayHooks;

  private openState = false;
  /** Render diffing: rows are immutable, so identity of (size, last id,
   * replay target) is enough to decide a rebuild. */
  private renderedSize = -1;
  private renderedLastId: string | null = null;
  private renderedReplayId: string | null = null;

  constructor(root: HTMLElement, hooks: BacklogOverlayHooks) {
    this.root = root;
    this.hooks = hooks;

    const panel = el("div", "backlog__panel") as HTMLDivElement;
    const header = el("div", "backlog__header") as HTMLDivElement;
    header.append(
      el("h2", "backlog__title", "回看"),
      el("span", "backlog__count", ""),
    );
    this.countEl = header.querySelector(".backlog__count") as HTMLElement;
    this.closeBtn = el("button", "backlog__close", "✕ 关闭") as HTMLButtonElement;
    this.closeBtn.type = "button";
    this.closeBtn.addEventListener("click", () => this.hooks.onClose());
    header.append(this.closeBtn);
    this.listEl = el("div", "backlog__list") as HTMLDivElement;
    panel.append(header, this.listEl);
    this.root.append(panel);
    // 空态提示（无历史时）。
    const empty = el("p", "backlog__empty", "还没有可以回看的故事。");
    this.root.append(empty);
    show(this.root, false);
  }

  get isOpen(): boolean {
    return this.openState;
  }

  open(entries: readonly BacklogEntry[], replayLineId: string | null): void {
    this.openState = true;
    show(this.root, true);
    this.render(entries, replayLineId, true);
  }

  close(): void {
    this.openState = false;
    show(this.root, false);
  }

  /** Refresh from app state; cheap when nothing visible changed. */
  update(entries: readonly BacklogEntry[], replayLineId: string | null): void {
    if (!this.openState) return;
    this.render(entries, replayLineId, false);
  }

  private render(
    entries: readonly BacklogEntry[],
    replayLineId: string | null,
    forceScroll: boolean,
  ): void {
    const last = entries.length > 0 ? entries[entries.length - 1]!.lineId : null;
    const unchanged =
      entries.length === this.renderedSize &&
      last === this.renderedLastId &&
      replayLineId === this.renderedReplayId;
    if (unchanged) return;
    this.renderedSize = entries.length;
    this.renderedLastId = last;
    this.renderedReplayId = replayLineId;

    setText(this.countEl, entries.length > 0 ? `${entries.length} 条` : "");
    clearChildren(this.listEl);
    const emptyEl = this.root.querySelector(".backlog__empty") as HTMLElement;
    show(emptyEl, entries.length === 0);

    for (const entry of entries) {
      this.listEl.append(this.buildRow(entry, replayLineId === entry.lineId));
    }
    this.scrollToBottom(forceScroll);
  }

  private buildRow(entry: BacklogEntry, playing: boolean): HTMLButtonElement {
    const row = el("button", "backlog__item") as HTMLButtonElement;
    row.type = "button";
    row.dataset.lineId = entry.lineId;
    const isNarration = entry.type === "narration";
    if (isNarration) row.classList.add("backlog__item--narration");
    if (playing) row.classList.add("backlog__item--playing");
    if (entry.cacheKey === null) row.classList.add("backlog__item--noaudio");

    const speaker = el("span", "backlog__speaker", isNarration ? "旁白" : (entry.speaker ?? ""));
    const text = el("span", "backlog__text", entry.text);
    const cue = el("span", "backlog__cue", "");
    if (playing) {
      cue.textContent = "■"; // 点击停止
      row.title = "点击停止回放";
    } else if (entry.cacheKey !== null) {
      cue.textContent = "▶";
      row.title = "点击回放语音";
    } else {
      cue.textContent = "无音频";
      row.title = "这一行没有可回放的语音";
      row.disabled = true;
    }
    row.append(speaker, text, cue);
    row.addEventListener("click", () => {
      if (entry.cacheKey === null) return;
      if (playing) this.hooks.onStopReplay();
      else this.hooks.onReplay(entry.lineId);
    });
    return row;
  }

  /** Stick to the newest entry unless the reader scrolled up. */
  private scrollToBottom(force: boolean): void {
    const nearBottom =
      this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 48;
    if (!force && !nearBottom) return;
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }
}
