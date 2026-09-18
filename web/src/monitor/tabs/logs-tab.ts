/**
 * Events + diagnostics tabs — the committed event tail and the runtime
 * diagnostics ring.
 *
 * Rendering is INCREMENTAL with a geometric follow-tail heuristic (same
 * intent as the writer panel, but stateless): before appending, measure how
 * far the pane is from the bottom; only a pane that WAS at the bottom is
 * auto-scrolled to the new bottom. There is no stored follow flag to go
 * stale — a pane that becomes scrollable under a reader (splitter drag,
 * content growth) is handled by geometry at the next append, and a
 * ResizeObserver keeps the 「跟随最新」 chip honest across resizes.
 */
import type { MonitorTimelineEntry } from "@core/runtime/monitor-state.js";
import type { MonitorDiagnosticEntry } from "@shared/wire/monitor-message.js";
import { el } from "../../ui/dom.js";

const KIND_LABELS: Record<string, string> = {
  dialogue: "台词",
  narration: "旁白",
  interaction: "交互",
  player_choice: "选择",
  player_input: "输入",
  player_dialogue: "玩家",
  end: "结局",
};

function eventTone(kind: MonitorTimelineEntry["kind"]): "routine" | "interactive" | "terminal" {
  if (kind === "end") return "terminal";
  if (kind === "interaction" || kind.startsWith("player_")) return "interactive";
  return "routine";
}

/** Distance from the bottom inside which the pane counts as "following". */
const FOLLOW_THRESHOLD_PX = 32;

interface LogTailView {
  list: HTMLElement;
  jump: HTMLElement;
  /** Rows already in the DOM (identity-checked against the data head). */
  rows: number;
  headKey: string;
  /** Timestamp until which scroll events are our own programmatic scrolls. */
  shieldUntil: number;
}

const views = new WeakMap<HTMLElement, LogTailView>();

function entryKey(entry: { at: unknown; seq?: unknown }): string {
  return entry.seq !== undefined ? `seq:${String(entry.seq)}` : `at:${String(entry.at)}`;
}

function isAtBottom(pane: HTMLElement): boolean {
  return pane.scrollHeight - pane.scrollTop - pane.clientHeight < FOLLOW_THRESHOLD_PX;
}

function scrollBottom(pane: HTMLElement, view: LogTailView): void {
  view.shieldUntil = performance.now() + 120;
  pane.scrollTop = pane.scrollHeight;
}

/** Chip mirrors geometry: visible iff the pane overflows and isn't at bottom. */
function syncJump(pane: HTMLElement, view: LogTailView): void {
  const scrollable = pane.scrollHeight > pane.clientHeight + 1;
  view.jump.classList.toggle("is-shown", scrollable && !isAtBottom(pane));
}

/** One tail-managed log pane: incremental appends + geometric follow. */
function tailView(
  pane: HTMLElement,
  emptyText: string,
  force: boolean,
  buildRow: (entry: never) => HTMLElement,
  entries: () => readonly unknown[],
): void {
  let view = views.get(pane);
  if (view === undefined) {
    view = {
      list: el("div", "log-list"),
      jump: el("button", "mon-jump-bottom", "↓ 跟随最新"),
      rows: 0,
      headKey: "",
      shieldUntil: 0,
    };
    views.set(pane, view);
    pane.addEventListener("scroll", () => {
      if (performance.now() >= view!.shieldUntil) syncJump(pane, view!);
    });
    // 面板尺寸变化（splitter/窗口）会无声改变"是否在底部"，几何必须重采样。
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => syncJump(pane, view!)).observe(pane);
    }
    view.jump.addEventListener("click", () => {
      scrollBottom(pane, view!);
      syncJump(pane, view!);
    });
  }

  const entriesNow = entries();
  const headKey = entriesNow.length > 0 ? entryKey(entriesNow[0]! as { at: unknown }) : "";
  // Full rebuild on force, or when the ring dropped entries from the head
  // (identity mismatch — appending would splice history). A rebuilt pane
  // always lands on the newest entry (the tab was just (re)opened).
  if (force || view.list.parentElement !== pane || view.headKey !== headKey) {
    pane.textContent = "";
    view.list = el("div", "log-list");
    view.jump = el("button", "mon-jump-bottom", "↓ 跟随最新");
    view.jump.addEventListener("click", () => {
      scrollBottom(pane, view!);
      syncJump(pane, view!);
    });
    view.rows = 0;
    if (entriesNow.length === 0) {
      pane.append(view.list, el("div", "mon-empty", emptyText));
      view.headKey = "";
      return;
    }
    for (const entry of entriesNow) {
      view.list.appendChild(buildRow(entry as never));
    }
    view.rows = entriesNow.length;
    view.headKey = headKey;
    pane.append(view.list, view.jump);
    scrollBottom(pane, view);
    syncJump(pane, view);
    return;
  }

  const wasAtBottom = isAtBottom(pane);
  for (let i = view.rows; i < entriesNow.length; i += 1) {
    view.list.appendChild(buildRow(entriesNow[i]! as never));
  }
  if (entriesNow.length > view.rows && wasAtBottom) scrollBottom(pane, view);
  view.rows = entriesNow.length;
  view.headKey = headKey;
  syncJump(pane, view);
}

export function renderEvents(
  container: HTMLElement,
  timeline: readonly MonitorTimelineEntry[],
  force = false,
): void {
  tailView(
    container,
    "暂无已提交事件",
    force,
    (entry: MonitorTimelineEntry) => {
      const row = el(
        "div",
        `log-row event-row event-kind-${entry.kind} event-tone-${eventTone(entry.kind)}`,
      );
      row.appendChild(el("span", "t", `#${entry.seq}`));
      row.appendChild(el("span", "kind-chip", KIND_LABELS[entry.kind] ?? entry.kind));
      if (entry.kind === "interaction") {
        row.appendChild(el("span", "msg", entry.prompt ?? ""));
      } else {
        const speaker = entry.speaker !== undefined ? `${entry.speaker}：` : "";
        const text =
          entry.kind === "end"
            ? `[${entry.endingGrade ?? "NE"}] ${entry.endingTitle ?? ""} ${entry.endingId ?? ""} ${entry.text ?? ""}`
                .replace(/\s+/g, " ")
                .trim()
            : (entry.text ?? "");
        row.appendChild(el("span", "msg", `${speaker}${text}`));
      }
      return row;
    },
    () => timeline,
  );
}

export function renderDiagnostics(
  container: HTMLElement,
  entries: readonly MonitorDiagnosticEntry[],
  force = false,
): void {
  tailView(
    container,
    "暂无诊断日志",
    force,
    (entry: MonitorDiagnosticEntry) => {
      const row = el("div", `log-row lv-${entry.level}`);
      const time = new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false });
      row.appendChild(el("span", "t", time));
      row.appendChild(el("span", "scope", entry.scope));
      row.appendChild(el("span", "msg", entry.message));
      return row;
    },
    () => entries,
  );
}
