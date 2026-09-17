/**
 * Events + diagnostics tabs — the committed event tail and the runtime
 * diagnostics ring, both plain log lists.
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

export function renderEvents(container: HTMLElement, timeline: readonly MonitorTimelineEntry[]): void {
  container.textContent = "";
  if (timeline.length === 0) {
    container.appendChild(el("div", "mon-empty", "暂无已提交事件"));
    return;
  }
  const list = el("div", "log-list");
  for (const entry of timeline) {
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
          ? `[${entry.endingGrade ?? "NE"}] ${entry.endingTitle ?? ""} ${entry.endingId ?? ""} ${entry.text ?? ""}`.replace(/\s+/g, " ").trim()
          : (entry.text ?? "");
      row.appendChild(el("span", "msg", `${speaker}${text}`));
    }
    list.appendChild(row);
  }
  container.appendChild(list);
  container.scrollTop = container.scrollHeight;
}

export function renderDiagnostics(container: HTMLElement, entries: readonly MonitorDiagnosticEntry[]): void {
  container.textContent = "";
  if (entries.length === 0) {
    container.appendChild(el("div", "mon-empty", "暂无诊断日志"));
    return;
  }
  const list = el("div", "log-list");
  for (const entry of entries) {
    const row = el("div", `log-row lv-${entry.level}`);
    const time = new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false });
    row.appendChild(el("span", "t", time));
    row.appendChild(el("span", "scope", entry.scope));
    row.appendChild(el("span", "msg", entry.message));
    list.appendChild(row);
  }
  container.appendChild(list);
  container.scrollTop = container.scrollHeight;
}
