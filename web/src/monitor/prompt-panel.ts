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
import type { MonitorModel, WriterAttemptModel } from "./monitor-model.js";
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
    list.textContent = "";

    const system = this.model.writerSystemPrompt;
    if (system !== null) {
      list.appendChild(this.renderSystemBlock(system));
    }

    const items: PromptItem[] = [];
    for (const task of this.model.writerTasks) {
      for (const attempt of task.attempts) {
        items.push({ attempt, taskType: task.taskType });
      }
    }
    // Newest request first (auto-expand target = items[0]).
    items.sort((a, b) => b.attempt.startedAt - a.attempt.startedAt);

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

    for (const item of items) {
      list.appendChild(this.renderItem(item));
    }
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
    const { attempt, taskType } = item;
    const expanded = attempt.attemptId === this.expandedAttemptId;
    const element = el("div", "mon-prompt-item");
    if (!expanded) element.classList.add("is-collapsed");

    const head = el("div", "mon-prompt-item-head");
    head.appendChild(el("span", `mon-dot state-${attempt.state}`));
    head.appendChild(
      el(
        "strong",
        undefined,
        `${TASK_TYPE_LABELS[taskType] ?? taskType} · 请求 #${attempt.index + 1}`,
      ),
    );
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
