/**
 * Tests for TtsTaskServiceImpl: validation, dedup by cacheKey (§22
 * invariant 11), concurrency caps, consumer abort → provider cancel, and
 * provider failure propagation.
 */
import { describe, it, expect } from "vitest";
import { TtsTaskError, TtsTaskServiceImpl, type TaskStatusEvent } from "./tts-task-service.js";
import { AudioCatalogServiceImpl } from "./audio-catalog-service.js";
import type { TtsCompletion, TtsProviderPort, TtsStreamSession } from "../../core/ports/tts-provider-port.js";
import type { AudioFetchRequest } from "../../shared/wire/client-message.js";

class FakeTtsProvider implements TtsProviderPort {
  calls: Array<{ signal: AbortSignal }> = [];
  failStart = false;
  readonly chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];

  async start(_request: unknown, signal: AbortSignal): Promise<TtsStreamSession> {
    this.calls.push({ signal });
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
      text: "你好",
      model: "cosyvoice-v2",
      voiceId: "voice-1",
      voiceRevision: 1,
      rate: 1,
      pitch: 1,
      volume: 1,
      seed: 1,
    },
  );
  return key;
}

function request(lineId: string, cacheKey: string, taskId = "t1"): AudioFetchRequest {
  return { taskId, lineId, cacheKey };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
});
