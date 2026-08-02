/**
 * TtsTaskService — Node-side synthesis task orchestration (§7.5).
 *
 * Validates `lineId + cacheKey`, enforces concurrency and priority
 * limits, delegates to the TtsProviderPort, exposes PCM chunks as an
 * AsyncIterable, records per-task metrics, and cancels the upstream task
 * when the browser aborts the HTTP request.
 */
import type { AudioFetchRequest } from "../../shared/wire/client-message.js";
import type { AudioFormatDescriptor } from "../../shared/wire/audio-descriptor.js";
import type {
  TtsProviderPort,
  TtsStreamSession,
  TtsSynthesisRequest,
} from "../../core/ports/tts-provider-port.js";
import type { AudioCatalogService } from "./audio-catalog-service.js";
import type { InternalAudioRecipe } from "./internal-audio-recipe.js";

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
  /** A consumer aborted and the last joiner left; the task must be canceled. */
  cancelRequested: boolean;
  status: TaskStatus;
  enqueuedAt: number;
  startedAt: number;
  firstByteMs: number | null;
  totalBytes: number;
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

  constructor(private readonly options: TtsTaskServiceImplOptions) {}

  async synthesize(
    request: AudioFetchRequest,
    signal: AbortSignal,
  ): Promise<TtsStreamSession> {
    const descriptor = this.options.catalog.validateFetchRequest(request);
    if (!descriptor) {
      throw new TtsTaskError(
        "invalid_line",
        `no valid audio descriptor for line ${request.lineId}`,
      );
    }
    if (signal.aborted) {
      throw new TtsTaskError("canceled", "synthesis aborted before start");
    }
    if (this.options.provider === null) {
      throw new TtsTaskError("audio_disabled", "audio synthesis disabled");
    }
    const recipe = this.options.catalog.getRecipe(request.lineId);
    if (!recipe) {
      throw new TtsTaskError("invalid_line", `no synthesis recipe for line ${request.lineId}`);
    }

    const existing = this.tasks.get(recipe.cacheKey);
    if (existing) {
      existing.refcount += 1;
      this.attachAbort(existing, signal);
      return existing.sessionPromise;
    }

    const entry = this.createEntry(request, recipe, descriptor.format);
    this.tasks.set(recipe.cacheKey, entry);
    this.attachAbort(entry, signal);
    this.queue.push(entry);
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
      // Not started yet: drop from the FIFO queue and reject the session.
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
      entry.finalized = true;
      entry.status = "canceled";
      this.tasks.delete(entry.cacheKey);
      this.failSession(entry, new TtsTaskError("canceled", "synthesis canceled before start"));
      return;
    }
    // Running: abort the provider signal; the monitor reports "canceled".
    entry.providerSignal.abort();
  }

  private pumpQueue(): void {
    while (this.activeCount < this.options.maxConcurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry || entry.finalized) continue;
      void this.runTask(entry);
    }
  }

  private async runTask(entry: TaskEntry): Promise<void> {
    const provider = this.options.provider;
    if (provider === null) return; // unreachable: synthesize rejects earlier
    entry.status = "running";
    entry.startedAt = Date.now();
    this.activeCount += 1;
    this.options.onStatus({
      taskId: entry.taskId,
      lineId: entry.lineId,
      status: "started",
    });

    let session: TtsStreamSession;
    try {
      session = await provider.start(
        this.buildSynthesisRequest(entry),
        entry.providerSignal.signal,
      );
    } catch (error) {
      // `finish`/`failSession` are idempotent, so this is safe even if a
      // concurrent consumer abort already finalized the entry.
      this.finish(
        entry,
        entry.cancelRequested ? "canceled" : "failed",
        error instanceof Error ? error.message : String(error),
      );
      this.failSession(entry, error);
      return;
    }

    // If the consumer aborted while the provider was starting, the provider
    // signal was already aborted: completion will reject and the monitor
    // reports "canceled". The session is still handed out so no promise is
    // left hanging.
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
