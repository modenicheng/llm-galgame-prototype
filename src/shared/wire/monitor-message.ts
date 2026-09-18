/**
 * Monitor wire types — everything Node sends over the monitor WebSocket
 * (`/ws/monitor`, docs/monitor-dashboard.md).
 *
 * The channel is read-only: the dashboard never sends commands back, so
 * there is no client-message counterpart. Three message kinds:
 * - `monitor.snapshot` — full state on (re)connect;
 * - `monitor.event`    — batched live events (writer stream, context LLM,
 *   diagnostics), coalesced to ~25ms;
 * - `monitor.state`    — a changed game-state frame (~400ms polling).
 */
import type { GameMonitorState } from "../../core/runtime/monitor-state.js";
import type { MetricsSnapshot } from "../../runtime/metrics.js";
import type { RuntimeStatusSnapshot } from "../../status.js";

// ---------------------------------------------------------------------------
// Writer (screenwriter LLM) tasks
// ---------------------------------------------------------------------------

export type MonitorWriterTaskState = "streaming" | "done" | "failed" | "retried" | "cancelled";

export interface MonitorWriterAttempt {
  attemptId: string;
  index: number;
  state: MonitorWriterTaskState;
  startedAt: number;
  endedAt: number | null;
  chars: number;
  lines: number;
  groups: number;
  error: string | null;
  segmentEnd: string | null;
  /** Null until the first non-empty content delta arrives. */
  firstTokenMs?: number | null;
  usage?: MonitorWriterUsage | null;
  repairs?: MonitorWriterRepair[];
}

export interface MonitorWriterUsage {
  input: number;
  output: number;
  cachedInput: number;
  source: "api" | "estimated";
  latencyMs: number;
  /** Thinking tokens (subset of output); present when thinking ran. */
  reasoningTokens?: number;
  /** First reasoning delta → first content delta; thinking runs only. */
  thinkingMs?: number;
  /** Raw reasoning character count streamed via reasoning_content. */
  reasoningChars?: number;
}

export interface MonitorWriterRepair {
  kind:
    | "end_keyword"
    | "form_close"
    | "visual_swap"
    | "form_prompt_merge"
    | "strip_continue"
    | "sentinel_autoclose"
    | "narration_label";
  lineIndex: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Writer prompt audit (exact request payload, segmented by origin)
// ---------------------------------------------------------------------------

export interface MonitorWriterPromptSegment {
  /** Origin: repo file path or producing runtime pipeline. */
  source: string;
  label: string;
  /** Verbatim prompt slice (leading separators included); joining a
   * message's segment texts reproduces the content sent to the provider. */
  text: string;
  /** Set when the hub capped the segment text (audit view is partial). */
  truncated?: boolean;
}

export interface MonitorWriterPromptMessage {
  role: "system" | "user" | "assistant";
  segments: MonitorWriterPromptSegment[];
}

export interface MonitorWriterTask {
  taskId: string;
  taskType: string;
  /**
   * 生成片 id：原始生成与其 Game 级修复续写共享同片（修复续写发新
   * nonce ⇒ taskId 不同）。面板据此把同一生成片的多次生成原位替换
   * 展示；null = 该任务未携带片 id（按独立片处理）。
   */
  sliceId?: string | null;
  startedAt: number;
  lastActivityAt: number;
  attempts: MonitorWriterAttempt[];
}

/** Snapshot form: attempts carry their full (possibly capped) DSL text and
 * their request payloads (system message stripped — it is session-invariant
 * and carried once on the snapshot itself). */
export interface MonitorWriterAttemptWithText extends MonitorWriterAttempt {
  text: string;
  truncated: boolean;
  /** Indexed by requestIndex within the attempt (0 = initial request,
   * 1+ = strip-continue follow-ups); user/assistant messages only. */
  prompt?: { requests: MonitorWriterPromptMessage[][] };
}

export interface MonitorWriterTaskWithText extends Omit<MonitorWriterTask, "attempts"> {
  attempts: MonitorWriterAttemptWithText[];
}

// ---------------------------------------------------------------------------
// Background context-management LLM tasks (recap / consolidation / planner)
// ---------------------------------------------------------------------------

export type MonitorContextTaskKind = "recap" | "consolidation" | "plot_plan";
export type MonitorContextTaskState = "running" | "done" | "fallback" | "failed";

export interface MonitorContextTask {
  id: string;
  kind: MonitorContextTaskKind;
  state: MonitorContextTaskState;
  startedAt: number;
  endedAt: number | null;
  /** Human-readable input summary, e.g. "事件 21–40（20 条）". */
  detail: string;
  output: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Diagnostics ring
// ---------------------------------------------------------------------------

export interface MonitorDiagnosticEntry {
  at: number;
  level: "info" | "warn";
  scope: string;
  message: string;
}

// ---------------------------------------------------------------------------
// State frame + snapshot
// ---------------------------------------------------------------------------

export interface MonitorStateFrame {
  at: number;
  session: GameMonitorState;
  status: RuntimeStatusSnapshot;
  metrics: MetricsSnapshot;
  /**
   * 写手 DSL 流落盘目录（observability，绝对路径）；null/缺省 = 未开启
   * 落盘。文件经 `/monitor/records/…` 只读路由访问（需会话 token）。
   */
  recordDir?: string | null;
}

/** Static facts the dashboard labels panels with. */
export interface MonitorInfo {
  model: string;
  narrativeMode: string;
  apiBaseUrl: string;
  knownSpeakers: string[];
  textBuffer: { startThresholdLines: number; targetLines: number; refillThresholdLines: number };
  eventMode: { wrapupInteractions: number; closingPushInteractions: number; maxInteractions: number };
}

export interface MonitorSnapshot {
  at: number;
  info: MonitorInfo;
  /** Newest first, capped. `systemPrompt` is the session-invariant writer
   * system message (segmented), sent once instead of per attempt. */
  writer: {
    tasks: MonitorWriterTaskWithText[];
    systemPrompt?: MonitorWriterPromptMessage | null;
  };
  /** Newest first, capped. */
  context: { tasks: MonitorContextTask[] };
  /** Oldest → newest tail, capped. */
  diagnostics: MonitorDiagnosticEntry[];
  state: MonitorStateFrame;
}

export type MonitorServerEvent =
  | { type: "writer.start"; task: MonitorWriterTask }
  | {
      /** The exact prompt messages of one LLM call (audit view); fires right
       * after the attempt's writer.start and again per strip-continue
       * follow-up. Includes the system message — clients fold it idempotently. */
      type: "writer.prompt";
      attemptId: string;
      requestIndex: number;
      messages: MonitorWriterPromptMessage[];
    }
  | { type: "writer.delta"; attemptId: string; text: string; firstTokenMs?: number | null }
  | {
      type: "writer.line";
      attemptId: string;
      lineIndex: number;
      kind: string | null;
      error: string | null;
    }
  | { type: "writer.group"; attemptId: string; groupIndex: number; kind: string; summary: string }
  | { type: "writer.repair"; attemptId: string; repair: MonitorWriterRepair }
  | { type: "writer.usage"; attemptId: string; usage: MonitorWriterUsage }
  | {
      type: "writer.end";
      taskId: string;
      attemptId: string;
      state: MonitorWriterTaskState;
      error: string | null;
      segmentEnd: string | null;
    }
  | { type: "context.start"; task: MonitorContextTask }
  | { type: "context.end"; task: MonitorContextTask }
  | { type: "diagnostics"; entry: MonitorDiagnosticEntry };

export type MonitorServerMessage =
  | { type: "monitor.snapshot"; snapshot: MonitorSnapshot }
  | { type: "monitor.event"; events: MonitorServerEvent[] }
  | { type: "monitor.state"; state: MonitorStateFrame };
