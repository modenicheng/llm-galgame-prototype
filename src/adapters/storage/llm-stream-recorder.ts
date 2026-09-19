/**
 * LlmStreamRecorder — full-fidelity on-disk record of every LLM request:
 * the writer LLM's DSL streams (2026-09-17 observability) plus the four
 * background agents' non-streaming requests (2026-09-19, via the
 * ContextLlmRecorder port).
 *
 * The /monitor dashboard keeps a bounded in-memory view (ring buffer +
 * prompt truncation, docs/monitor-dashboard.md); this recorder is the
 * durable counterpart: every observer event is appended verbatim under
 * `<sessions_dir>/<sessionId>/llm/`, so any attempt — including one that
 * died mid-stream — can be reconstructed afterwards:
 *
 *   llm/index.jsonl                       one summary row per settled attempt
 *   llm/<seq>-<attemptId>/prompts.jsonl   one WriterPromptReport per line —
 *                                         segments are verbatim, joining a
 *                                         message's segments reproduces the
 *                                         exact bytes sent to the provider
 *   llm/<seq>-<attemptId>/output.raw.txt  the raw content stream, appended
 *                                         in arrival order (no truncation)
 *   llm/<seq>-<attemptId>/events.jsonl    start/line/group/repair/usage/end
 *                                         events with event-time timestamps
 *
 * Background agent requests (memory_agent / recap_summarization /
 * narrative_consolidation / plot_plan) share the same directory layout,
 * the seq counter and index.jsonl, so one index is the complete ledger of
 * every LLM request in a session. Their `prompts.jsonl` line is the exact
 * provider request body instead of a WriterPromptReport.
 *
 * Implements the core `DslStreamObserver` and `ContextLlmRecorder` ports;
 * the composition root fans generation out to the monitor hub and this
 * recorder, wrapped in the same safety guarantee (观察者异常不得影响生成
 * 主路径). Write failures are contained here and reported as throttled
 * console warnings — the sync safe-wrapper in the composition root cannot
 * catch async rejections.
 */
import { appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  DslStreamObserver,
  WriterAttemptEnd,
  WriterAttemptInfo,
  WriterAttemptUsage,
  WriterLineParse,
  WriterPromptReport,
  WriterRepair,
} from "../../core/ports/dsl-stream-observer.js";
import type {
  ContextLlmRecorder,
  ContextLlmRecorderRequest,
  ContextLlmResult,
} from "../../core/ports/context-llm-recorder-port.js";

export interface LlmStreamRecorderOptions {
  /** Test seam; production uses Date.now. */
  now?: () => number;
}

/** At most one console warning per interval; further failures only count. */
const WRITE_WARN_INTERVAL_MS = 30_000;

interface AttemptRecord {
  info: WriterAttemptInfo;
  /** Absolute path of the per-attempt directory. */
  dir: string;
  /** Directory name inside `llm/` (index.jsonl references it). */
  dirName: string;
  seq: number;
  startedAt: number;
}

function sanitizeAttemptId(attemptId: string): string {
  return attemptId.replace(/[^A-Za-z0-9._-]/g, "-");
}

export class LlmStreamRecorder implements DslStreamObserver, ContextLlmRecorder {
  private readonly now: () => number;
  /** Base `llm/` directory of the current session; null until beginSession. */
  private llmDir: string | null = null;
  private nextSeq = 1;
  /**
   * Records live for the whole session (one tiny entry per attempt) so a
   * late event still lands and `flush()` can await already-settled attempts.
   */
  private readonly attempts = new Map<string, AttemptRecord>();
  /**
   * Global serialized write queue. Hooks fire synchronously in generator
   * order, so queueing in hook order reproduces the exact event sequence —
   * including across attempts (index.jsonl is a shared file, per-attempt
   * chains would race on it).
   */
  private queue: Promise<void> = Promise.resolve();
  private lastWriteWarnAt = -Infinity;
  private droppedRecords = 0;

  constructor(options: LlmStreamRecorderOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Switch to a session's `llm/` directory — the composition root calls
   * this once per session (restart creates a new session id). Numbering
   * continues after existing records so resuming a session never collides.
   */
  async beginSession(sessionsDir: string, sessionId: string): Promise<void> {
    const llmDir = path.resolve(sessionsDir, sessionId, "llm");
    await mkdir(llmDir, { recursive: true });
    let maxSeq = 0;
    try {
      for (const entry of await readdir(llmDir)) {
        const match = /^(\d{4})-/.exec(entry);
        if (match !== null) maxSeq = Math.max(maxSeq, Number.parseInt(match[1]!, 10));
      }
    } catch {
      // Unreadable base dir: start numbering from scratch (mkdir succeeded).
    }
    this.llmDir = llmDir;
    this.nextSeq = maxSeq + 1;
  }

  /** Absolute path of the current session's `llm/` dir; null before beginSession. */
  get location(): string | null {
    return this.llmDir;
  }

  /** Resolves once every queued write has settled (tests / shutdown). */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * Record one background agent's non-streaming request around its
   * provider call: allocate the attempt dir synchronously (start-ordered
   * seq even when several agents run concurrently), run `call()`, then
   * enqueue the response / failure records onto the shared queue. The
   * call's result and errors pass through untouched — recording is
   * best-effort and must not alter the agent's own error handling.
   */
  async recordContextRequest(
    request: ContextLlmRecorderRequest,
    call: () => Promise<ContextLlmResult>,
  ): Promise<ContextLlmResult> {
    if (this.llmDir === null) {
      this.noteFailure(`${request.taskType} request before beginSession — record dropped`);
      return await call();
    }
    const startedAt = this.now();
    const seq = this.nextSeq++;
    const attemptId = `${request.taskType}#${seq}`;
    const dirName = `${String(seq).padStart(4, "0")}-${sanitizeAttemptId(attemptId)}`;
    const record: AttemptRecord = {
      info: { attemptId, taskId: attemptId, taskType: request.taskType, index: 0 },
      dir: path.join(this.llmDir, dirName),
      dirName,
      seq,
      startedAt,
    };
    const startTs = this.timestamp();
    this.enqueue("context start", async () => {
      await mkdir(record.dir, { recursive: true });
      await this.appendEvent(record, {
        t: "start",
        ts: startTs,
        task_id: attemptId,
        task_type: request.taskType,
        task_index: 0,
      });
      // Verbatim request body — this line is exactly what went to the
      // provider (no WriterPromptReport segmentation on this path).
      await appendFile(
        path.join(record.dir, "prompts.jsonl"),
        `${JSON.stringify({ ts: startTs, body: request.body })}\n`,
        "utf8",
      );
    });

    try {
      const result = await call();
      const endedAt = this.now();
      const endTs = new Date(endedAt).toISOString();
      this.enqueue("context end", async () => {
        await appendFile(path.join(record.dir, "output.raw.txt"), result.raw, "utf8");
        const { usage } = result;
        if (usage !== null) {
          await this.appendEvent(record, {
            t: "usage",
            ts: endTs,
            input: usage.input,
            output: usage.output,
            cached_input: usage.cachedInput,
            source: "api",
            latency_ms: Math.max(0, endedAt - startedAt),
            ...(usage.reasoningTokens !== undefined
              ? { reasoning_tokens: usage.reasoningTokens }
              : {}),
          });
        }
        await this.appendEvent(record, { t: "end", ts: endTs, state: "done" });
        await this.appendContextIndexRow(record, endedAt, endTs, "done", request.meta);
      });
      return result;
    } catch (error) {
      const endedAt = this.now();
      const endTs = new Date(endedAt).toISOString();
      const message = error instanceof Error ? error.message : String(error);
      this.enqueue("context failure", async () => {
        await this.appendEvent(record, { t: "end", ts: endTs, state: "failed", error: message });
        await this.appendContextIndexRow(record, endedAt, endTs, "failed", request.meta, message);
      });
      throw error;
    }
  }

  /** Session index row for a settled background request (shared ledger). */
  private appendContextIndexRow(
    record: AttemptRecord,
    endedAt: number,
    endTs: string,
    outcome: "done" | "failed",
    meta: Record<string, unknown> | undefined,
    error?: string,
  ): Promise<void> {
    const summary = {
      seq: record.seq,
      dir: record.dirName,
      attempt_id: record.info.attemptId,
      task_id: record.info.taskId,
      task_type: record.info.taskType,
      task_index: 0,
      started_at: new Date(record.startedAt).toISOString(),
      ended_at: endTs,
      duration_ms: Math.max(0, endedAt - record.startedAt),
      outcome,
      ...(error !== undefined ? { error } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
    return appendFile(
      path.join(path.dirname(record.dir), "index.jsonl"),
      `${JSON.stringify(summary)}\n`,
      "utf8",
    );
  }

  onAttemptStart(info: WriterAttemptInfo): void {
    if (this.llmDir === null) {
      this.noteFailure("onAttemptStart before beginSession — record dropped");
      return;
    }
    const seq = this.nextSeq++;
    const dirName = `${String(seq).padStart(4, "0")}-${sanitizeAttemptId(info.attemptId)}`;
    const record: AttemptRecord = {
      info,
      dir: path.join(this.llmDir, dirName),
      dirName,
      seq,
      startedAt: this.now(),
    };
    this.attempts.set(info.attemptId, record);
    const ts = this.timestamp();
    this.enqueue("attempt dir", async () => {
      await mkdir(record.dir, { recursive: true });
      await this.appendEvent(record, {
        t: "start",
        ts,
        task_id: info.taskId,
        task_type: info.taskType,
        task_index: info.index,
        ...(info.sliceId !== undefined ? { slice_id: info.sliceId } : {}),
      });
    });
  }

  onPrompt(report: WriterPromptReport): void {
    const record = this.attempts.get(report.attemptId);
    if (record === undefined) {
      this.noteUnknownAttempt("onPrompt", report.attemptId);
      return;
    }
    this.enqueue("prompt", () =>
      appendFile(path.join(record.dir, "prompts.jsonl"), `${JSON.stringify(report)}\n`, "utf8"),
    );
  }

  onDelta(attemptId: string, text: string): void {
    const record = this.attempts.get(attemptId);
    if (record === undefined) {
      this.noteUnknownAttempt("onDelta", attemptId);
      return;
    }
    this.enqueue("delta", () =>
      appendFile(path.join(record.dir, "output.raw.txt"), text, "utf8"),
    );
  }

  onLine(attemptId: string, lineIndex: number, parse: WriterLineParse): void {
    const record = this.attempts.get(attemptId);
    if (record === undefined) {
      this.noteUnknownAttempt("onLine", attemptId);
      return;
    }
    const ts = this.timestamp();
    this.enqueue("line", () =>
      this.appendEvent(record, {
        t: "line",
        ts,
        line_index: lineIndex,
        kind: parse.kind,
        ...(parse.error !== undefined ? { error: parse.error } : {}),
      }),
    );
  }

  onGroup(attemptId: string, groupIndex: number, kind: string, summary: string): void {
    const record = this.attempts.get(attemptId);
    if (record === undefined) {
      this.noteUnknownAttempt("onGroup", attemptId);
      return;
    }
    const ts = this.timestamp();
    this.enqueue("group", () =>
      this.appendEvent(record, { t: "group", ts, group_index: groupIndex, kind, summary }),
    );
  }

  onRepair(attemptId: string, repair: WriterRepair): void {
    const record = this.attempts.get(attemptId);
    if (record === undefined) {
      this.noteUnknownAttempt("onRepair", attemptId);
      return;
    }
    const ts = this.timestamp();
    this.enqueue("repair", () =>
      this.appendEvent(record, {
        t: "repair",
        ts,
        kind: repair.kind,
        line_index: repair.lineIndex,
        message: repair.message,
      }),
    );
  }

  onUsage(attemptId: string, usage: WriterAttemptUsage): void {
    const record = this.attempts.get(attemptId);
    if (record === undefined) {
      this.noteUnknownAttempt("onUsage", attemptId);
      return;
    }
    const ts = this.timestamp();
    this.enqueue("usage", () =>
      this.appendEvent(record, {
        t: "usage",
        ts,
        input: usage.input,
        output: usage.output,
        cached_input: usage.cachedInput,
        source: usage.source,
        latency_ms: usage.latencyMs,
        ...(usage.reasoningTokens !== undefined ? { reasoning_tokens: usage.reasoningTokens } : {}),
        ...(usage.thinkingMs !== undefined ? { thinking_ms: usage.thinkingMs } : {}),
        ...(usage.reasoningChars !== undefined ? { reasoning_chars: usage.reasoningChars } : {}),
      }),
    );
  }

  onAttemptEnd(attemptId: string, outcome: WriterAttemptEnd): void {
    const record = this.attempts.get(attemptId);
    if (record === undefined) {
      this.noteUnknownAttempt("onAttemptEnd", attemptId);
      return;
    }
    const endedAt = this.now();
    const ts = new Date(endedAt).toISOString();
    this.enqueue("attempt end", async () => {
      await this.appendEvent(record, {
        t: "end",
        ts,
        state: outcome.state,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.segmentEnd !== undefined ? { segment_end: outcome.segmentEnd } : {}),
      });
      // index.jsonl lives in the session `llm/` dir the attempt started in —
      // dirname (not this.llmDir) keeps it correct across beginSession swaps.
      const summary = {
        seq: record.seq,
        dir: record.dirName,
        attempt_id: record.info.attemptId,
        task_id: record.info.taskId,
        task_type: record.info.taskType,
        task_index: record.info.index,
        ...(record.info.sliceId !== undefined ? { slice_id: record.info.sliceId } : {}),
        started_at: new Date(record.startedAt).toISOString(),
        ended_at: ts,
        duration_ms: Math.max(0, endedAt - record.startedAt),
        outcome: outcome.state,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.segmentEnd !== undefined ? { segment_end: outcome.segmentEnd } : {}),
      };
      await appendFile(
        path.join(path.dirname(record.dir), "index.jsonl"),
        `${JSON.stringify(summary)}\n`,
        "utf8",
      );
    });
  }

  /**
   * Queue one write onto the serialized queue. Failures are contained (the
   * queue stays alive for later writes) and reported throttled — never
   * propagated, so no unhandled rejection can escape.
   */
  private enqueue(what: string, op: () => Promise<void>): void {
    this.queue = this.queue
      .then(op)
      .catch((error: unknown) => this.noteFailure(`${what} write failed`, error));
  }

  private appendEvent(record: AttemptRecord, event: Record<string, unknown>): Promise<void> {
    return appendFile(path.join(record.dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  /** Throttled failure report — one console warning per interval. */
  private noteFailure(what: string, error?: unknown): void {
    this.droppedRecords += 1;
    const at = this.now();
    if (at - this.lastWriteWarnAt < WRITE_WARN_INTERVAL_MS) return;
    const suppressed = this.droppedRecords - 1;
    this.droppedRecords = 0;
    this.lastWriteWarnAt = at;
    console.warn(
      `[llm-recorder] ${what}${suppressed > 0 ? ` (+${suppressed} suppressed since last warning)` : ""}`,
      ...(error !== undefined ? [error] : []),
    );
  }

  private noteUnknownAttempt(hook: string, attemptId: string): void {
    this.noteFailure(`${hook} for unknown attempt "${attemptId}" — record dropped`);
  }
}
