/**
 * ContextPanel — the background async context-management LLM's output
 * (top-right block). These calls do not stream: each item shows lifecycle
 * (running / done / fallback / failed), its input batch, and the final
 * output text. The newest task is expanded by default.
 */
import type { MonitorModel } from "./monitor-model.js";
import { el } from "../ui/dom.js";

const KIND_LABELS: Record<string, string> = {
  recap: "前情压缩",
  consolidation: "记忆整理",
  plot_plan: "剧情规划",
};

const STATE_LABELS: Record<string, string> = {
  running: "运行中",
  done: "完成",
  fallback: "已回退",
  failed: "失败",
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

export interface ContextPanelRefs {
  list: HTMLElement;
}

export class ContextPanel {
  private readonly model: MonitorModel;
  private readonly refs: ContextPanelRefs;
  private expandedId: string | null = null;

  constructor(model: MonitorModel, refs: ContextPanelRefs) {
    this.model = model;
    this.refs = refs;
    model.subscribe((topic) => {
      if (topic === "context") this.render();
    });
  }

  render(): void {
    const list = this.refs.list;
    list.textContent = "";
    const tasks = this.model.contextTasks;
    if (tasks.length === 0) {
      list.appendChild(el("div", "mon-empty", "暂无后台上下文任务（滑窗未触发压缩）"));
      return;
    }
    // Newest first; auto-expand the newest task on first render.
    if (this.expandedId === null) this.expandedId = tasks[0]!.id;
    for (const task of tasks) {
      list.appendChild(this.renderItem(task.id, task.kind, task.state, task.startedAt, task.endedAt, task.detail, task.output, task.error));
    }
  }

  private renderItem(
    id: string,
    kind: string,
    state: string,
    startedAt: number,
    endedAt: number | null,
    detail: string,
    output: string | null,
    error: string | null,
  ): HTMLElement {
    const item = el("div", "mon-context-item");
    if (id !== this.expandedId) item.classList.add("is-collapsed");

    const head = el("div", "mon-context-item-head");
    head.appendChild(el("span", `mon-dot state-${state}`));
    head.appendChild(el("span", `mon-kind-${kind}`, KIND_LABELS[kind] ?? kind));
    head.appendChild(el("span", undefined, `${STATE_LABELS[state] ?? state}`));
    const right = el("span", undefined);
    right.style.marginLeft = "auto";
    right.style.color = "#6e6e78";
    right.textContent =
      endedAt !== null
        ? `${fmtTime(startedAt)} · ${endedAt - startedAt}ms`
        : fmtTime(startedAt);
    head.appendChild(right);
    item.appendChild(head);

    item.appendChild(el("div", "detail", detail));

    if (id === this.expandedId) {
      if (error !== null) {
        item.appendChild(el("div", "error-text", error));
      }
      if (output !== null && output.length > 0) {
        const pre = el("pre", "output");
        pre.textContent = output;
        item.appendChild(pre);
      } else if (error === null && state === "fallback") {
        item.appendChild(el("div", "detail", "（LLM 不可用，已回退确定性摘要——见日志）"));
      }
    }

    item.addEventListener("click", () => {
      this.expandedId = this.expandedId === id ? null : id;
      this.render();
    });
    return item;
  }
}
