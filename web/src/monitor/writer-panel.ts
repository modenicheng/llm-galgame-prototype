/**
 * One chronological, auto-following document of writer generations grouped
 * into slices（生成片）: a failed generation and its Game-level repair
 * continuations share one slice. Document order mirrors PLAY order: the
 * original generation first (its streamed lines reached the player), each
 * repair continuation inserted AFTER it under a small subdued in-block
 * banner. In-place replacement/collapse only happens BETWEEN repair rounds
 * (failed rounds were discarded unreplayed) — the original block is never
 * collapsed. Request boundaries carry latency, token, repair and parse
 * telemetry.
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
  sentinel_autoclose: "补哨兵",
  narration_label: "剥旁白标签",
  tail_narration: "台词尾旁白?",
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

/** Page-URL session token as a query string; the /monitor URL always carries it. */
function sessionTokenQuery(): string {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  return token.length > 0 ? `?token=${encodeURIComponent(token)}` : "";
}

interface RequestSection {
  task: WriterTaskModel;
  attempt: WriterAttemptModel;
  /** 生成片内第几次生成（1 起，按任务时间序）。 */
  generation: number;
  /** 片内修复续写次数（任务数 − 1，展示在片边界上）。 */
  repairsInSlice: number;
  /** 横幅形态：原片=完整 boundary；修复轮次=块内小型 banner。 */
  banner: "full" | "mini";
  boundary: HTMLElement;
  title: HTMLElement;
  meta: HTMLElement;
  notice: HTMLElement;
  /** 折叠头（同轮重试等）；无折叠时为 null。 */
  summary: HTMLElement | null;
  view: DslStreamView;
  renderedText: string;
  finished: boolean;
}

interface SliceAttempt {
  task: WriterTaskModel;
  attempt: WriterAttemptModel;
  generation: number;
}

interface SliceGroup {
  sliceKey: string;
  taskType: string;
  /** 按最早 attempt 时间排序后的全部尝试（末位 = 最新生成，原位展示）。 */
  attempts: SliceAttempt[];
  startedAt: number;
  /** 片内修复续写次数 = 任务数 − 1。 */
  repairs: number;
}

export interface WriterPanelRefs {
  toolbar: HTMLElement;
  stream: HTMLElement;
  foot: HTMLElement;
}

/** 工具栏生成片过滤（纯展示层：只隐藏整片，不改数据与底部累计）。 */
export type SliceFilter = "all" | "failed" | "repairs";

const SLICE_FILTERS: { id: SliceFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "failed", label: "仅失败" },
  { id: "repairs", label: "仅修复" },
];

export class WriterPanel {
  private readonly sections = new Map<string, RequestSection>();
  /** Live slice sections keyed by sliceKey (incremental document sync). */
  private readonly sliceSections = new Map<string, {
    element: HTMLElement;
    signature: string;
    attemptIds: string[];
  }>();
  private followTail = true;
  /** Timestamp until which scroll events are our own programmatic scrolls. */
  private programmaticScrollUntil = 0;
  private highlightKey: string | null = null;
  private highlightView: DslStreamView | null = null;
  private sliceFilter: SliceFilter = "all";
  /** 已同步到 DOM 的过滤条件——片的 signature 不含它，切换时需整体重建。 */
  private appliedFilter: SliceFilter = "all";

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

  // -------------------------------------------------------------------------
  // Slice grouping（生成片：原始生成 + 其 Game 级修复续写共享同片）
  // -------------------------------------------------------------------------

  private orderedSlices(filter: SliceFilter = this.sliceFilter): SliceGroup[] {
    const groups = new Map<string, {
      sliceKey: string;
      taskType: string;
      tasks: WriterTaskModel[];
      startedAt: number;
    }>();
    for (const task of this.model.writerTasks) {
      // sliceId 缺省（旧事件 / 独立任务）时退化为按任务各占一片。
      const sliceKey = task.sliceId ?? task.taskId;
      let group = groups.get(sliceKey);
      if (group === undefined) {
        group = {
          sliceKey,
          taskType: task.taskType,
          tasks: [],
          startedAt: Number.POSITIVE_INFINITY,
        };
        groups.set(sliceKey, group);
      }
      group.tasks.push(task);
      const earliest =
        task.attempts.length > 0
          ? Math.min(...task.attempts.map((attempt) => attempt.startedAt))
          : task.startedAt;
      group.startedAt = Math.min(group.startedAt, earliest);
    }

    const slices: SliceGroup[] = [];
    for (const group of groups.values()) {
      group.tasks.sort(
        (a, b) => firstStartedAt(a) - firstStartedAt(b) || a.firstSeen - b.firstSeen,
      );
      const attempts: SliceAttempt[] = [];
      group.tasks.forEach((task, taskIndex) => {
        for (const attempt of task.attempts) {
          attempts.push({ task, attempt, generation: taskIndex + 1 });
        }
      });
      attempts.sort(
        (a, b) =>
          a.attempt.startedAt - b.attempt.startedAt ||
          a.generation - b.generation ||
          a.attempt.index - b.attempt.index,
      );
      slices.push({
        sliceKey: group.sliceKey,
        taskType: group.taskType,
        attempts,
        startedAt: group.startedAt,
        repairs: group.tasks.length - 1,
      });
    }
    slices.sort((a, b) => a.startedAt - b.startedAt || a.sliceKey.localeCompare(b.sliceKey));
    return this.applySliceFilter(slices, filter);
  }

  private applySliceFilter(slices: SliceGroup[], filter: SliceFilter): SliceGroup[] {
    if (filter === "failed") {
      return slices.filter((slice) =>
        slice.attempts.some((entry) => entry.attempt.state === "failed"),
      );
    }
    if (filter === "repairs") {
      return slices.filter((slice) => slice.repairs > 0);
    }
    return slices;
  }

  // -------------------------------------------------------------------------
  // Document assembly
  // -------------------------------------------------------------------------

  private syncDocument(): void {
    if (this.appliedFilter !== this.sliceFilter) {
      // 切换过滤：片的 signature 不含过滤条件，整体重建文档最省心。
      this.appliedFilter = this.sliceFilter;
      this.sliceSections.clear();
      this.sections.clear();
      this.highlightKey = null;
      this.highlightView = null;
      this.refs.stream.textContent = "";
    }
    const slices = this.orderedSlices();
    if (slices.length === 0) {
      if (this.sliceSections.size > 0) {
        this.sliceSections.clear();
        this.sections.clear();
        this.highlightKey = null;
        this.highlightView = null;
        this.refs.stream.textContent = "";
      }
      if (this.refs.stream.childElementCount === 0) {
        this.refs.stream.appendChild(
          el(
            "div",
            "mon-empty",
            this.appliedFilter === "all"
              ? "暂无生成请求（等待玩家开始）"
              : "当前过滤条件下没有生成片",
          ),
        );
      }
      return;
    }
    this.refs.stream.querySelector(":scope > .mon-empty")?.remove();

    // Incremental per-slice sync: an unchanged slice keeps its DOM node
    // (streaming must not rebuild the document under the auditor); a slice
    // whose attempt list changed (repair continuation joined, retry attempt)
    // is rebuilt in place; evicted slices (ring) drop out.
    const seen = new Set<string>();
    for (const slice of slices) {
      seen.add(slice.sliceKey);
      const signature = `${slice.repairs}[${slice.attempts.map((entry) => entry.attempt.attemptId).join(",")}]`;
      const existing = this.sliceSections.get(slice.sliceKey);
      if (existing !== undefined && existing.signature === signature) {
        this.rebindSlice(slice);
        continue;
      }
      const element = this.buildSliceElement(slice);
      if (existing !== undefined) {
        existing.element.replaceWith(element);
      } else {
        this.refs.stream.appendChild(element);
      }
      this.sliceSections.set(slice.sliceKey, {
        element,
        signature,
        attemptIds: slice.attempts.map((entry) => entry.attempt.attemptId),
      });
      this.highlightKey = null;
      this.highlightView = null;
    }

    for (const [sliceKey, entry] of [...this.sliceSections]) {
      if (seen.has(sliceKey)) continue;
      for (const attemptId of entry.attemptIds) this.sections.delete(attemptId);
      entry.element.remove();
      this.sliceSections.delete(sliceKey);
      this.highlightKey = null;
      this.highlightView = null;
    }

    // Re-affirm chronological slice order (insertions are append-only in
    // practice; this guards the tiebreak/eviction corner cases).
    slices.forEach((slice, index) => {
      const element = this.sliceSections.get(slice.sliceKey)?.element;
      if (element === undefined) return;
      const current = this.refs.stream.children[index];
      if (current !== element) {
        this.refs.stream.insertBefore(element, current ?? null);
      }
    });
  }

  /** Refresh model bindings + catch up text of an unchanged slice. */
  private rebindSlice(slice: SliceGroup): void {
    for (const entry of slice.attempts) {
      const request = this.sections.get(entry.attempt.attemptId);
      if (request === undefined) continue;
      request.task = entry.task;
      request.attempt = entry.attempt;
      request.generation = entry.generation;
      request.repairsInSlice = slice.repairs;
      this.reconcileRequestText(request);
    }
  }

  /**
   * Build one slice section: 原片在前（完整 boundary，永不折叠——它的流式
   * 内容是玩家实际看到过的），修复续写按轮次插在原片之后，用块内小型
   * banner 分割；覆盖折叠只发生在修复轮次之间（失败轮次未播出）。
   */
  private buildSliceElement(slice: SliceGroup): HTMLElement {
    const section = el("section", "writer-request");
    section.dataset.sliceKey = slice.sliceKey;
    if (slice.repairs > 0) section.dataset.repairs = String(slice.repairs);

    // 按生成轮次分组（1=原片，2+=修复续写轮次），组内保持尝试先后。
    const rounds: SliceAttempt[][] = [];
    for (const entry of slice.attempts) {
      const round = (rounds[entry.generation - 1] ??= []);
      round.push(entry);
    }

    rounds.forEach((round, roundIndex) => {
      const isRepair = roundIndex > 0;
      const isLatestRound = roundIndex === rounds.length - 1;
      const latest = round[round.length - 1]!;
      const bannerKind = isRepair ? "mini" : "full";

      if (isRepair && !isLatestRound) {
        // 被更新的修复轮覆盖：旧修复轮折叠在原位（数据未删，展开审计）。
        const details = el("details", "writer-history-item");
        details.appendChild(
          el(
            "summary",
            "writer-history-summary",
            `被覆盖的修复 · 生成 #${roundIndex + 1} · ${STATE_LABELS[latest.attempt.state]} · ${fmtTime(latest.attempt.startedAt)}`,
          ),
        );
        const block = this.buildBlock(slice, latest, null, "mini");
        this.sections.set(latest.attempt.attemptId, block.section);
        details.append(block.boundary, block.body);
        section.appendChild(details);
        return;
      }

      const block = this.buildBlock(slice, latest, null, bannerKind);
      this.sections.set(latest.attempt.attemptId, block.section);
      section.append(block.boundary, block.body);

      // 同轮重试（网络层重发等，未播出）折叠在该轮次块之后。
      if (round.length > 1) {
        const details = el("details", "writer-history-item");
        details.appendChild(
          el("summary", "writer-history-summary", `重试 ×${round.length - 1}（展开审计，数据未删）`),
        );
        for (const entry of round.slice(0, -1)) {
          const retryBlock = this.buildBlock(slice, entry, null, bannerKind);
          details.append(retryBlock.boundary, retryBlock.body);
          this.sections.set(entry.attempt.attemptId, retryBlock.section);
        }
        section.appendChild(details);
      }
    });
    return section;
  }

  /** Build one attempt block（原片=完整 boundary；修复轮次=块内小型 banner）。 */
  private buildBlock(
    slice: SliceGroup,
    entry: SliceAttempt,
    summary: HTMLElement | null,
    banner: "full" | "mini",
  ): {
    section: RequestSection;
    boundary: HTMLElement;
    body: HTMLElement;
  } {
    const boundary = el(
      "header",
      banner === "mini" ? "writer-repair-banner" : "writer-request-boundary",
    );
    const title = el("div", "writer-request-title");
    const meta = el("div", "writer-request-meta");
    const notice = el("div", "writer-request-notice");
    boundary.append(title, meta, notice);
    const body = el("div", "writer-request-stream");
    const view = new DslStreamView(body);
    view.reset(this.model.knownSpeakers());
    if (entry.attempt.text.length > 0) {
      if (entry.attempt.state === "streaming") view.append(entry.attempt.text);
      else view.replay(entry.attempt.text);
    }
    // Repairs ride the attempt model — re-apply their row marks so a
    // reconnect snapshot or ring-replay keeps showing them.
    for (const repair of entry.attempt.repairs) view.markRepaired(repair.lineIndex);
    const section: RequestSection = {
      task: entry.task,
      attempt: entry.attempt,
      generation: entry.generation,
      repairsInSlice: slice.repairs,
      banner,
      boundary,
      title,
      meta,
      notice,
      summary,
      view,
      renderedText: entry.attempt.text,
      finished: entry.attempt.state !== "streaming",
    };
    this.updateBoundary(section);
    return { section, boundary, body };
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
    const { task, attempt, boundary, title, meta, notice, summary, banner } = request;
    boundary.className =
      banner === "mini"
        ? `writer-repair-banner state-${attempt.state}`
        : `writer-request-boundary state-${attempt.state}`;
    const taskLabel = TASK_TYPE_LABELS[task.taskType] ?? task.taskType;

    title.textContent = "";
    title.appendChild(el("span", `mon-dot state-${attempt.state}`));
    if (banner === "mini") {
      // 修复轮次的小横幅：弱化、块内、作为多次生成的分割。
      title.appendChild(el("strong", undefined, `修复续写 · 生成 #${request.generation}`));
    } else {
      title.appendChild(el("strong", undefined, `${taskLabel} · 生成 #${request.generation}`));
      if (request.repairsInSlice > 0) {
        title.appendChild(
          el("span", "mon-chip writer-repair-chip", `修复续写 ×${request.repairsInSlice}`),
        );
      }
    }
    title.appendChild(el("span", "writer-request-time", fmtTime(attempt.startedAt)));
    title.appendChild(el("span", `writer-request-state state-${attempt.state}`, STATE_LABELS[attempt.state]));
    // 落盘记录入口：该 attempt 的原始流全文（其余文件见记录目录 index）。
    const recordDir = this.model.state?.recordDir;
    if (recordDir !== undefined && recordDir !== null) {
      const recordLink = el("a", "writer-record-link", "落盘↗");
      recordLink.href = `/monitor/records/by-attempt/${encodeURIComponent(attempt.attemptId)}/output.raw.txt${sessionTokenQuery()}`;
      recordLink.target = "_blank";
      recordLink.rel = "noreferrer";
      recordLink.title = `落盘记录 ${recordDir}（prompts.jsonl / output.raw.txt / events.jsonl）`;
      title.appendChild(recordLink);
    }

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
      if (attempt.usage.cachedInput > 0) bits.push(`缓存 ${fmtCount(attempt.usage.cachedInput)}`);
      if (attempt.usage.source === "estimated") bits.push("token 估算");
      if (attempt.usage.reasoningTokens !== undefined) {
        bits.push(
          `思考 ${fmtDuration(attempt.usage.thinkingMs ?? 0)}·${fmtCount(attempt.usage.reasoningTokens)}tok`,
        );
      }
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

    // History blocks keep a one-line collapsed summary (audit at a glance).
    if (summary !== null) {
      summary.textContent = [
        `生成 #${request.generation}`,
        `尝试 ${attempt.index + 1}`,
        STATE_LABELS[attempt.state],
        `行 ${attempt.lines}`,
        fmtTime(attempt.startedAt),
        ...(attempt.error !== null ? [`错误：${attempt.error.slice(0, 80)}`] : []),
      ].join(" · ");
    }
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
    const slices = this.orderedSlices();
    const attempts = slices.reduce((sum, slice) => sum + slice.attempts.length, 0);
    bar.appendChild(el("span", "writer-document-label", "生成片连续文档"));
    bar.appendChild(
      el("span", "writer-document-count", `${slices.length} 片 · ${attempts} 次请求`),
    );
    for (const option of SLICE_FILTERS) {
      const chip = el(
        "button",
        `mon-chip writer-filter${this.sliceFilter === option.id ? " is-active" : ""}`,
        option.label,
      );
      chip.addEventListener("click", () => {
        if (this.sliceFilter === option.id) return;
        this.sliceFilter = option.id;
        this.render();
      });
      bar.appendChild(chip);
    }
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
    // foot 是全量累计口径，不随工具栏过滤变化。
    const slices = this.orderedSlices("all");
    const attempts = slices.flatMap((slice) => slice.attempts.map((entry) => entry.attempt));
    const active = attempts.filter((attempt) => attempt.state === "streaming").length;
    const totals = attempts.reduce(
      (sum, attempt) => ({
        chars: sum.chars + attempt.chars,
        lines: sum.lines + attempt.lines,
        groups: sum.groups + attempt.groups,
      }),
      { chars: 0, lines: 0, groups: 0 },
    );
    foot.appendChild(el("span", undefined, `生成片 ${slices.length} · 请求 ${attempts.length}`));
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

function firstStartedAt(task: WriterTaskModel): number {
  return task.attempts.length > 0 ? task.attempts[0]!.startedAt : task.startedAt;
}
