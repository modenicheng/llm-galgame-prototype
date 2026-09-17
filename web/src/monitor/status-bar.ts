/**
 * StatusBar — the VSCode-like bottom bar: connection, session, phase,
 * buffer fill (with thresholds), scheduler, ending ladder, token usage.
 */
import type { MonitorModel, WriterTaskModel } from "./monitor-model.js";
import { el } from "../ui/dom.js";

export interface StatusBarRefs {
  bar: HTMLElement;
}

function seg(text: string, cls?: string): HTMLElement {
  const s = el("span", "seg");
  if (cls !== undefined) s.classList.add(cls);
  s.textContent = text;
  return s;
}

function icon(name: string, cls?: string): HTMLElement {
  const s = el("span", `ico ico-${name}`);
  if (cls !== undefined) s.classList.add(cls);
  s.setAttribute("aria-hidden", "true");
  return s;
}

const TASK_LABELS: Record<string, string> = {
  opening: "开场",
  continuation: "续写",
  branch_prefetch: "分支预取",
  input_response: "输入回应",
  input_bridge: "桥接",
  recovery: "恢复",
  ending: "结局",
};

/** Scheduler phase → status bar icon (fallback: plain chevron). */
const PHASE_ICONS: Record<string, string> = {
  开场生成: "sparkles",
  后台续写: "rotate-cw",
  等待选择: "list",
  等待输入: "text-cursor-input",
  输入预览: "pencil",
  切换分支: "split",
  强制收束: "flag",
  结束: "square",
  恢复生成: "history",
};

export type GenerationStatus =
  | { phase: "requesting"; taskType: string; waitMs: number }
  | { phase: "streaming"; taskType: string; firstTokenMs: number }
  | {
      phase: "idle";
      lastFirstTokenMs: number | null;
      lastLatencyMs: number | null;
      lastFailed: boolean;
    };

/** Derive the transport-level writer state independently of the scheduler. */
export function deriveGenerationStatus(
  tasks: readonly WriterTaskModel[],
  now = Date.now(),
): GenerationStatus {
  const attempts = tasks
    .flatMap((task) => task.attempts.map((attempt) => ({ task, attempt })))
    .sort((a, b) => b.attempt.startedAt - a.attempt.startedAt);
  const active = attempts.find(({ attempt }) => attempt.state === "streaming");
  if (active !== undefined) {
    if (active.attempt.firstTokenMs === null) {
      return {
        phase: "requesting",
        taskType: active.task.taskType,
        waitMs: Math.max(0, now - active.attempt.startedAt),
      };
    }
    return {
      phase: "streaming",
      taskType: active.task.taskType,
      firstTokenMs: active.attempt.firstTokenMs,
    };
  }
  const latest = attempts[0]?.attempt;
  return {
    phase: "idle",
    lastFirstTokenMs: latest?.firstTokenMs ?? null,
    lastLatencyMs:
      latest?.usage?.latencyMs ??
      (latest?.endedAt !== null && latest?.endedAt !== undefined
        ? Math.max(0, latest.endedAt - latest.startedAt)
        : null),
    lastFailed: latest !== undefined && latest.state === "failed",
  };
}

function fmtMs(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtInt(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** Page-URL session token as a query string; the /monitor URL always carries it. */
function sessionTokenQuery(): string {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  return token.length > 0 ? `?token=${encodeURIComponent(token)}` : "";
}

export class StatusBar {
  private readonly model: MonitorModel;
  private readonly refs: StatusBarRefs;
  private requestTicker: number | null = null;
  private generationPhase: GenerationStatus["phase"] = "idle";

  constructor(model: MonitorModel, refs: StatusBarRefs) {
    this.model = model;
    this.refs = refs;
    model.subscribe((topic) => {
      if (topic === "state" || topic === "connection" || topic === "writer") this.render();
    });
    model.onEvent((event) => {
      if (
        event.type === "writer.start" ||
        event.type === "writer.end" ||
        (event.type === "writer.delta" && this.generationPhase === "requesting")
      ) {
        this.render();
      }
    });
  }

  render(): void {
    const bar = this.refs.bar;
    bar.textContent = "";

    const conn = el("span", `seg conn-${this.model.connection}`);
    conn.title =
      this.model.connection === "open"
        ? "已连接"
        : this.model.connection === "connecting"
          ? "连接中"
          : "未连接";
    conn.appendChild(el("span", "dot"));
    bar.appendChild(conn);

    const info = this.model.info;
    if (info !== null) {
      const modelSeg = seg(`${info.model}·${info.narrativeMode}`);
      modelSeg.title = `模型 ${info.model} · 叙事模式 ${info.narrativeMode}`;
      bar.appendChild(modelSeg);
    }

    const state = this.model.state;
    if (state === null) {
      bar.appendChild(seg("等待数据…", "grow"));
      return;
    }
    const session = state.session;
    const status = state.status;

    const sessionSeg = seg(session.sessionId.length > 0 ? session.sessionId : "—");
    sessionSeg.prepend(icon("hash"));
    sessionSeg.title = session.sessionId.length > 0 ? `会话 ${session.sessionId}` : "无会话";
    bar.appendChild(sessionSeg);

    const phaseSeg = el("span", "seg");
    phaseSeg.title = `${status.phase} · ${status.message}`;
    phaseSeg.appendChild(icon(PHASE_ICONS[status.phase] ?? "chevron-right"));
    phaseSeg.appendChild(el("span", undefined, status.phase));
    bar.appendChild(phaseSeg);

    // Buffer fill with the configured refill target as the scale.
    const target = Math.max(1, info?.textBuffer.targetLines ?? 6);
    const lines = status.bufferedDialogueLines;
    const bufSeg = el("span", "seg");
    bufSeg.title = `缓冲 ${lines}/${target} 行 · 待播 ${session.buffer.textLinesAhead} 句 · ${session.buffer.pending} 事件`;
    const track = el("span", "buf-track");
    const fill = el("span", `buf-fill${lines >= (info?.textBuffer.refillThresholdLines ?? 4) ? " is-ok" : ""}`);
    fill.style.width = `${Math.min(100, Math.round((lines / target) * 100))}%`;
    track.appendChild(fill);
    bufSeg.appendChild(track);
    bufSeg.appendChild(el("span", undefined, `${lines}/${target}`));
    bufSeg.appendChild(
      el("span", undefined, `${session.buffer.textLinesAhead} 句待播 · ${session.buffer.pending} 事件`),
    );
    bar.appendChild(bufSeg);

    const generation = deriveGenerationStatus(this.model.writerTasks);
    this.generationPhase = generation.phase;
    this.syncRequestTicker(generation.phase === "requesting");
    const task = generation.phase === "idle" ? "" : (TASK_LABELS[generation.taskType] ?? generation.taskType);
    const generationSeg = el("span", `seg gen-${generation.phase}`);
    if (generation.phase === "requesting") {
      generationSeg.title = `请求中 · ${task} · 等待首字 ${fmtMs(generation.waitMs)}`;
      generationSeg.appendChild(icon("loader-circle", "spin"));
      generationSeg.appendChild(el("span", undefined, `${task}·${fmtMs(generation.waitMs)}`));
    } else if (generation.phase === "streaming") {
      generationSeg.title = `生成中 · ${task} · 首字 ${fmtMs(generation.firstTokenMs)}`;
      generationSeg.appendChild(icon("play"));
      generationSeg.appendChild(el("span", undefined, `${task}·${fmtMs(generation.firstTokenMs)}`));
    } else {
      const parts = [
        ...(generation.lastFirstTokenMs === null ? [] : [fmtMs(generation.lastFirstTokenMs)]),
        ...(generation.lastLatencyMs === null ? [] : [fmtMs(generation.lastLatencyMs)]),
      ];
      generationSeg.appendChild(
        icon(generation.lastFailed ? "x" : "check", generation.lastFailed ? undefined : "ok"),
      );
      if (parts.length > 0) {
        generationSeg.appendChild(el("span", undefined, parts.join("·")));
        generationSeg.title = generation.lastFailed
          ? `上次请求失败 · 耗时 ${parts.join(" · ")}`
          : `空闲 · 上次首字/耗时 ${parts.join(" / ")}`;
      } else {
        generationSeg.title = "空闲";
      }
    }
    generationSeg.dataset.generationPhase = generation.phase;
    bar.appendChild(generationSeg);

    // Ending ladder (event mode).
    const pressure = session.endingPressure;
    const level = pressure.forceEnding ? 3 : pressure.level;
    const pressureSeg = el("span", "seg");
    pressureSeg.title = `分级收束 ${["正常", "L1 收束", "L2 强收束", "L3 强制结局"][level] ?? "正常"} · 交互进度`;
    pressureSeg.appendChild(el("span", `lvl lvl-${level}`, `L${level}`));
    pressureSeg.appendChild(icon("arrow-left-right"));
    pressureSeg.appendChild(
      el("span", undefined, `${pressure.interactionCount}/${pressure.maxAt > 0 ? pressure.maxAt : "∞"}`),
    );
    bar.appendChild(pressureSeg);

    // 结局档位（@ending）：会话出现终局事件后展示档位与结尾词。
    const endEntry = [...session.timeline].reverse().find((entry) => entry.kind === "end");
    if (endEntry !== undefined) {
      const grade = endEntry.endingGrade ?? "NE";
      const endSeg = el("span", `seg ending-grade ending-grade--${grade.toLowerCase()}`);
      endSeg.title = `结局 [${grade}] ${endEntry.endingTitle ?? "（无结尾词）"} · ${endEntry.endingId ?? ""}`;
      endSeg.appendChild(el("span", undefined, `终·${grade}`));
      if (endEntry.endingTitle !== undefined) {
        endSeg.appendChild(el("span", undefined, endEntry.endingTitle));
      }
      bar.appendChild(endSeg);
    }

    // Token usage.
    const llm = state.metrics.llm;
    const requests = Object.values(llm.requests).reduce((sum, n) => sum + n, 0);
    const tokenSeg = el("span", "seg");
    tokenSeg.title = `输入 ${llm.tokens.input} token · 输出 ${llm.tokens.output} token · 缓存命中 ${(llm.cache_hit_rate * 100).toFixed(0)}% · 请求 ${requests} 次`;
    tokenSeg.appendChild(icon("arrow-up"));
    tokenSeg.appendChild(el("span", undefined, fmtInt(llm.tokens.input)));
    tokenSeg.appendChild(icon("arrow-down"));
    tokenSeg.appendChild(el("span", undefined, fmtInt(llm.tokens.output)));
    tokenSeg.appendChild(icon("database"));
    tokenSeg.appendChild(el("span", undefined, `${(llm.cache_hit_rate * 100).toFixed(0)}%`));
    tokenSeg.appendChild(el("span", undefined, `请求 ${requests}`));
    bar.appendChild(tokenSeg);

    // 落盘记录（observability）：写手 DSL 流全量留档；点击打开会话 index。
    const recordDir = state.recordDir;
    if (recordDir !== undefined && recordDir !== null) {
      const recordLink = el("a", "seg seg-record", "落盘记录");
      recordLink.href = `/monitor/records/index.jsonl${sessionTokenQuery()}`;
      recordLink.target = "_blank";
      recordLink.rel = "noreferrer";
      recordLink.title = `写手 DSL 流落盘目录：${recordDir}`;
      bar.appendChild(recordLink);
    }

    bar.appendChild(seg(`事件 ${session.eventCount}`));

    const spacer = el("span", "seg grow");
    bar.appendChild(spacer);
  }

  private syncRequestTicker(requesting: boolean): void {
    if (requesting && this.requestTicker === null) {
      this.requestTicker = window.setInterval(() => this.render(), 250);
    } else if (!requesting && this.requestTicker !== null) {
      window.clearInterval(this.requestTicker);
      this.requestTicker = null;
    }
  }

  /** Stop the live ticker (page teardown / panel replacement). */
  dispose(): void {
    this.syncRequestTicker(false);
  }
}
