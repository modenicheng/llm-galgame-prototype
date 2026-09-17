/**
 * One chronological, auto-following document containing every writer request.
 * Request boundaries carry latency, token, repair and parse telemetry.
 */
import type { MonitorModel, WriterAttemptModel, WriterTaskModel } from "./monitor-model.js";
import type { MonitorServerEvent } from "@shared/wire/monitor-message.js";
import { DslStreamView } from "./dsl-stream-view.js";
import { el } from "../ui/dom.js";

/** Shared with the prompt audit panel (same task-type vocabulary). */
export const TASK_TYPE_LABELS: Record<string, string> = {
  opening: "开场",
  continuation: "续写",
  branch_prefetch: "分支预取",
  input_response: "输入回应",
  input_bridge: "过场桥接",
  recovery: "恢复",
  ending: "结局",
};

const STATE_LABELS: Record<WriterAttemptModel["state"], string> = {
  streaming: "生成中",
  done: "完成",
  failed: "失败",
  retried: "已重试",
  cancelled: "已取消",
};

/** 修复结果的语义标签——监控端一眼看出修的是什么，不靠读 message 猜。 */
const REPAIR_KIND_LABELS: Record<string, string> = {
  end_keyword: "补 end",
  form_close: "补 @/?",
  form_prompt_merge: "提示并入",
  visual_swap: "台词头纠正",
  strip_continue: "断行续写",
};

/** Distance from the bottom inside which the panel keeps following. */
export const FOLLOW_THRESHOLD_PX = 32;

function fmtDuration(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtCount(n: number): string {
  return n.toLocaleString("zh-CN");
}

function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

interface RequestSection {
  task: WriterTaskModel;
  attempt: WriterAttemptModel;
  section: HTMLElement;
  boundary: HTMLElement;
  title: HTMLElement;
  meta: HTMLElement;
  notice: HTMLElement;
  view: DslStreamView;
  renderedText: string;
  finished: boolean;
}

export interface WriterPanelRefs {
  toolbar: HTMLElement;
  stream: HTMLElement;
  foot: HTMLElement;
}

export class WriterPanel {
  private readonly sections = new Map<string, RequestSection>();
  private followTail = true;
  /** Timestamp until which scroll events are our own programmatic scrolls. */
  private programmaticScrollUntil = 0;
  private highlightKey: string | null = null;
  private highlightView: DslStreamView | null = null;

  constructor(
    private readonly model: MonitorModel,
    private readonly refs: WriterPanelRefs,
  ) {
    refs.stream.addEventListener("scroll", () => {
      // Ignore the scroll events produced by our own scrollIntoView /
      // scrollTop assignments — they used to flip followTail off without
      // any user input and made "继续跟随" unable to stick.
      if (performance.now() < this.programmaticScrollUntil) return;
      const follows =
        refs.stream.scrollHeight - refs.stream.scrollTop - refs.stream.clientHeight <
        FOLLOW_THRESHOLD_PX;
      if (follows !== this.followTail) {
        this.followTail = follows;
        this.renderToolbar();
      }
    });
    model.subscribe((topic) => {
      if (topic === "writer") this.render();
      else if (topic === "state") this.highlightCurrent();
    });
    model.onEvent((event) => this.handleEvent(event));
    this.renderToolbar();
    this.renderFoot();
  }

  private handleEvent(event: MonitorServerEvent): void {
    if (!event.type.startsWith("writer.")) return;
    if (event.type === "writer.start") {
      this.syncDocument();
      this.updateBoundaries();
      this.scrollToPreferredPosition();
      return;
    }

    const attemptId = "attemptId" in event ? event.attemptId : null;
    if (attemptId === null) return;
    const existing = this.sections.get(attemptId);
    if (existing === undefined) {
      // Batched start/delta and reconnect snapshots can make the model aware
      // of text before the corresponding DOM section exists.
      this.syncDocument();
      this.updateBoundaries();
      this.scrollToPreferredPosition();
      return;
    }

    if (event.type === "writer.delta") {
      existing.view.append(event.text);
      existing.renderedText = existing.attempt.text;
    } else if (event.type === "writer.line") {
      existing.view.applyServerLine(event.lineIndex, event.kind, event.error);
    } else if (event.type === "writer.repair") {
      existing.view.markRepaired(event.repair.lineIndex);
    } else if (event.type === "writer.end") {
      existing.view.finish();
      existing.finished = true;
    }
    this.updateBoundary(existing);
    this.renderFoot();
    this.scrollToPreferredPosition();
  }

  render(): void {
    this.syncDocument();
    this.updateBoundaries();
    this.renderToolbar();
    this.renderFoot();
    this.scrollToPreferredPosition();
  }

  private orderedAttempts(): { task: WriterTaskModel; attempt: WriterAttemptModel }[] {
    return this.model.writerTasks
      .flatMap((task) => task.attempts.map((attempt) => ({ task, attempt })))
      .sort(
        (a, b) =>
          a.attempt.startedAt - b.attempt.startedAt ||
          a.attempt.index - b.attempt.index ||
          a.task.firstSeen - b.task.firstSeen,
      );
  }

  private syncDocument(): void {
    const ordered = this.orderedAttempts();
    const nextIds = ordered.map(({ attempt }) => attempt.attemptId);
    const currentIds = [...this.sections.keys()];
    const structureChanged =
      nextIds.length !== currentIds.length || nextIds.some((id, index) => id !== currentIds[index]);

    if (!structureChanged) {
      if (ordered.length === 0 && this.refs.stream.childElementCount === 0) {
        this.refs.stream.appendChild(el("div", "mon-empty", "暂无生成请求（等待玩家开始）"));
      }
      for (const { task, attempt } of ordered) {
        const request = this.sections.get(attempt.attemptId)!;
        request.task = task;
        request.attempt = attempt;
        this.reconcileRequestText(request);
      }
      return;
    }

    const appendOnly = currentIds.every((id, index) => id === nextIds[index]);
    if (appendOnly) {
      this.refs.stream.querySelector(":scope > .mon-empty")?.remove();
      for (const { task, attempt } of ordered.slice(0, currentIds.length)) {
        const request = this.sections.get(attempt.attemptId)!;
        request.task = task;
        request.attempt = attempt;
        this.reconcileRequestText(request);
      }
      for (const { task, attempt } of ordered.slice(currentIds.length)) {
        this.appendRequest(task, attempt);
      }
      return;
    }

    this.refs.stream.textContent = "";
    this.sections.clear();
    this.highlightKey = null;
    this.highlightView = null;
    if (ordered.length === 0) {
      this.refs.stream.appendChild(el("div", "mon-empty", "暂无生成请求（等待玩家开始）"));
      return;
    }

    for (const { task, attempt } of ordered) {
      this.appendRequest(task, attempt);
    }
  }

  private appendRequest(task: WriterTaskModel, attempt: WriterAttemptModel): void {
    const section = el("section", "writer-request");
    section.dataset.attemptId = attempt.attemptId;
    const boundary = el("header", "writer-request-boundary");
    const title = el("div", "writer-request-title");
    const meta = el("div", "writer-request-meta");
    const notice = el("div", "writer-request-notice");
    boundary.append(title, meta, notice);
    const body = el("div", "writer-request-stream");
    section.append(boundary, body);
    this.refs.stream.appendChild(section);

    const view = new DslStreamView(body);
    view.reset(this.model.knownSpeakers());
    if (attempt.text.length > 0) {
      if (attempt.state === "streaming") view.append(attempt.text);
      else view.replay(attempt.text);
    }
    // Repairs ride the attempt model — re-apply their row marks so a
    // reconnect snapshot or ring-replay keeps showing them.
    for (const repair of attempt.repairs) view.markRepaired(repair.lineIndex);
    this.sections.set(attempt.attemptId, {
      task,
      attempt,
      section,
      boundary,
      title,
      meta,
      notice,
      view,
      renderedText: attempt.text,
      finished: attempt.state !== "streaming",
    });
  }

  /** Bring an existing section up to date after a reconnect snapshot. */
  private reconcileRequestText(request: RequestSection): void {
    const nextText = request.attempt.text;
    if (nextText !== request.renderedText) {
      if (nextText.startsWith(request.renderedText)) {
        request.view.append(nextText.slice(request.renderedText.length));
      } else {
        // Ring truncation or a replaced snapshot: replay the authoritative
        // capped text rather than trying to splice incompatible streams.
        request.view.reset(this.model.knownSpeakers());
        if (request.attempt.state === "streaming") request.view.append(nextText);
        else request.view.replay(nextText);
        for (const repair of request.attempt.repairs) {
          request.view.markRepaired(repair.lineIndex);
        }
      }
      request.renderedText = nextText;
    }
    if (request.attempt.state !== "streaming" && !request.finished) {
      request.view.finish();
      request.finished = true;
    }
  }

  private updateBoundaries(): void {
    for (const request of this.sections.values()) this.updateBoundary(request);
  }

  private updateBoundary(request: RequestSection): void {
    const { task, attempt, boundary, title, meta, notice } = request;
    boundary.className = `writer-request-boundary state-${attempt.state}`;
    title.textContent = "";
    title.appendChild(el("span", `mon-dot state-${attempt.state}`));
    title.appendChild(
      el("strong", undefined, `${TASK_TYPE_LABELS[task.taskType] ?? task.taskType} · 请求 #${attempt.index + 1}`),
    );
    title.appendChild(el("span", "writer-request-time", fmtTime(attempt.startedAt)));
    title.appendChild(el("span", `writer-request-state state-${attempt.state}`, STATE_LABELS[attempt.state]));

    const elapsed =
      attempt.usage?.latencyMs ??
      (attempt.endedAt === null ? Date.now() - attempt.startedAt : attempt.endedAt - attempt.startedAt);
    const firstToken =
      attempt.firstTokenMs === null
        ? attempt.state === "streaming"
          ? "首字 等待中"
          : "首字 —"
        : `首字 ${fmtDuration(attempt.firstTokenMs)}`;
    const bits = [
      `耗时 ${fmtDuration(Math.max(0, elapsed))}`,
      firstToken,
      `字符 ${fmtCount(attempt.chars)}`,
      `行 ${attempt.lines}`,
      `事件 ${attempt.groups}`,
    ];
    if (attempt.usage !== null) {
      bits.push(`输入 ${fmtCount(attempt.usage.input)}`, `输出 ${fmtCount(attempt.usage.output)}`);
      if (attempt.usage.cachedInput > 0) bits.push(`缓存 ${attempt.usage.cachedInput}`);
      if (attempt.usage.source === "estimated") bits.push("token 估算");
    }
    if (attempt.segmentEnd !== null) bits.push(`收段 ${attempt.segmentEnd}`);
    if (attempt.truncated) bits.push("文本已截断");
    meta.textContent = bits.join(" · ");

    notice.textContent = "";
    if (attempt.repairs.length > 0) {
      for (const repair of attempt.repairs) {
        const label = REPAIR_KIND_LABELS[repair.kind] ?? repair.kind;
        notice.appendChild(
          el("span", "writer-repair", `[${label}] ${repair.message}`),
        );
      }
    }
    if (attempt.error !== null) notice.appendChild(el("span", "is-error-text", attempt.error));
  }

  private highlightCurrent(): boolean {
    const current = this.model.state?.session.currentDsl ?? null;
    const key = current === null ? null : `${current.attemptId}:${current.lineIndex}`;
    if (key === this.highlightKey) {
      return this.highlightView !== null;
    }
    // Only the previously highlighted view needs clearing — not every row
    // of every section on every event.
    this.highlightView?.highlight(null);
    this.highlightView = null;
    this.highlightKey = key;
    if (current === null) return false;
    const view = this.sections.get(current.attemptId)?.view ?? null;
    if (view === null) return false;
    const row = view.highlight(current.lineIndex);
    this.highlightView = view;
    if (row !== null && this.followTail && typeof row.scrollIntoView === "function") {
      // scrollIntoView fires a scroll event that would otherwise look like
      // user scrolling; shield the followTail heuristic briefly.
      this.programmaticScrollUntil = performance.now() + 120;
      row.scrollIntoView({ block: "center" });
    }
    return row !== null;
  }

  private renderToolbar(): void {
    const bar = this.refs.toolbar;
    bar.textContent = "";
    bar.appendChild(el("span", "writer-document-label", "连续请求文档"));
    bar.appendChild(el("span", "writer-document-count", `${this.orderedAttempts().length} 次请求`));
    const follow = el(
      "button",
      `mon-chip writer-follow${this.followTail ? " is-active" : ""}`,
      this.followTail ? "自动跟随中" : "继续跟随",
    );
    follow.addEventListener("click", () => {
      this.followTail = true;
      this.renderToolbar();
      this.scrollToPreferredPosition();
    });
    bar.appendChild(follow);
  }

  private renderFoot(): void {
    const foot = this.refs.foot;
    foot.textContent = "";
    const attempts = this.orderedAttempts().map(({ attempt }) => attempt);
    const active = attempts.filter((attempt) => attempt.state === "streaming").length;
    const totals = attempts.reduce(
      (sum, attempt) => ({
        chars: sum.chars + attempt.chars,
        lines: sum.lines + attempt.lines,
        groups: sum.groups + attempt.groups,
      }),
      { chars: 0, lines: 0, groups: 0 },
    );
    foot.appendChild(el("span", undefined, `请求 ${attempts.length}`));
    foot.appendChild(el("span", undefined, active > 0 ? `进行中 ${active}` : "当前空闲"));
    foot.appendChild(el("span", undefined, `累计 ${totals.chars} 字符 · ${totals.lines} 行 · ${totals.groups} 事件`));
  }

  private scrollToTail(force = false): void {
    if (force || this.followTail) {
      this.programmaticScrollUntil = performance.now() + 120;
      this.refs.stream.scrollTop = this.refs.stream.scrollHeight;
    }
  }

  private scrollToPreferredPosition(): void {
    const hasCurrentRow = this.highlightCurrent();
    if (!hasCurrentRow) this.scrollToTail();
  }
}
