/**
 * RecordsOverlay — 主界面上的「过往记录」：已完结局子的结局列表（档位徽章、
 * 结尾词、结局时间、结局全文摘录）。数据来自 GET /api/saves 的存档摘要
 * （phase === "ended" 的存档），打开时拉取一次；加载/空态/失败态都是纯文本，
 * 不阻塞主界面的开始按钮。
 */
import { clearChildren, el, show, setText } from "./dom.js";
import { ENDING_GRADES } from "@core/protocol/gal-dsl/types.js";

/** /api/saves 存档摘要中本浮层消费的字段（其余字段忽略）。 */
export interface PlayerRecord {
  sessionId: string;
  /** 结局时间（存档最后一次活动时间，ISO；无事件日志的旧存档为 null）。 */
  endedAt: string | null;
  /** @ending 档位（TE|HE|NE|BE）；旧存档缺省按 NE 展示。 */
  grade: string;
  /** @ending 结尾词；缺省回退「剧终」。 */
  title: string;
  /** @ending 结局全文；旧存档可能没有。 */
  text: string;
  /** 已演绎的交互回合数。 */
  turnCount: number;
}

export interface RecordsOverlayHooks {
  onClose(): void;
}

/** Narrow one /api/saves summary into a player record, or null. */
export function asPlayerRecord(value: unknown): PlayerRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.phase !== "ended" || typeof record.sessionId !== "string") return null;
  const grade =
    typeof record.endingGrade === "string" && (ENDING_GRADES as readonly string[]).includes(record.endingGrade)
      ? record.endingGrade
      : "NE";
  return {
    sessionId: record.sessionId,
    endedAt:
      typeof record.lastPlayedAt === "string"
        ? record.lastPlayedAt
        : typeof record.createdAt === "string"
          ? record.createdAt
          : null,
    grade,
    title: typeof record.endingTitle === "string" && record.endingTitle.trim() !== "" ? record.endingTitle : "剧终",
    text: typeof record.endingText === "string" ? record.endingText : "",
    turnCount: typeof record.turnCount === "number" && Number.isInteger(record.turnCount) ? record.turnCount : 0,
  };
}

/** 「2026-09-19T19:40:43.029Z」→「2026-09-19 19:40」（本地时区）；坏值回退原文。 */
export function formatRecordDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export class RecordsOverlay {
  private readonly root: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly hooks: RecordsOverlayHooks;
  private readonly fetchImpl: typeof fetch;

  private openState = false;
  /** 打开中的一次加载（关浮层后返回的响应不再渲染）。 */
  private loadToken = 0;

  constructor(root: HTMLElement, hooks: RecordsOverlayHooks, fetchImpl?: typeof fetch) {
    this.root = root;
    this.hooks = hooks;
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);

    const panel = el("div", "records__panel") as HTMLDivElement;
    const header = el("div", "records__header") as HTMLDivElement;
    header.append(el("h2", "records__title", "过往记录"), (this.countEl = el("span", "records__count", "")));
    const closeBtn = el("button", "records__close", "✕ 关闭") as HTMLButtonElement;
    closeBtn.type = "button";
    closeBtn.addEventListener("click", () => this.hooks.onClose());
    header.append(closeBtn);
    this.listEl = el("div", "records__list") as HTMLDivElement;
    this.statusEl = el("p", "records__status", "");
    panel.append(header, this.listEl, this.statusEl);
    this.root.append(panel);
    show(this.root, false);
  }

  get isOpen(): boolean {
    return this.openState;
  }

  /** Open the overlay and (re)load the archive. */
  open(): void {
    this.openState = true;
    show(this.root, true);
    void this.load();
  }

  close(): void {
    this.openState = false;
    show(this.root, false);
  }

  /** Test seam: render records without going through the network. */
  renderRecords(records: readonly PlayerRecord[]): void {
    setText(this.countEl, records.length > 0 ? `${records.length} 段结局` : "");
    show(this.statusEl, false);
    clearChildren(this.listEl);
    if (records.length === 0) {
      setText(this.statusEl, "还没有完结的故事。开启第一局吧。");
      show(this.statusEl, true);
      return;
    }
    for (const record of records) this.listEl.append(this.buildRow(record));
  }

  private async load(): Promise<void> {
    const token = ++this.loadToken;
    setText(this.countEl, "");
    clearChildren(this.listEl);
    setText(this.statusEl, "读取中……");
    show(this.statusEl, true);
    let records: PlayerRecord[];
    try {
      const response = await this.fetchImpl("/api/saves");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { saves?: unknown };
      const saves = Array.isArray(payload.saves) ? payload.saves : [];
      records = saves.map(asPlayerRecord).filter((r): r is PlayerRecord => r !== null);
    } catch (error) {
      if (!this.openState || token !== this.loadToken) return;
      const message = error instanceof Error ? error.message : String(error);
      setText(this.statusEl, `读取失败：${message}`);
      return;
    }
    if (!this.openState || token !== this.loadToken) return;
    this.renderRecords(records);
  }

  private buildRow(record: PlayerRecord): HTMLElement {
    const item = el("article", "records__item") as HTMLElement;
    const meta = el("div", "records__meta") as HTMLDivElement;
    const grade = el("span", `records__grade records__grade--${record.grade.toLowerCase()}`);
    grade.textContent = record.grade;
    const title = el("span", "records__ending", record.title);
    const date = el("span", "records__date", record.endedAt !== null ? formatRecordDate(record.endedAt) : "");
    const turns = record.turnCount > 0 ? `第 ${record.turnCount} 回` : "";
    meta.append(grade, title, el("span", "records__spacer"), el("span", "records__turns", turns), date);
    item.append(meta);
    // .records__text 的 display:-webkit-box 会压过 [hidden]，空全文直接不建节点。
    if (record.text !== "") {
      item.append(el("p", "records__text", record.text));
    }
    return item;
  }
}
