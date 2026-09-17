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
}

export interface MonitorWriterRepair {
  kind: "end_keyword" | "form_close" | "visual_swap";
  lineIndex: number;
  message: string;
}

export interface MonitorWriterTask {
  taskId: string;
  taskType: string;
  startedAt: number;
  lastActivityAt: number;
  attempts: MonitorWriterAttempt[];
}

/** Snapshot form: attempts carry their full (possibly capped) DSL text. */
export interface MonitorWriterAttemptWithText extends MonitorWriterAttempt {
  text: string;
  truncated: boolean;
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
  /** Newest first, capped. */
  writer: { tasks: MonitorWriterTaskWithText[] };
  /** Newest first, capped. */
  context: { tasks: MonitorContextTask[] };
  /** Oldest → newest tail, capped. */
  diagnostics: MonitorDiagnosticEntry[];
  state: MonitorStateFrame;
}

export type MonitorServerEvent =
  | { type: "writer.start"; task: MonitorWriterTask }
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
