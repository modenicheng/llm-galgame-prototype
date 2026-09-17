/**
 * MonitorModel — the dashboard's client-side store.
 *
 * Folds the monitor wire messages into renderable state: writer tasks (with
 * full DSL text per attempt), context-LLM tasks, the diagnostics ring, and
 * the latest game-state frame. Two notification paths:
 * - `subscribe` for coarse structure changes (a panel re-renders);
 - `onEvent` for raw live events (the writer stream view appends deltas
 *   directly, without a structural re-render).
 */
import type {
  MonitorContextTask,
  MonitorDiagnosticEntry,
  MonitorInfo,
  MonitorServerEvent,
  MonitorServerMessage,
  MonitorStateFrame,
  MonitorWriterPromptMessage,
  MonitorWriterRepair,
  MonitorWriterUsage,
} from "@shared/wire/monitor-message.js";
import type { MonitorConnectionState } from "./monitor-client.js";

export interface WriterAttemptModel {
  attemptId: string;
  index: number;
  state: "streaming" | "done" | "failed" | "retried" | "cancelled";
  startedAt: number;
  endedAt: number | null;
  chars: number;
  lines: number;
  groups: number;
  error: string | null;
  segmentEnd: string | null;
  firstTokenMs: number | null;
  usage: MonitorWriterUsage | null;
  repairs: MonitorWriterRepair[];
  text: string;
  truncated: boolean;
  /** Request payloads indexed by requestIndex (system message stripped —
   * it lives once on the model as writerSystemPrompt). */
  promptRequests: MonitorWriterPromptMessage[][];
}

export interface WriterTaskModel {
  taskId: string;
  taskType: string;
  /** 生成片 id：Game 级修复续写与原段共享同片；null = 独立片。 */
  sliceId: string | null;
  startedAt: number;
  lastActivityAt: number;
  /** Model-local arrival sequence: stable oldest→newest tiebreak. */
  firstSeen: number;
  attempts: WriterAttemptModel[];
}

export type MonitorTopic =
  | "connection"
  | "writer"
  | "writerPrompt"
  | "context"
  | "diagnostics"
  | "state";

/** Client-side text cap per attempt (mirrors the server's 48k cap so the
 * incremental path and the snapshot produce the same document). */
const MAX_ATTEMPT_TEXT_CHARS = 48_000;
/** Mirrors MonitorHub.MAX_WRITER_TASKS. */
const MAX_WRITER_TASKS = 12;
const MAX_DIAGNOSTICS = 200;

export class MonitorModel {
  connection: MonitorConnectionState = "connecting";
  /** Newest first. */
  writerTasks: WriterTaskModel[] = [];
  /** Session-invariant writer system prompt (segmented, audit view). */
  writerSystemPrompt: MonitorWriterPromptMessage | null = null;
  /** Newest first. */
  contextTasks: MonitorContextTask[] = [];
  diagnostics: MonitorDiagnosticEntry[] = [];
  state: MonitorStateFrame | null = null;
  info: MonitorInfo | null = null;

  private readonly attemptIndex = new Map<string, { task: WriterTaskModel; attempt: WriterAttemptModel }>();
  private taskSeq = 0;
  private readonly topicListeners = new Set<(topic: MonitorTopic) => void>();
  private readonly eventListeners = new Set<(event: MonitorServerEvent) => void>();

  subscribe(listener: (topic: MonitorTopic) => void): () => void {
    this.topicListeners.add(listener);
    return () => this.topicListeners.delete(listener);
  }

  onEvent(listener: (event: MonitorServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  setConnection(state: MonitorConnectionState): void {
    this.connection = state;
    this.notify("connection");
  }

  applyServerMessage(message: MonitorServerMessage): void {
    switch (message.type) {
      case "monitor.snapshot": {
        const snap = message.snapshot;
        this.info = snap.info;
        this.writerSystemPrompt = snap.writer.systemPrompt ?? null;
        this.writerTasks = snap.writer.tasks.map((task) => ({
          ...task,
          sliceId: task.sliceId ?? null,
          firstSeen: this.taskSeq++,
          attempts: task.attempts.map((attempt) => ({
            ...attempt,
            firstTokenMs: attempt.firstTokenMs ?? null,
            usage: attempt.usage ?? null,
            repairs: [...(attempt.repairs ?? [])],
            promptRequests: (attempt.prompt?.requests ?? []).map((messages) =>
              messages.map((message) => ({
                role: message.role,
                segments: message.segments.map((segment) => ({ ...segment })),
              })),
            ),
          })),
        }));
        this.reindexAttempts();
        this.contextTasks = [...snap.context.tasks];
        this.diagnostics = [...snap.diagnostics];
        this.state = snap.state;
        this.notify("writer");
        this.notify("writerPrompt");
        this.notify("context");
        this.notify("diagnostics");
        this.notify("state");
        break;
      }
      case "monitor.event": {
        const topics = new Set<MonitorTopic>();
        for (const event of message.events) {
          this.applyEvent(event);
          switch (event.type) {
            case "writer.start":
            case "writer.end":
              topics.add("writer");
              break;
            case "writer.prompt":
              topics.add("writerPrompt");
              break;
            case "context.start":
            case "context.end":
              topics.add("context");
              break;
            case "diagnostics":
              topics.add("diagnostics");
              break;
            default:
              break;
          }
          for (const listener of this.eventListeners) {
            try {
              listener(event);
            } catch (error) {
              console.error("monitor event listener failed", error);
            }
          }
        }
        for (const topic of topics) this.notify(topic);
        break;
      }
      case "monitor.state": {
        this.state = message.state;
        this.notify("state");
        break;
      }
    }
  }

  knownSpeakers(): ReadonlySet<string> | undefined {
    return this.info !== null && this.info.knownSpeakers.length > 0
      ? new Set(this.info.knownSpeakers)
      : undefined;
  }

  private applyEvent(event: MonitorServerEvent): void {
    switch (event.type) {
      case "writer.start": {
        const existing = this.writerTasks.find((task) => task.taskId === event.task.taskId);
        if (existing === undefined) {
          const task: WriterTaskModel = {
            taskId: event.task.taskId,
            taskType: event.task.taskType,
            sliceId: event.task.sliceId ?? null,
            startedAt: event.task.startedAt,
            lastActivityAt: event.task.lastActivityAt,
            firstSeen: this.taskSeq++,
            attempts: event.task.attempts.map((attempt) => ({
              ...attempt,
              firstTokenMs: attempt.firstTokenMs ?? null,
              usage: attempt.usage ?? null,
              repairs: [...(attempt.repairs ?? [])],
              text: "",
              truncated: false,
              promptRequests: [],
            })),
          };
          this.writerTasks.unshift(task);
          // Mirror the server ring: drop the oldest task so the incremental
          // path and a fresh snapshot converge on the same 12 tasks.
          while (this.writerTasks.length > MAX_WRITER_TASKS) {
            const dropped = this.writerTasks.pop();
            if (dropped !== undefined) {
              for (const attempt of dropped.attempts) this.attemptIndex.delete(attempt.attemptId);
            }
          }
          this.indexTask(task);
        } else {
          for (const attempt of event.task.attempts) {
            if (!existing.attempts.some((a) => a.attemptId === attempt.attemptId)) {
              existing.attempts.push({
                ...attempt,
                firstTokenMs: attempt.firstTokenMs ?? null,
                usage: attempt.usage ?? null,
                repairs: [...(attempt.repairs ?? [])],
                text: "",
                truncated: false,
                promptRequests: [],
              });
            }
          }
          existing.lastActivityAt = event.task.lastActivityAt;
          if (existing.sliceId === null && event.task.sliceId != null) {
            existing.sliceId = event.task.sliceId;
          }
          this.indexTask(existing);
        }
        break;
      }
      case "writer.prompt": {
        const entry = this.attemptIndex.get(event.attemptId);
        if (entry === undefined) break;
        // Idempotent system fold: the message rides every writer.prompt event,
        // but it only changes when the generator is rebuilt.
        const system = event.messages.find((message) => message.role === "system");
        if (system !== undefined) {
          const key = system.segments.map((segment) => segment.text).join("");
          const current = this.writerSystemPrompt;
          const currentKey =
            current !== null ? current.segments.map((segment) => segment.text).join("") : null;
          if (currentKey !== key) {
            this.writerSystemPrompt = {
              role: "system",
              segments: system.segments.map((segment) => ({ ...segment })),
            };
          }
        }
        const attempt = entry.attempt;
        while (attempt.promptRequests.length <= event.requestIndex) {
          attempt.promptRequests.push([]);
        }
        attempt.promptRequests[event.requestIndex] = event.messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role,
            segments: message.segments.map((segment) => ({ ...segment })),
          }));
        break;
      }
      case "writer.delta": {
        const entry = this.attemptIndex.get(event.attemptId);
        if (entry === undefined) return;
        if (entry.attempt.firstTokenMs === null && event.text.length > 0) {
          entry.attempt.firstTokenMs =
            event.firstTokenMs ?? Math.max(0, Date.now() - entry.attempt.startedAt);
        }
        if (!entry.attempt.truncated) {
          const room = MAX_ATTEMPT_TEXT_CHARS - entry.attempt.text.length;
          if (room <= 0) entry.attempt.truncated = true;
          else if (event.text.length <= room) entry.attempt.text += event.text;
          else {
            entry.attempt.text += event.text.slice(0, room);
            entry.attempt.truncated = true;
          }
        }
        entry.attempt.chars += event.text.length;
        break;
      }
      case "writer.line": {
        const entry = this.attemptIndex.get(event.attemptId);
        if (entry !== undefined) entry.attempt.lines += 1;
        break;
      }
      case "writer.group": {
        const entry = this.attemptIndex.get(event.attemptId);
        if (entry !== undefined) entry.attempt.groups += 1;
        break;
      }
      case "writer.repair": {
        const entry = this.attemptIndex.get(event.attemptId);
        if (entry !== undefined) entry.attempt.repairs.push({ ...event.repair });
        break;
      }
      case "writer.usage": {
        const entry = this.attemptIndex.get(event.attemptId);
        if (entry !== undefined) entry.attempt.usage = { ...event.usage };
        break;
      }
      case "writer.end": {
        const entry = this.attemptIndex.get(event.attemptId);
        if (entry === undefined) return;
        entry.attempt.state = event.state;
        entry.attempt.endedAt = Date.now();
        entry.attempt.error = event.error;
        entry.attempt.segmentEnd = event.segmentEnd;
        break;
      }
      case "context.start": {
        this.contextTasks.unshift({ ...event.task });
        break;
      }
      case "context.end": {
        const task = this.contextTasks.find((t) => t.id === event.task.id);
        if (task !== undefined) {
          task.state = event.task.state;
          task.endedAt = event.task.endedAt;
          task.output = event.task.output;
          task.error = event.task.error;
        } else {
          this.contextTasks.unshift({ ...event.task });
        }
        break;
      }
      case "diagnostics": {
        this.diagnostics.push(event.entry);
        while (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.shift();
        break;
      }
    }
  }

  private indexTask(task: WriterTaskModel): void {
    for (const attempt of task.attempts) {
      this.attemptIndex.set(attempt.attemptId, { task, attempt });
    }
  }

  private reindexAttempts(): void {
    this.attemptIndex.clear();
    for (const task of this.writerTasks) this.indexTask(task);
  }

  private notify(topic: MonitorTopic): void {
    for (const listener of this.topicListeners) {
      try {
        listener(topic);
      } catch (error) {
        // One broken panel must not kill message processing (a throw here
        // used to bubble out of applyServerMessage and freeze the stream).
        console.error("monitor listener failed", error);
      }
    }
  }
}
