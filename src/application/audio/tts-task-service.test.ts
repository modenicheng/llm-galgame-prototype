/**
 * Tests for TtsTaskServiceImpl: validation, dedup by cacheKey (§22
 * invariant 11), concurrency caps, consumer abort → provider cancel, and
 * provider failure propagation.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { TtsTaskError, TtsTaskServiceImpl, type TaskStatusEvent } from "./tts-task-service.js";
import { AudioCatalogServiceImpl } from "./audio-catalog-service.js";
import type { TtsCompletion, TtsProviderPort, TtsStreamSession, TtsSynthesisRequest } from "../../core/ports/tts-provider-port.js";
import type { AudioFetchRequest } from "../../shared/wire/client-message.js";

class FakeTtsProvider implements TtsProviderPort {
  calls: Array<{ request: TtsSynthesisRequest; signal: AbortSignal }> = [];
  failStart = false;
  readonly chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];

  async start(request: TtsSynthesisRequest, signal: AbortSignal): Promise<TtsStreamSession> {
    this.calls.push({ request, signal });
    if (this.failStart) throw new Error("provider failure");
    let resolveCompletion: (c: TtsCompletion) => void = () => {};
    let rejectCompletion: (error: unknown) => void = () => {};
    const completion = new Promise<TtsCompletion>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const onAbort = () => rejectCompletion(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });

    const chunks = this.emitChunks(signal, resolveCompletion, rejectCompletion);
    return {
      metadata: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1, bitDepth: 16 },
      chunks,
      completion,
    };
  }

  private async *emitChunks(
    signal: AbortSignal,
    resolve: (c: TtsCompletion) => void,
    reject: (error: unknown) => void,
  ): AsyncGenerator<Uint8Array> {
    try {
      for (const chunk of this.chunks) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        yield chunk;
      }
      resolve({ totalBytes: 6 });
    } catch (error) {
      reject(error);
    }
  }
}

/**
 * Provider that RESOLVES completion with partial bytes when aborted —
 * mirrors the Task B provider contract: abort stops streaming but the
 * completion promise settles with whatever bytes were already emitted
 * (never rejects).
 */
class ResolvingAbortProvider implements TtsProviderPort {
  calls: Array<{ signal: AbortSignal }> = [];
  readonly chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];

  async start(_request: unknown, signal: AbortSignal): Promise<TtsStreamSession> {
    this.calls.push({ signal });
    let resolveCompletion: (c: TtsCompletion) => void = () => {};
    const completion = new Promise<TtsCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    // Abort resolves with the partial byte count — no rejection.
    signal.addEventListener(
      "abort",
      () => resolveCompletion({ totalBytes: this.chunks[0]!.byteLength }),
      { once: true },
    );
    const chunks = this.emitChunks(signal, resolveCompletion);
    return {
      metadata: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1, bitDepth: 16 },
      chunks,
      completion,
    };
  }

  private async *emitChunks(
    signal: AbortSignal,
    resolve: (c: TtsCompletion) => void,
  ): AsyncGenerator<Uint8Array> {
    let emitted = 0;
    for (const chunk of this.chunks) {
      if (signal.aborted) break;
      emitted += chunk.byteLength;
      yield chunk;
    }
    resolve({ totalBytes: emitted });
  }
}

class RetrySequenceProvider extends FakeTtsProvider {
  attempts = 0;

  constructor(private readonly errors: unknown[]) {
    super();
  }

  override async start(request: TtsSynthesisRequest, signal: AbortSignal): Promise<TtsStreamSession> {
    this.calls.push({ request, signal });
    const error = this.errors[this.attempts];
    this.attempts += 1;
    if (error !== undefined) throw error;
    return super.start(request, signal);
  }
}

class SynchronizedRateLimitProvider extends FakeTtsProvider {
  readonly attemptTimes: number[] = [];
  private readonly attemptsByText = new Map<string, number>();
  private releaseFirstAttempts: () => void = () => {};
  private readonly firstAttemptsReleased = new Promise<void>((resolve) => {
    this.releaseFirstAttempts = resolve;
  });

  releaseRateLimits(): void {
    this.releaseFirstAttempts();
  }

  override async start(
    request: TtsSynthesisRequest,
    signal: AbortSignal,
  ): Promise<TtsStreamSession> {
    this.attemptTimes.push(Date.now());
    const attempts = this.attemptsByText.get(request.text) ?? 0;
    this.attemptsByText.set(request.text, attempts + 1);
    if (attempts === 0) {
      await this.firstAttemptsReleased;
      throw rateLimitError();
    }
    return super.start(request, signal);
  }
}

const rateLimitError = (): Error & { code: string } =>
  Object.assign(new Error("rate limited"), { code: "http_429" });

function seedCatalog(catalog: AudioCatalogServiceImpl, lineId: string, cacheKey?: string): string {
  const key = cacheKey ?? `key-${lineId}`;
  catalog.upsertDescriptor(
    {
      lineId,
      cacheKey: key,
      scope: { type: "active" },
      priority: "current",
      speakerId: "suyao",
      displaySpeaker: "苏遥",
      format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
    },
    {
      lineId,
      cacheKey: key,
      text: lineId,
      model: "cosyvoice-v2",
      voiceId: "voice-1",
      voiceRevision: 1,
      rate: 1,
      pitch: 1,
      volume: 1,
      pauseBeforeMs: 0,
      pauseAfterMs: 0,
      seed: 1,
    },
  );
  return key;
}

function request(lineId: string, cacheKey: string, taskId = "t1"): AudioFetchRequest {
  return { taskId, lineId, cacheKey };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("TtsTaskServiceImpl", () => {
  it("streams provider chunks for a valid request and reports finished", async () => {
    const catalog = new AudioCatalogServiceImpl();
    const key = seedCatalog(catalog, "l1");
    const provider = new FakeTtsProvider();
    const statuses: TaskStatusEvent[] = [];
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 2,
      onStatus: (event) => statuses.push(event),
    });

    const session = await service.synthesize(request("l1", key), new AbortController().signal);

    const received: Uint8Array[] = [];
    for await (const chunk of session.chunks) received.push(chunk);
    await session.completion;
    await flush();

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(provider.calls).toHaveLength(1);
    expect(statuses.map((s) => s.status)).toEqual(["started", "finished"]);
    expect(statuses.find((s) => s.status === "finished")?.totalBytes).toBe(6);
  });

  it("rejects with invalid_line for an unknown lineId", async () => {
    const catalog = new AudioCatalogServiceImpl();
    seedCatalog(catalog, "l1");
    const service = new TtsTaskServiceImpl({
      catalog,
      provider: new FakeTtsProvider(),
      maxConcurrency: 2,
      onStatus: () => {},
    });

    await expect(service.synthesize(request("ghost", "key-ghost"), new AbortController().signal)).rejects.toBeInstanceOf(
      TtsTaskError,
    );
    await expect(
      service.synthesize(request("ghost", "key-ghost"), new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_line" });
  });

  it("rejects with invalid_line for a forged cacheKey", async () => {
    const catalog = new AudioCatalogServiceImpl();
    seedCatalog(catalog, "l1");
    const service = new TtsTaskServiceImpl({
      catalog,
      provider: new FakeTtsProvider(),
      maxConcurrency: 2,
      onStatus: () => {},
    });

    await expect(service.synthesize(request("l1", "forged"), new AbortController().signal)).rejects.toMatchObject({
      code: "invalid_line",
    });
  });

  it("rejects with audio_disabled when no provider is configured", async () => {
    const catalog = new AudioCatalogServiceImpl();
    const key = seedCatalog(catalog, "l1");
    const service = new TtsTaskServiceImpl({
      catalog,
      provider: null,
      maxConcurrency: 2,
      onStatus: () => {},
    });

    await expect(service.synthesize(request("l1", key), new AbortController().signal)).rejects.toMatchObject({
      code: "audio_disabled",
    });
  });

  it("rejects with canceled when the signal is already aborted", async () => {
    const catalog = new AudioCatalogServiceImpl();
    const key = seedCatalog(catalog, "l1");
    const service = new TtsTaskServiceImpl({
      catalog,
      provider: new FakeTtsProvider(),
      maxConcurrency: 2,
      onStatus: () => {},
    });
    const aborted = new AbortController();
    aborted.abort();

    await expect(service.synthesize(request("l1", key), aborted.signal)).rejects.toMatchObject({
      code: "canceled",
    });
  });

  it("dedups by cacheKey: one provider task, two consumers share the session", async () => {
    const catalog = new AudioCatalogServiceImpl();
    // Two lines with identical content share one cacheKey.
    const key = seedCatalog(catalog, "l1");
    seedCatalog(catalog, "l2", key);
    const provider = new FakeTtsProvider();
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 2,
      onStatus: () => {},
    });

    const sessionA = service.synthesize(request("l1", key, "t1"), new AbortController().signal);
    const sessionB = service.synthesize(request("l2", key, "t2"), new AbortController().signal);
    const [a, b] = await Promise.all([sessionA, sessionB]);

    expect(provider.calls).toHaveLength(1);
    expect(a).toBe(b); // same joined session
  });

  it("cancels the provider task when the last consumer aborts", async () => {
    const catalog = new AudioCatalogServiceImpl();
    const key = seedCatalog(catalog, "l1");
    const provider = new FakeTtsProvider();
    const statuses: TaskStatusEvent[] = [];
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 2,
      onStatus: (event) => statuses.push(event),
    });
    const controller = new AbortController();
    const session = await service.synthesize(request("l1", key), controller.signal);

    controller.abort();
    await flush();

    expect(provider.calls[0]?.signal.aborted).toBe(true);
    expect(statuses.map((s) => s.status)).toContain("canceled");
    // Completion rejects because the provider signal aborted.
    await expect(session.completion).rejects.toThrow();
  });

  it("cancels a joined task only when all joiners abort", async () => {
    const catalog = new AudioCatalogServiceImpl();
    const key = seedCatalog(catalog, "l1");
    const provider = new FakeTtsProvider();
    const statuses: TaskStatusEvent[] = [];
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 2,
      onStatus: (event) => statuses.push(event),
    });
    const a = new AbortController();
    const b = new AbortController();
    const sessionA = await service.synthesize(request("l1", key, "t1"), a.signal);
    const sessionB = await service.synthesize(request("l1", key, "t2"), b.signal);
    void sessionB;

    // First joiner leaves: task still runs.
    a.abort();
    await flush();
    expect(provider.calls[0]?.signal.aborted).toBe(false);
    expect(statuses.map((s) => s.status)).not.toContain("canceled");

    // Last joiner leaves: task canceled.
    b.abort();
    await flush();
    expect(provider.calls[0]?.signal.aborted).toBe(true);
    expect(statuses.map((s) => s.status)).toContain("canceled");
    await expect(sessionA.completion).rejects.toThrow();
  });

  it("rejects a queued task immediately when its consumer aborts before start", async () => {
    const catalog = new AudioCatalogServiceImpl();
    const keyA = seedCatalog(catalog, "l1");
    const keyB = seedCatalog(catalog, "l2");
    const provider = new FakeTtsProvider();
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 1,
      onStatus: () => {},
    });

    // First task occupies the single slot without finishing.
    const first = await service.synthesize(request("l1", keyA, "t1"), new AbortController().signal);
    // Second task is queued.
    const secondController = new AbortController();
    const second = service.synthesize(request("l2", keyB, "t2"), secondController.signal);

    secondController.abort();
    await expect(second).rejects.toMatchObject({ code: "canceled" });
    expect(provider.calls).toHaveLength(1); // queued task never reached the provider

    // Cleanup: let the first task finish.
    for await (const _ of first.chunks) {
      /* drain */
    }
    await first.completion;
  });

  it("enforces the concurrency cap with a FIFO queue", async () => {
    const catalog = new AudioCatalogServiceImpl();
    const keyA = seedCatalog(catalog, "l1");
    const keyB = seedCatalog(catalog, "l2");
    const provider = new FakeTtsProvider();
    const statuses: TaskStatusEvent[] = [];
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 1,
      onStatus: (event) => statuses.push(event),
    });

    const first = service.synthesize(request("l1", keyA, "t1"), new AbortController().signal);
    const second = service.synthesize(request("l2", keyB, "t2"), new AbortController().signal);
    const sessionA = await first;

    // Slot is full: second task has not reached the provider yet.
    expect(provider.calls).toHaveLength(1);

    for await (const _ of sessionA.chunks) {
      /* drain */
    }
    await sessionA.completion;
    await flush();

    const sessionB = await second;
    expect(provider.calls).toHaveLength(2);
    for await (const _ of sessionB.chunks) {
      /* drain */
    }
    await sessionB.completion;
    await flush();

    const started = statuses.filter((s) => s.status === "started");
    const finished = statuses.filter((s) => s.status === "finished");
    expect(started).toHaveLength(2);
    expect(finished).toHaveLength(2);
    // FIFO: t2 starts only after t1 finished.
    expect(started[0]?.taskId).toBe("t1");
    expect(started[1]?.taskId).toBe("t2");
    expect(finished[0]?.taskId).toBe("t1");
  });

  it("reports canceled (not finished) when the provider resolves with partial bytes on abort", async () => {
    const catalog = new AudioCatalogServiceImpl();
    const key = seedCatalog(catalog, "l1");
    const provider = new ResolvingAbortProvider();
    const statuses: TaskStatusEvent[] = [];
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 2,
      onStatus: (event) => statuses.push(event),
    });
    const controller = new AbortController();
    const session = await service.synthesize(request("l1", key), controller.signal);

    controller.abort();
    await flush();

    expect(provider.calls[0]?.signal.aborted).toBe(true);
    const canceled = statuses.find((s) => s.status === "canceled");
    expect(canceled).toBeDefined();
    expect(canceled?.totalBytes).toBe(3); // partial count, not the full 6
    expect(statuses.map((s) => s.status)).not.toContain("finished");
    // Provider contract: completion resolves with partial bytes, never rejects.
    await expect(session.completion).resolves.toEqual({ totalBytes: 3 });
  });

  it("reports finished when completion resolves without abort", async () => {
    const catalog = new AudioCatalogServiceImpl();
    const key = seedCatalog(catalog, "l1");
    const provider = new ResolvingAbortProvider();
    const statuses: TaskStatusEvent[] = [];
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 2,
      onStatus: (event) => statuses.push(event),
    });
    const session = await service.synthesize(request("l1", key), new AbortController().signal);

    for await (const _ of session.chunks) {
      /* drain */
    }
    await session.completion;
    await flush();

    const finished = statuses.find((s) => s.status === "finished");
    expect(finished).toBeDefined();
    expect(finished?.totalBytes).toBe(6);
    expect(statuses.map((s) => s.status)).not.toContain("canceled");
  });

  it("propagates provider failure and emits failed", async () => {
    const catalog = new AudioCatalogServiceImpl();
    const key = seedCatalog(catalog, "l1");
    const provider = new FakeTtsProvider();
    provider.failStart = true;
    const statuses: TaskStatusEvent[] = [];
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 2,
      onStatus: (event) => statuses.push(event),
    });

    await expect(service.synthesize(request("l1", key), new AbortController().signal)).rejects.toThrow(
      "provider failure",
    );
    expect(statuses.map((s) => s.status)).toContain("failed");
    expect(statuses.find((s) => s.status === "failed")?.error).toBe("provider failure");
  });

  it("retries provider start after HTTP 429 and emits one successful task", async () => {
    vi.useFakeTimers();
    const catalog = new AudioCatalogServiceImpl();
    const key = seedCatalog(catalog, "l1");
    const provider = new RetrySequenceProvider([rateLimitError(), rateLimitError()]);
    const statuses: TaskStatusEvent[] = [];
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 2,
      onStatus: (event) => statuses.push(event),
    });

    const pending = service.synthesize(request("l1", key), new AbortController().signal);
    await vi.runAllTimersAsync();
    const session = await pending;
    for await (const _ of session.chunks) {
      /* drain */
    }
    await session.completion;
    await vi.runAllTimersAsync();

    expect(provider.attempts).toBe(3);
    expect(statuses.map((event) => event.status)).toEqual(["started", "finished"]);
  });

  it("cancels a task while it is waiting to retry HTTP 429", async () => {
    vi.useFakeTimers();
    const catalog = new AudioCatalogServiceImpl();
    const key = seedCatalog(catalog, "l1");
    const provider = new RetrySequenceProvider([rateLimitError()]);
    const statuses: TaskStatusEvent[] = [];
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 2,
      onStatus: (event) => statuses.push(event),
    });
    const controller = new AbortController();

    const pending = service.synthesize(request("l1", key), controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: "canceled" });
    await Promise.resolve();
    controller.abort();
    await vi.runAllTimersAsync();

    await rejection;
    expect(provider.attempts).toBe(1);
    expect(statuses.map((event) => event.status)).toEqual(["started", "canceled"]);
  });

  it("spaces provider starts to avoid a request burst", async () => {
    vi.useFakeTimers();
    const catalog = new AudioCatalogServiceImpl();
    const keyA = seedCatalog(catalog, "l1");
    const keyB = seedCatalog(catalog, "l2");
    const provider = new FakeTtsProvider();
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 2,
      onStatus: () => {},
    });

    const first = service.synthesize(request("l1", keyA, "t1"), new AbortController().signal);
    const second = service.synthesize(request("l2", keyB, "t2"), new AbortController().signal);
    await Promise.resolve();
    expect(provider.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(349);
    expect(provider.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.calls).toHaveLength(2);

    for (const pending of [first, second]) {
      const session = await pending;
      for await (const _ of session.chunks) {
        /* drain */
      }
      await session.completion;
    }
  });

  it("keeps synchronized HTTP 429 retries behind the provider start gate", async () => {
    vi.useFakeTimers();
    const catalog = new AudioCatalogServiceImpl();
    const keyA = seedCatalog(catalog, "l1");
    const keyB = seedCatalog(catalog, "l2");
    const provider = new SynchronizedRateLimitProvider();
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 2,
      onStatus: () => {},
    });

    const first = service.synthesize(request("l1", keyA, "t1"), new AbortController().signal);
    const second = service.synthesize(request("l2", keyB, "t2"), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(350);
    provider.releaseRateLimits();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    expect(provider.attemptTimes).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(349);
    expect(provider.attemptTimes).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.attemptTimes).toHaveLength(4);

    for (const pending of [first, second]) {
      const session = await pending;
      for await (const _ of session.chunks) {
        /* drain */
      }
      await session.completion;
    }
  });

  it("lets queued current work bypass a background task during 429 backoff", async () => {
    vi.useFakeTimers();
    const catalog = new AudioCatalogServiceImpl();
    const backgroundKey = seedCatalog(catalog, "background");
    const currentKey = seedCatalog(catalog, "current");
    catalog.setPriority("background", "background");
    catalog.setPriority("current", "current");
    const provider = new RetrySequenceProvider([rateLimitError()]);
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 1,
      onStatus: () => {},
    });

    const background = service.synthesize(
      request("background", backgroundKey, "t-background"),
      new AbortController().signal,
    );
    await Promise.resolve();
    const current = service.synthesize(
      request("current", currentKey, "t-current"),
      new AbortController().signal,
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(350);

    expect(provider.calls[1]?.request.text).toBe("current");
    const currentSession = await current;
    for await (const _ of currentSession.chunks) {
      /* drain */
    }
    await currentSession.completion;
    await vi.advanceTimersByTimeAsync(1000);
    const backgroundSession = await background;
    for await (const _ of backgroundSession.chunks) {
      /* drain */
    }
    await backgroundSession.completion;
  });

  it("starts a queued current line before queued background work", async () => {
    vi.useFakeTimers();
    const catalog = new AudioCatalogServiceImpl();
    const firstKey = seedCatalog(catalog, "first");
    const backgroundKey = seedCatalog(catalog, "background");
    const currentKey = seedCatalog(catalog, "current");
    catalog.setPriority("background", "background");
    catalog.setPriority("current", "current");
    const provider = new FakeTtsProvider();
    const service = new TtsTaskServiceImpl({
      catalog,
      provider,
      maxConcurrency: 1,
      onStatus: () => {},
    });

    const first = await service.synthesize(
      request("first", firstKey, "t-first"),
      new AbortController().signal,
    );
    const background = service.synthesize(
      request("background", backgroundKey, "t-background"),
      new AbortController().signal,
    );
    const current = service.synthesize(
      request("current", currentKey, "t-current"),
      new AbortController().signal,
    );
    for await (const _ of first.chunks) {
      /* drain */
    }
    await first.completion;
    await vi.advanceTimersByTimeAsync(350);

    expect(provider.calls[1]?.request.text).toBe("current");
    const currentSession = await current;
    for await (const _ of currentSession.chunks) {
      /* drain */
    }
    await currentSession.completion;
    await vi.advanceTimersByTimeAsync(350);
    const backgroundSession = await background;
    for await (const _ of backgroundSession.chunks) {
      /* drain */
    }
    await backgroundSession.completion;
  });
});
