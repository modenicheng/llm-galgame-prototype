/**
 * TtsTaskService — Node-side synthesis task orchestration (§7.5).
 *
 * Validates `lineId + cacheKey`, enforces concurrency and priority
 * limits, delegates to the TtsProviderPort, exposes PCM chunks as an
 * AsyncIterable, records per-task metrics, and cancels the upstream task
 * when the browser aborts the HTTP request.
 */
import type { AudioFetchRequest } from "../../shared/wire/client-message.js";
import type { AudioFormatDescriptor, AudioPriority } from "../../shared/wire/audio-descriptor.js";
import type {
  TtsProviderPort,
  TtsStreamSession,
  TtsSynthesisRequest,
} from "../../core/ports/tts-provider-port.js";
import type { AudioCatalogService } from "./audio-catalog-service.js";
import type { InternalAudioRecipe } from "./internal-audio-recipe.js";
import { ttsLog } from "./tts-log.js";

/** Short stable id for log context (task ids are UUIDs). */
function shortId(id: string): string {
  return id.slice(0, 8);
}

const DEFAULT_MIN_PROVIDER_START_INTERVAL_MS = 350;
const RATE_LIMIT_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
const PRIORITY_RANK: Record<AudioPriority, number> = {
  current: 0,
  next: 1,
  active_future: 2,
  candidate_first_line: 3,
  background: 4,
};

function isRateLimitError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "http_429"
  );
}


export interface TtsTaskService {
  /**
   * Start (or join) a synthesis task for a validated fetch request.
   * Rejects with a typed error when the line/cacheKey is invalid or
   * concurrency limits are exceeded.
   */
  synthesize(
    request: AudioFetchRequest,
    signal: AbortSignal,
  ): Promise<TtsStreamSession>;
}

export type TtsTaskErrorCode = "invalid_line" | "audio_disabled" | "canceled";

/** Typed task error; the HTTP route maps `code` to a status response. */
export class TtsTaskError extends Error {
  constructor(
    readonly code: TtsTaskErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TtsTaskError";
  }
}

export interface TaskStatusEvent {
  taskId: string;
  lineId: string;
  status: "started" | "finished" | "failed" | "canceled";
  error?: string;
  totalBytes?: number;
}

export interface TtsTaskServiceImplOptions {
  catalog: AudioCatalogService;
  /** null → every request rejects with "audio_disabled". */
  provider: TtsProviderPort | null;
  maxConcurrency: number;
  onStatus: (event: TaskStatusEvent) => void;
  /** Minimum spacing between provider starts. Default 350ms (below 3 RPS). */
  minProviderStartIntervalMs?: number;
}

type TaskStatus = "queued" | "running" | "finished" | "failed" | "canceled";

interface TaskEntry {
  taskId: string;
  lineId: string;
  cacheKey: string;
  recipe: InternalAudioRecipe;
  format: AudioFormatDescriptor;
  /** Abort signal handed to the provider; aborted when all consumers leave. */
  providerSignal: AbortController;
  /** Number of consumers attached (joins included). */
  refcount: number;
  finalized: boolean;
  cancelRequested: boolean;
  status: TaskStatus;
  enqueuedAt: number;
  startedAt: number;
  firstByteMs: number | null;
  totalBytes: number;
  retryAttempt: number;
  retryAt: number;
  startedNotified: boolean;
  sessionPromise: Promise<TtsStreamSession>;
  resolveSession: (session: TtsStreamSession) => void;
  rejectSession: (error: unknown) => void;
  sessionSettled: boolean;
}

/**
 * TtsTaskServiceImpl — concrete synthesis orchestrator (§7.5, §12).
 *
 * Validates `lineId + cacheKey` against the catalog (§22 invariant 10),
 * dedups concurrent synthesis by cacheKey (§22 invariant 11, §12.4),
 * enforces a FIFO concurrency cap, streams provider PCM chunks to the
 * consumer, records per-task metrics, and cancels the upstream provider
 * task when every consumer aborts.
 */
export class TtsTaskServiceImpl implements TtsTaskService {
  /** In-flight or queued tasks keyed by cacheKey (dedup, §12.4). */
  private readonly tasks = new Map<string, TaskEntry>();
  /** FIFO waiters for the concurrency cap; waiting is never a rejection. */
  private readonly queue: TaskEntry[] = [];
  private activeCount = 0;
  private readonly minProviderStartIntervalMs: number;
  private nextProviderStartAt = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: TtsTaskServiceImplOptions) {
    this.minProviderStartIntervalMs =
      options.minProviderStartIntervalMs ?? DEFAULT_MIN_PROVIDER_START_INTERVAL_MS;
  }

  async synthesize(
    request: AudioFetchRequest,
    signal: AbortSignal,
  ): Promise<TtsStreamSession> {
    const descriptor = this.options.catalog.validateFetchRequest(request);
    if (!descriptor) {
      ttsLog("reject", request.lineId, "code=invalid_line reason=no-descriptor");
      throw new TtsTaskError(
        "invalid_line",
        `no valid audio descriptor for line ${request.lineId}`,
      );
    }
    if (signal.aborted) {
      ttsLog("reject", request.lineId, "code=canceled reason=aborted-before-start");
      throw new TtsTaskError("canceled", "synthesis aborted before start");
    }
    if (this.options.provider === null) {
      ttsLog("reject", request.lineId, "code=audio_disabled reason=provider-null");
      throw new TtsTaskError("audio_disabled", "audio synthesis disabled");
    }
    const recipe = this.options.catalog.getRecipe(request.lineId);
    if (!recipe) {
      ttsLog("reject", request.lineId, "code=invalid_line reason=no-recipe");
      throw new TtsTaskError("invalid_line", `no synthesis recipe for line ${request.lineId}`);
    }


    const existing = this.tasks.get(recipe.cacheKey);
    if (existing) {
      existing.refcount += 1;
      this.attachAbort(existing, signal);
      ttsLog(
        "join",
        request.lineId,
        `task=${shortId(existing.taskId)} cache=${recipe.cacheKey.slice(0, 8)} consumers=${existing.refcount}`,
      );
      return existing.sessionPromise;
    }

    const entry = this.createEntry(request, recipe, descriptor.format);
    this.tasks.set(recipe.cacheKey, entry);
    this.attachAbort(entry, signal);
    this.queue.push(entry);
    ttsLog(
      "queued",
      request.lineId,
      `task=${shortId(entry.taskId)} cache=${recipe.cacheKey.slice(0, 8)} active=${this.activeCount}/${this.options.maxConcurrency}`,
    );
    this.pumpQueue();
    return entry.sessionPromise;
  }

  private createEntry(
    request: AudioFetchRequest,
    recipe: InternalAudioRecipe,
    format: AudioFormatDescriptor,
  ): TaskEntry {
    let resolveSession: (session: TtsStreamSession) => void = () => {};
    let rejectSession: (error: unknown) => void = () => {};
    const sessionPromise = new Promise<TtsStreamSession>((resolve, reject) => {
      resolveSession = resolve;
      rejectSession = reject;
    });
    return {
      taskId: request.taskId,
      lineId: request.lineId,
      cacheKey: recipe.cacheKey,
      recipe,
      format,
      providerSignal: new AbortController(),
      refcount: 1,
      finalized: false,
      cancelRequested: false,
      status: "queued",
      enqueuedAt: Date.now(),
      startedAt: 0,
      firstByteMs: null,
      totalBytes: 0,
      retryAttempt: 0,
      retryAt: 0,
      startedNotified: false,
      sessionPromise,
      resolveSession,
      rejectSession,
      sessionSettled: false,
    };
  }

  private attachAbort(entry: TaskEntry, signal: AbortSignal): void {
    const onAbort = () => this.onConsumerAbort(entry);
    signal.addEventListener("abort", onAbort, { once: true });
  }

  private onConsumerAbort(entry: TaskEntry): void {
    entry.refcount -= 1;
    if (entry.refcount > 0 || entry.finalized) return;
    entry.cancelRequested = true;
    if (entry.status === "queued") {
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
      entry.finalized = true;
      entry.status = "canceled";
      this.tasks.delete(entry.cacheKey);
      this.options.onStatus({ taskId: entry.taskId, lineId: entry.lineId, status: "canceled" });
      this.pumpQueue();
      this.failSession(entry, new TtsTaskError("canceled", "synthesis canceled before start"));
      return;
    }
    entry.providerSignal.abort();
  }

  private pumpQueue(): void {
    if (this.pumpTimer !== null) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    while (this.activeCount < this.options.maxConcurrency && this.queue.length > 0) {
      const now = Date.now();
      const eligible = this.queue.filter((entry) => entry.retryAt <= now);
      if (eligible.length === 0) {
        const nextRetryAt = Math.min(...this.queue.map((entry) => entry.retryAt));
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = null;
          this.pumpQueue();
        }, Math.max(0, nextRetryAt - now));
        return;
      }
      const delay = Math.max(0, this.nextProviderStartAt - now);
      if (delay > 0) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = null;
          this.pumpQueue();
        }, delay);
        return;
      }
      eligible.sort((a, b) => this.priorityOf(a) - this.priorityOf(b) || a.enqueuedAt - b.enqueuedAt);
      const entry = eligible[0];
      if (!entry) return;
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
      this.nextProviderStartAt = Date.now() + this.minProviderStartIntervalMs;
      void this.runTask(entry);
    }
  }

  private priorityOf(entry: TaskEntry): number {
    const priority = this.options.catalog.get(entry.lineId)?.priority ?? "background";
    return PRIORITY_RANK[priority];
  }

  private async runTask(entry: TaskEntry): Promise<void> {
    const provider = this.options.provider;
    if (provider === null) return; // unreachable: synthesize rejects earlier
    entry.status = "running";
    entry.startedAt = entry.startedAt || Date.now();
    this.activeCount += 1;
    if (!entry.startedNotified) {
      entry.startedNotified = true;
      this.options.onStatus({
        taskId: entry.taskId,
        lineId: entry.lineId,
        status: "started",
      });
    }
    ttsLog(
      "running",
      entry.lineId,
      `task=${shortId(entry.taskId)} active=${this.activeCount}/${this.options.maxConcurrency}`,
    );

    let session: TtsStreamSession;
    try {
      session = await provider.start(this.buildSynthesisRequest(entry), entry.providerSignal.signal);
    } catch (error) {
      const retryDelay = RATE_LIMIT_RETRY_DELAYS_MS[entry.retryAttempt];
      if (!entry.cancelRequested && isRateLimitError(error) && retryDelay !== undefined) {
        entry.retryAttempt += 1;
        entry.retryAt = Date.now() + retryDelay;
        entry.enqueuedAt = Date.now();
        entry.status = "queued";
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.queue.push(entry);
        ttsLog(
          "provider-retry",
          entry.lineId,
          `task=${shortId(entry.taskId)} attempt=${entry.retryAttempt} delay=${retryDelay}ms`,
        );
        this.pumpQueue();
        return;
      }
      this.finish(
        entry,
        entry.cancelRequested ? "canceled" : "failed",
        error instanceof Error ? error.message : String(error),
      );
      this.failSession(entry, error);
      return;
    }

    this.settleSession(entry, {
      metadata: session.metadata,
      chunks: this.wrapChunks(entry, session.chunks),
      completion: session.completion,
    });
    void this.monitor(entry, session);
  }


  private async monitor(entry: TaskEntry, session: TtsStreamSession): Promise<void> {
    try {
      const completion = await session.completion;
      if (entry.finalized) return;
      if (entry.cancelRequested) {
        // Provider resolved with partial bytes after a consumer abort
        // (§7.5 contract): the task is canceled, never finished.
        this.finish(entry, "canceled", undefined, completion.totalBytes ?? entry.totalBytes);
      } else {
        this.finish(entry, "finished", undefined, completion.totalBytes ?? entry.totalBytes);
      }
    } catch (error) {
      if (entry.finalized) return;
      if (entry.cancelRequested) {
        this.finish(entry, "canceled");
      } else {
        this.finish(
          entry,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private settleSession(entry: TaskEntry, session: TtsStreamSession): void {
    if (entry.sessionSettled) return;
    entry.sessionSettled = true;
    entry.resolveSession(session);
  }

  private failSession(entry: TaskEntry, error: unknown): void {
    if (entry.sessionSettled) return;
    entry.sessionSettled = true;
    entry.rejectSession(error);
  }

  private finish(
    entry: TaskEntry,
    status: "finished" | "failed" | "canceled",
    error?: string,
    totalBytes?: number,
  ): void {
    if (entry.finalized) return;
    entry.finalized = true;
    entry.status = status;
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.tasks.delete(entry.cacheKey);

    const event: TaskStatusEvent = {
      taskId: entry.taskId,
      lineId: entry.lineId,
      status,
    };
    if (error !== undefined) event.error = error;
    ttsLog(
      status,
      entry.lineId,
      `task=${shortId(entry.taskId)}${totalBytes !== undefined ? ` bytes=${totalBytes}` : ""}` +
        (error !== undefined ? ` err=${error}` : ""),
    );
    if (totalBytes !== undefined) event.totalBytes = totalBytes;
    this.options.onStatus(event);
    this.pumpQueue();
  }

  /** Counts bytes and stamps first-byte latency while streaming to consumers. */
  private async *wrapChunks(
    entry: TaskEntry,
    source: AsyncIterable<Uint8Array>,
  ): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      if (entry.firstByteMs === null) {
        entry.firstByteMs = Date.now() - entry.startedAt;
      }
      entry.totalBytes += chunk.byteLength;
      yield chunk;
    }
  }

  private buildSynthesisRequest(entry: TaskEntry): TtsSynthesisRequest {
    const request: TtsSynthesisRequest = {
      text: entry.recipe.text,
      model: entry.recipe.model,
      voiceId: entry.recipe.voiceId,
      rate: entry.recipe.rate,
      pitch: entry.recipe.pitch,
      volume: entry.recipe.volume,
      seed: entry.recipe.seed,
      format: entry.format.encoding,
      sampleRate: entry.format.sampleRate,
    };
    if (entry.recipe.instruction !== undefined) {
      request.instruction = entry.recipe.instruction;
    }
    return request;
  }
}
