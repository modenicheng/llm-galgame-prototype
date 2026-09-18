/**
 * PromptPanel — the writer LLM's exact request payload, segmented by origin
 * (first tab of the right-top panel). The session-invariant system prompt is
 * pinned once at the top; each attempt is a narrow accordion item whose
 * expanded body lists the per-request messages (user / assistant roles),
 * every segment labeled with its source file or runtime pipeline. Segment
 * texts are verbatim prompt slices — joining them reproduces the request.
 *
 * Subscribes to the dedicated "writerPrompt" topic only: streaming deltas
 * must not re-render (and reset) this panel while the auditor reads it.
 */
import type { MonitorModel, WriterAttemptModel, WriterTaskModel } from "./monitor-model.js";
import type {
  MonitorWriterPromptMessage,
  MonitorWriterPromptSegment,
} from "@shared/wire/monitor-message.js";
import { el } from "../ui/dom.js";
import { TASK_TYPE_LABELS } from "./writer-panel.js";

const STATE_LABELS: Record<WriterAttemptModel["state"], string> = {
  streaming: "生成中",
  done: "完成",
  failed: "失败",
  retried: "已重试",
  cancelled: "已取消",
};

/** Source-tag color category (CSS `psrc-*` class suffix). */
function sourceClass(source: string): string {
  if (source.startsWith("prompts/") || source === "author.yaml" || source === "assets/resources.yaml") {
    return "file";
  }
  if (source === "runtime/event-mode-guidance") return "guidance";
  if (source === "runtime/repair") return "repair";
  if (source === "writer-output/prefix") return "output";
  return "runtime";
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

function fmtCount(n: number): string {
  return n.toLocaleString("zh-CN");
}

function segmentChars(segments: readonly MonitorWriterPromptSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.text.length, 0);
}

export interface PromptPanelRefs {
  list: HTMLElement;
}

interface PromptItem {
  attempt: WriterAttemptModel;
  taskType: string;
  /** 生成片内第几次生成（1 起）；独立片恒为 1。 */
  generation: number;
  /** 所属生成片 key（sliceId ?? taskId）。 */
  sliceKey: string;
  /** 片内修复续写次数（任务数 − 1）。 */
  sliceRepairs: number;
}

export class PromptPanel {
  private readonly model: MonitorModel;
  private readonly refs: PromptPanelRefs;
  /** Follow the newest attempt until the auditor manually selects one. */
  private followNewest = true;
  private expandedAttemptId: string | null = null;
  private readonly expandedSegments = new Set<string>();
  private sysExpanded = false;

  constructor(model: MonitorModel, refs: PromptPanelRefs) {
    this.model = model;
    this.refs = refs;
    model.subscribe((topic) => {
      if (topic === "writerPrompt") this.render();
    });
  }

  render(): void {
    const list = this.refs.list;
    // 跨重渲染保持审计员的阅读位置：钉住的 attempt 未变时恢复 scrollTop；
    // 跟随模式换到新 attempt（或旧 attempt 被环淘汰）时回顶（最新项在顶部，
    // 即旧行为）。
    const prevExpanded = this.expandedAttemptId;
    const keepScroll = list.scrollTop;
    list.textContent = "";

    const system = this.model.writerSystemPrompt;
    if (system !== null) {
      list.appendChild(this.renderSystemBlock(system));
    }

    // 生成片分组（原始生成 + 其修复续写共享同片）：片按最新 attempt 新→旧
    // 排列，片内生成也新→旧——审计默认落在"当前生效"的输入上，被覆盖的
    // 生成紧跟其后（同片标签可见，数据不删）。
    const slices = new Map<string, { taskType: string; tasks: WriterTaskModel[] }>();
    for (const task of this.model.writerTasks) {
      const key = task.sliceId ?? task.taskId;
      let slice = slices.get(key);
      if (slice === undefined) {
        slice = { taskType: task.taskType, tasks: [] };
        slices.set(key, slice);
      }
      slice.tasks.push(task);
    }
    const sliceEntries = [...slices.entries()].map(([sliceKey, slice]) => {
      const tasks = [...slice.tasks].sort(
        (a, b) =>
          (a.attempts[0]?.startedAt ?? a.startedAt) -
          (b.attempts[0]?.startedAt ?? b.startedAt),
      );
      const items: PromptItem[] = [];
      tasks.forEach((task, taskIndex) => {
        for (const attempt of task.attempts) {
          items.push({
            attempt,
            taskType: task.taskType,
            generation: taskIndex + 1,
            sliceKey,
            sliceRepairs: tasks.length - 1,
          });
        }
      });
      items.sort((a, b) => b.attempt.startedAt - a.attempt.startedAt);
      return { sliceKey, taskType: slice.taskType, items, sliceRepairs: tasks.length - 1 };
    });
    sliceEntries.sort(
      (a, b) =>
        (b.items[0]?.attempt.startedAt ?? 0) - (a.items[0]?.attempt.startedAt ?? 0),
    );
    const items: PromptItem[] = sliceEntries.flatMap((slice) => slice.items);

    if (items.length === 0) {
      if (system === null) {
        list.appendChild(el("div", "mon-empty", "暂无编剧请求（等待第一次生成）"));
      }
      return;
    }

    // Follow mode keeps re-targeting the newest attempt (auditing the
    // current input); a manual selection pins it. An id that fell out of the
    // server ring releases the selection back to the newest.
    if (
      this.followNewest ||
      this.expandedAttemptId === null ||
      !items.some((item) => item.attempt.attemptId === this.expandedAttemptId)
    ) {
      this.expandedAttemptId = items[0]!.attempt.attemptId;
    }

    for (const slice of sliceEntries) {
      if (slice.items.length === 0) continue;
      if (slice.sliceRepairs > 0) {
        list.appendChild(
          el(
            "div",
            "mon-prompt-slice-group",
            `${TASK_TYPE_LABELS[slice.taskType] ?? slice.taskType}生成片 · 修复续写 ×${slice.sliceRepairs}（下方为当前生效与被覆盖生成的输入）`,
          ),
        );
      }
      for (const item of slice.items) {
        list.appendChild(this.renderItem(item));
      }
    }
    list.scrollTop =
      prevExpanded !== null && this.expandedAttemptId === prevExpanded ? keepScroll : 0;
  }

  // -------------------------------------------------------------------------
  // Pinned system block (session-invariant, rendered once)
  // -------------------------------------------------------------------------

  private renderSystemBlock(system: MonitorWriterPromptMessage): HTMLElement {
    const block = el("div", "mon-prompt-sys");
    const head = el("div", "mon-prompt-sys-head");
    head.appendChild(el("span", "mon-prompt-sys-tag", "系统提示词"));
    head.appendChild(
      el(
        "span",
        undefined,
        `全话不变 · ${fmtCount(system.segments.length)} 段 · ${fmtCount(segmentChars(system.segments))} 字`,
      ),
    );
    const caret = el("span", `mon-caret${this.sysExpanded ? " is-open" : ""}`);
    caret.style.marginLeft = "auto";
    head.appendChild(caret);
    head.addEventListener("click", () => {
      this.sysExpanded = !this.sysExpanded;
      this.render();
    });
    block.appendChild(head);
    if (this.sysExpanded) {
      const body = el("div", "mon-prompt-sys-body");
      system.segments.forEach((segment, segmentIndex) => {
        body.appendChild(this.renderSegment(segment, `sys:${segmentIndex}`));
      });
      block.appendChild(body);
    }
    return block;
  }

  // -------------------------------------------------------------------------
  // Attempt accordion items
  // -------------------------------------------------------------------------

  private renderItem(item: PromptItem): HTMLElement {
    const { attempt, taskType, generation, sliceRepairs } = item;
    const expanded = attempt.attemptId === this.expandedAttemptId;
    const element = el("div", "mon-prompt-item");
    if (!expanded) element.classList.add("is-collapsed");

    const head = el("div", "mon-prompt-item-head");
    head.appendChild(el("span", `mon-dot state-${attempt.state}`));
    // 同片多生成时标注生成序号（原位替换的审计视角）；独立片保持原样。
    const title =
      sliceRepairs > 0
        ? `${TASK_TYPE_LABELS[taskType] ?? taskType} · 生成 #${generation} · 请求 #${attempt.index + 1}`
        : `${TASK_TYPE_LABELS[taskType] ?? taskType} · 请求 #${attempt.index + 1}`;
    head.appendChild(el("strong", undefined, title));
    const requests = attempt.promptRequests;
    if (requests.length > 1) {
      head.appendChild(el("span", "mon-prompt-followups", `含续写 ×${requests.length - 1}`));
    }
    const totalChars = requests.reduce(
      (sum, messages) => sum + messages.reduce((n, message) => n + segmentChars(message.segments), 0),
      0,
    );
    if (requests.length > 0) {
      head.appendChild(el("span", undefined, `${fmtCount(totalChars)} 字`));
    }
    head.appendChild(el("span", `mon-prompt-state state-${attempt.state}`, STATE_LABELS[attempt.state]));
    const right = el("span", undefined, fmtTime(attempt.startedAt));
    right.style.marginLeft = "auto";
    right.style.color = "#6e6e78";
    head.appendChild(right);
    element.appendChild(head);

    if (expanded) {
      element.appendChild(this.renderAttemptBody(attempt));
    }

    head.addEventListener("click", () => {
      this.followNewest = false;
      this.expandedAttemptId = expanded ? null : attempt.attemptId;
      this.render();
    });
    return element;
  }

  private renderAttemptBody(attempt: WriterAttemptModel): HTMLElement {
    const body = el("div", "mon-prompt-item-body");
    const requests = attempt.promptRequests;
    if (requests.length === 0) {
      body.appendChild(el("div", "mon-empty", "（提示词待上报）"));
      return body;
    }
    requests.forEach((messages, requestIndex) => {
      if (requestIndex > 0) {
        body.appendChild(
          el("div", "mon-prompt-request-sub", `续写请求 ${requestIndex + 1}（strip-continue）`),
        );
      } else if (this.model.writerSystemPrompt !== null) {
        body.appendChild(el("div", "mon-prompt-request-sub", "system · 全话不变，见顶部固定块"));
      }
      messages.forEach((message, messageIndex) => {
        if (message.role === "assistant" || messages.length > 1) {
          body.appendChild(el("div", `mon-prompt-role role-${message.role}`, message.role));
        }
        message.segments.forEach((segment, segmentIndex) => {
          body.appendChild(
            this.renderSegment(
              segment,
              `${attempt.attemptId}:${requestIndex}:${messageIndex}:${segmentIndex}`,
            ),
          );
        });
      });
    });
    return body;
  }

  // -------------------------------------------------------------------------
  // Segment rows (shared by system block and attempt bodies)
  // -------------------------------------------------------------------------

  private renderSegment(segment: MonitorWriterPromptSegment, key: string): HTMLElement {
    const element = el("div", "mon-prompt-seg");
    const expanded = this.expandedSegments.has(key);

    const head = el("div", "mon-prompt-seg-head");
    head.appendChild(el("span", `mon-prompt-seg-src psrc-${sourceClass(segment.source)}`, segment.source));
    head.appendChild(el("span", "mon-prompt-seg-label", segment.label));
    head.appendChild(el("span", "mon-prompt-seg-chars", `${fmtCount(segment.text.length)} 字`));
    if (segment.truncated === true) {
      head.appendChild(el("span", "mon-prompt-trunc", "已截断"));
    }
    const caret = el("span", `mon-caret${expanded ? " is-open" : ""}`);
    caret.style.marginLeft = "auto";
    head.appendChild(caret);
    element.appendChild(head);

    if (expanded) {
      const pre = el("pre", "mon-prompt-seg-body");
      pre.textContent = segment.text;
      element.appendChild(pre);
    }

    head.addEventListener("click", () => {
      if (this.expandedSegments.has(key)) this.expandedSegments.delete(key);
      else this.expandedSegments.add(key);
      this.render();
    });
    return element;
  }
}
