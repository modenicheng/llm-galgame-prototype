/**
 * MonitorHub — the monitor dashboard's server-side state store
 * (docs/monitor-dashboard.md).
 *
 * Collects three event streams and one polled frame:
 * - writer LLM: taps StoryGenerator via DslStreamObserver (raw deltas,
 *   per-line parse results, committed groups, attempt outcomes);
 * - background context LLMs: recap / consolidation / plot-plan tasks,
 *   instrumented at the port boundary (lifecycle + final output — these
 *   calls do not stream);
 * - diagnostics: every DiagnosticSink info/warn fan-out;
 * - game state: polls `GameMonitorState` + status + metrics and pushes a
 *   frame only when its JSON changed.
 *
 * Everything is bounded (ring caps) so a long session cannot grow the
 * dashboard's memory. `subscribe` listeners receive the coalesced live
 * events and state frames; `/ws/monitor` forwards them verbatim.
 */
import type {
  DslStreamObserver,
  WriterAttemptEnd,
  WriterAttemptInfo,
  WriterAttemptUsage,
  WriterLineParse,
  WriterPromptMessage,
  WriterPromptReport,
  WriterRepair,
} from "../../core/ports/dsl-stream-observer.js";
import type { GameMonitorState } from "../../core/runtime/monitor-state.js";
import type { Metrics, MetricsSnapshot } from "../../runtime/metrics.js";
import type { RuntimeStatus, RuntimeStatusSnapshot } from "../../status.js";
import type {
  MonitorContextTask,
  MonitorContextTaskKind,
  MonitorContextTaskState,
  MonitorDiagnosticEntry,
  MonitorServerEvent,
  MonitorServerMessage,
  MonitorSnapshot,
  MonitorStateFrame,
  MonitorWriterAttempt,
  MonitorWriterAttemptWithText,
  MonitorWriterPromptMessage,
  MonitorWriterPromptSegment,
  MonitorWriterTask,
  MonitorWriterTaskWithText,
} from "../../shared/wire/monitor-message.js";

/** Minimal game surface the hub polls — Game satisfies this structurally. */
export interface MonitorGameView {
  getMonitorState(): GameMonitorState;
}

export interface MonitorHubOptions {
  status: RuntimeStatus;
  metrics: Metrics;
  info: MonitorSnapshot["info"];
  /** Rebase-safe game accessor (restart swaps the game under the same app). */
  game: () => MonitorGameView | null;
  /** Test seams; production uses Date.now and the defaults below. */
  now?: () => number;
  flushIntervalMs?: number;
  pollIntervalMs?: number;
}

const MAX_WRITER_TASKS = 12;
const MAX_WRITER_TEXT_CHARS = 48_000;
const MAX_CONTEXT_TASKS = 24;
const MAX_DIAGNOSTICS = 200;
/** Prompt audit caps: per segment and per attempt (stored + broadcast). */
const MAX_PROMPT_SEGMENT_CHARS = 20_000;
const MAX_PROMPT_ATTEMPT_CHARS = 64_000;
const DEFAULT_FLUSH_INTERVAL_MS = 25;
const DEFAULT_POLL_INTERVAL_MS = 400;

interface WriterAttemptRecord {
  attemptId: string;
  index: number;
  state: MonitorWriterAttempt["state"];
  startedAt: number;
  endedAt: number | null;
  chars: number;
  lines: number;
  groups: number;
  error: string | null;
  segmentEnd: string | null;
  firstTokenMs: number | null;
  usage: WriterAttemptUsage | null;
  repairs: WriterRepair[];
  text: string;
  truncated: boolean;
  /** Request payloads indexed by requestIndex (system message stripped —
   * it is session-invariant and kept once on the hub). */
  promptRequests: MonitorWriterPromptMessage[][];
}

interface WriterTaskRecord {
  taskId: string;
  taskType: string;
  startedAt: number;
  lastActivityAt: number;
  attempts: WriterAttemptRecord[];
}

function serializeAttempt(attempt: WriterAttemptRecord): MonitorWriterAttempt {
  return {
    attemptId: attempt.attemptId,
    index: attempt.index,
    state: attempt.state,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    chars: attempt.chars,
    lines: attempt.lines,
    groups: attempt.groups,
    error: attempt.error,
    segmentEnd: attempt.segmentEnd,
    firstTokenMs: attempt.firstTokenMs,
    usage: attempt.usage,
    repairs: [...attempt.repairs],
  };
}

function serializeTaskWithText(task: WriterTaskRecord): MonitorWriterTaskWithText {
  const attempts: MonitorWriterAttemptWithText[] = task.attempts.map((attempt) => ({
    ...serializeAttempt(attempt),
    text: attempt.text,
    truncated: attempt.truncated,
    ...(attempt.promptRequests.length > 0
      ? { prompt: { requests: clonePromptRequests(attempt.promptRequests) } }
      : {}),
  }));
  return {
    taskId: task.taskId,
    taskType: task.taskType,
    startedAt: task.startedAt,
    lastActivityAt: task.lastActivityAt,
    attempts,
  };
}

// ---------------------------------------------------------------------------
// Prompt audit helpers
// ---------------------------------------------------------------------------

/** Identity of a prompt message (joined segment texts) for change detection. */
function promptMessageKey(message: MonitorWriterPromptMessage): string {
  return message.segments.map((segment) => segment.text).join("");
}

function clonePromptSegment(segment: MonitorWriterPromptSegment): MonitorWriterPromptSegment {
  return {
    source: segment.source,
    label: segment.label,
    text: segment.text,
    ...(segment.truncated === true ? { truncated: true } : {}),
  };
}

function clonePromptMessage(message: MonitorWriterPromptMessage): MonitorWriterPromptMessage {
  return { role: message.role, segments: message.segments.map(clonePromptSegment) };
}

function clonePromptRequests(requests: readonly MonitorWriterPromptMessage[][]): MonitorWriterPromptMessage[][] {
  return requests.map((messages) => messages.map(clonePromptMessage));
}

/** Copy + cap the reported messages (segment 20k / attempt 64k, flag set). */
function normalizePromptMessages(
  messages: readonly WriterPromptMessage[],
): MonitorWriterPromptMessage[] {
  let budget = MAX_PROMPT_ATTEMPT_CHARS;
  return messages.map((message) => ({
    role: message.role,
    segments: message.segments.map((segment) => {
      let text = segment.text;
      let truncated = false;
      if (text.length > MAX_PROMPT_SEGMENT_CHARS) {
        text = text.slice(0, MAX_PROMPT_SEGMENT_CHARS);
        truncated = true;
      }
      if (text.length > budget) {
        text = text.slice(0, Math.max(0, budget));
        truncated = true;
      }
      budget -= text.length;
      return {
        source: segment.source,
        label: segment.label,
        text,
        ...(truncated ? { truncated: true } : {}),
      };
    }),
  }));
}

export class MonitorHub {
  private readonly writerTasks = new Map<string, WriterTaskRecord>();
  private readonly attemptIndex = new Map<string, { task: WriterTaskRecord; attempt: WriterAttemptRecord }>();
  /** Session-invariant writer system prompt (segmented, audit view). */
  private writerSystemPrompt: MonitorWriterPromptMessage | null = null;
  private readonly contextTasks: MonitorContextTask[] = [];
  private contextSeq = 0;
  private readonly diagnostics: MonitorDiagnosticEntry[] = [];
  private readonly listeners = new Set<(message: MonitorServerMessage) => void>();
  private pendingEvents: MonitorServerEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastStateJson: string | null = null;
  private readonly now: () => number;
  private readonly flushIntervalMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: MonitorHubOptions) {
    this.now = options.now ?? Date.now;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  // -------------------------------------------------------------------------
  // Writer LLM observer (injected into StoryGenerator)
  // -------------------------------------------------------------------------

  readonly writerObserver: DslStreamObserver = {
    onAttemptStart: (info: WriterAttemptInfo) => {
      let task = this.writerTasks.get(info.taskId);
      if (task === undefined) {
        task = {
          taskId: info.taskId,
          taskType: info.taskType,
          startedAt: this.now(),
          lastActivityAt: this.now(),
          attempts: [],
        };
        this.writerTasks.set(info.taskId, task);
        // Bound the task ring (insertion-ordered).
        while (this.writerTasks.size > MAX_WRITER_TASKS) {
          const oldestKey = this.writerTasks.keys().next().value;
          if (oldestKey === undefined) break;
          const oldest = this.writerTasks.get(oldestKey);
          if (oldest !== undefined) {
            for (const attempt of oldest.attempts) {
              this.attemptIndex.delete(attempt.attemptId);
              if (attempt.state === "streaming") {
                // Evicted mid-flight: settle the attempt so clients do not
                // show a ghost 生成中 until the task is forgotten.
                attempt.state = "cancelled";
                attempt.endedAt = this.now();
                attempt.error = "ring 已淘汰";
                this.queueEvent({
                  type: "writer.end",
                  taskId: oldest.taskId,
                  attemptId: attempt.attemptId,
                  state: attempt.state,
                  error: attempt.error,
                  segmentEnd: null,
                });
              }
            }
            this.writerTasks.delete(oldestKey);
          }
        }
      }
      const attempt: WriterAttemptRecord = {
        attemptId: info.attemptId,
        index: info.index,
        state: "streaming",
        startedAt: this.now(),
        endedAt: null,
        chars: 0,
        lines: 0,
        groups: 0,
        error: null,
        segmentEnd: null,
        firstTokenMs: null,
        usage: null,
        repairs: [],
        text: "",
        truncated: false,
        promptRequests: [],
      };
      task.attempts.push(attempt);
      task.lastActivityAt = attempt.startedAt;
      this.attemptIndex.set(info.attemptId, { task, attempt });
      this.queueEvent({
        type: "writer.start",
        task: { ...task, attempts: [serializeAttempt(attempt)] },
      });
    },

    onPrompt: (report: WriterPromptReport) => {
      const entry = this.attemptIndex.get(report.attemptId);
      if (entry === undefined) return;
      const messages = normalizePromptMessages(report.messages);
      // The system message is session-invariant: keep one copy on the hub,
      // store only the per-request user/assistant messages on the attempt.
      const system = messages.find((message) => message.role === "system");
      if (system !== undefined) {
        if (
          this.writerSystemPrompt === null ||
          promptMessageKey(this.writerSystemPrompt) !== promptMessageKey(system)
        ) {
          this.writerSystemPrompt = clonePromptMessage(system);
        }
      }
      const rest = messages.filter((message) => message.role !== "system");
      const { attempt } = entry;
      while (attempt.promptRequests.length <= report.requestIndex) {
        attempt.promptRequests.push([]);
      }
      attempt.promptRequests[report.requestIndex] = rest;
      entry.task.lastActivityAt = this.now();
      this.queueEvent({
        type: "writer.prompt",
        attemptId: report.attemptId,
        requestIndex: report.requestIndex,
        messages,
      });
    },

    onDelta: (attemptId: string, text: string) => {
      const entry = this.attemptIndex.get(attemptId);
      if (entry === undefined) return;
      const { task, attempt } = entry;
      if (attempt.firstTokenMs === null && text.length > 0) {
        attempt.firstTokenMs = Math.max(0, this.now() - attempt.startedAt);
      }
      if (!attempt.truncated) {
        const room = MAX_WRITER_TEXT_CHARS - attempt.text.length;
        if (room <= 0) {
          attempt.truncated = true;
        } else if (text.length <= room) {
          attempt.text += text;
        } else {
          attempt.text += text.slice(0, room);
          attempt.truncated = true;
        }
      }
      attempt.chars += text.length;
      task.lastActivityAt = this.now();
      this.queueEvent({ type: "writer.delta", attemptId, text, firstTokenMs: attempt.firstTokenMs });
    },

    onLine: (attemptId: string, lineIndex: number, parse: WriterLineParse) => {
      const entry = this.attemptIndex.get(attemptId);
      if (entry === undefined) return;
      entry.attempt.lines += 1;
      entry.task.lastActivityAt = this.now();
      this.queueEvent({
        type: "writer.line",
        attemptId,
        lineIndex,
        kind: parse.kind,
        error: parse.error ?? null,
      });
    },

    onGroup: (attemptId: string, groupIndex: number, kind: string, summary: string) => {
      const entry = this.attemptIndex.get(attemptId);
      if (entry === undefined) return;
      entry.attempt.groups += 1;
      entry.task.lastActivityAt = this.now();
      this.queueEvent({ type: "writer.group", attemptId, groupIndex, kind, summary });
    },

    onRepair: (attemptId: string, repair: WriterRepair) => {
      const entry = this.attemptIndex.get(attemptId);
      if (entry === undefined) return;
      entry.attempt.repairs.push({ ...repair });
      entry.task.lastActivityAt = this.now();
      this.queueEvent({ type: "writer.repair", attemptId, repair: { ...repair } });
    },

    onUsage: (attemptId: string, usage: WriterAttemptUsage) => {
      const entry = this.attemptIndex.get(attemptId);
      if (entry === undefined) return;
      entry.attempt.usage = { ...usage };
      entry.task.lastActivityAt = this.now();
      this.queueEvent({ type: "writer.usage", attemptId, usage: { ...usage } });
    },

    onAttemptEnd: (attemptId: string, outcome: WriterAttemptEnd) => {
      const entry = this.attemptIndex.get(attemptId);
      if (entry === undefined) return;
      const { attempt } = entry;
      attempt.state = outcome.state;
      attempt.endedAt = this.now();
      attempt.error = outcome.error ?? null;
      attempt.segmentEnd = outcome.segmentEnd ?? null;
      entry.task.lastActivityAt = attempt.endedAt;
      this.queueEvent({
        type: "writer.end",
        taskId: entry.task.taskId,
        attemptId,
        state: attempt.state,
        error: attempt.error,
        segmentEnd: attempt.segmentEnd,
      });
    },
  };

  // -------------------------------------------------------------------------
  // Background context LLM tasks (recap / consolidation / plot planner)
  // -------------------------------------------------------------------------

  contextStart(kind: MonitorContextTaskKind, detail: string): string {
    this.contextSeq += 1;
    const id = `${kind}-${this.contextSeq}`;
    const task: MonitorContextTask = {
      id,
      kind,
      state: "running",
      startedAt: this.now(),
      endedAt: null,
      detail,
      output: null,
      error: null,
    };
    this.contextTasks.push(task);
    while (this.contextTasks.length > MAX_CONTEXT_TASKS) this.contextTasks.shift();
    this.queueEvent({ type: "context.start", task: { ...task } });
    return id;
  }

  contextEnd(
    id: string,
    patch: { state: MonitorContextTaskState; output?: string; error?: string },
  ): void {
    // Search from the end: ids are unique and completions arrive in order.
    for (let i = this.contextTasks.length - 1; i >= 0; i -= 1) {
      const task = this.contextTasks[i]!;
      if (task.id !== id) continue;
      task.state = patch.state;
      task.endedAt = this.now();
      if (patch.output !== undefined) task.output = patch.output;
      if (patch.error !== undefined) task.error = patch.error;
      this.queueEvent({ type: "context.end", task: { ...task } });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics fan-out (BroadcastDiagnosticSink calls this)
  // -------------------------------------------------------------------------

  pushDiagnostic(level: "info" | "warn", scope: string, message: string): void {
    const entry: MonitorDiagnosticEntry = { at: this.now(), level, scope, message };
    this.diagnostics.push(entry);
    while (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.shift();
    this.queueEvent({ type: "diagnostics", entry });
  }

  // -------------------------------------------------------------------------
  // Subscription + broadcast
  // -------------------------------------------------------------------------

  /**
   * Drop all session-scoped history (writer tasks, context tasks). Called
   * on session restart so the new session does not inherit the previous
   * one's request document — with in-flight attempts settled as cancelled
   * rather than left "streaming" forever.
   */
  clearWriterHistory(): void {
    for (const task of this.writerTasks.values()) {
      for (const attempt of task.attempts) {
        if (attempt.state !== "streaming") continue;
        attempt.state = "cancelled";
        attempt.endedAt = this.now();
        attempt.error = "会话已重启";
      }
    }
    this.writerTasks.clear();
    this.attemptIndex.clear();
    this.contextTasks.length = 0;
    this.lastStateJson = null;
  }

  subscribe(listener: (message: MonitorServerMessage) => void): () => void {
    this.listeners.add(listener);
    this.ensurePolling();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }

  private broadcast(message: MonitorServerMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // A broken listener must never take the runtime down.
      }
    }
  }

  private queueEvent(event: MonitorServerEvent): void {
    this.pendingEvents.push(event);
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const events = this.pendingEvents;
      this.pendingEvents = [];
      if (events.length === 0 || this.listeners.size === 0) return;
      this.broadcast({ type: "monitor.event", events });
    }, this.flushIntervalMs);
    if (typeof this.flushTimer === "object" && this.flushTimer !== null && "unref" in this.flushTimer) {
      (this.flushTimer as { unref(): void }).unref();
    }
  }

  // -------------------------------------------------------------------------
  // State polling
  // -------------------------------------------------------------------------

  private ensurePolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
    if (typeof this.pollTimer === "object" && this.pollTimer !== null && "unref" in this.pollTimer) {
      (this.pollTimer as { unref(): void }).unref();
    }
  }

  private stopPolling(): void {
    if (this.pollTimer === null) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private buildStateFrame(): MonitorStateFrame {
    const game = this.options.game();
    let session: GameMonitorState = {
      sessionId: "",
      currentDsl: null,
      buffer: { pending: 0, total: 0, textLinesAhead: 0 },
      scheduler: { active: false, status: "idle", owner: "" },
      endingPressure: {
        interactionCount: 0,
        level: 0,
        forceEnding: false,
        textEventsSinceInteraction: 0,
        wrapupAt: 0,
        closingPushAt: 0,
        maxAt: 0,
      },
      storyState: {
        scene: { id: "", location: "", purpose: "" },
        canon: {},
        characters: {},
        open_threads: [],
        recent_summary: "",
        player_profile: { recent_tendencies: [] },
      },
      eventCount: 0,
      lastSeq: 0,
      timeline: [],
    };
    if (game !== null) {
      try {
        session = game.getMonitorState();
      } catch {
        // A broken projection must never kill the poller / the runtime
        // (monitor observation is strictly read-only sideband).
      }
    }
    return {
      at: this.now(),
      session,
      status: this.options.status.snapshot(),
      metrics: this.options.metrics.snapshot(),
    };
  }

  private pollOnce(): void {
    if (this.listeners.size === 0) return;
    const frame = this.buildStateFrame();
    const json = JSON.stringify(frame);
    if (json === this.lastStateJson) return;
    this.lastStateJson = json;
    this.broadcast({ type: "monitor.state", state: frame });
  }

  // -------------------------------------------------------------------------
  // Snapshot (sent on every /ws/monitor connect)
  // -------------------------------------------------------------------------

  snapshot(): MonitorSnapshot {
    const writerTasks = [...this.writerTasks.values()]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map(serializeTaskWithText);
    const state = this.buildStateFrame();
    this.lastStateJson = JSON.stringify(state);
    return {
      at: this.now(),
      info: this.options.info,
      writer: {
        tasks: writerTasks,
        ...(this.writerSystemPrompt !== null
          ? { systemPrompt: clonePromptMessage(this.writerSystemPrompt) }
          : {}),
      },
      context: { tasks: [...this.contextTasks].reverse() },
      diagnostics: [...this.diagnostics],
      state,
    };
  }
}
