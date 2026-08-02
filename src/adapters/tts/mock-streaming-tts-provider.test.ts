/**
 * Tests for MockStreamingTtsProvider — deterministic, timer-driven PCM stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsSynthesisRequest } from "../../core/ports/tts-provider-port.js";
import { MockStreamingTtsProvider } from "./mock-streaming-tts-provider.js";

function makeRequest(overrides: Partial<TtsSynthesisRequest> = {}): TtsSynthesisRequest {
  return {
    text: "hello mock",
    model: "mock-model",
    voiceId: "mock-voice",
    rate: 1,
    pitch: 1,
    volume: 100,
    seed: 7,
    format: "pcm_s16le",
    sampleRate: 8000,
    ...overrides,
  };
}

/** Pull every chunk, advancing fake timers until the stream ends. */
async function drainAll(
  provider: MockStreamingTtsProvider,
  request: TtsSynthesisRequest,
): Promise<Uint8Array[]> {
  const session = await provider.start(request, new AbortController().signal);
  const parts: Uint8Array[] = [];
  const iterator = session.chunks[Symbol.asyncIterator]();
  for (;;) {
    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    if (result.done) break;
    parts.push(result.value);
  }
  return parts;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("MockStreamingTtsProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes s16le mono metadata at the request sample rate", async () => {
    const provider = new MockStreamingTtsProvider();
    const session = await provider.start(makeRequest({ sampleRate: 16000 }), new AbortController().signal);
    expect(session.metadata).toEqual({
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
      bitDepth: 16,
    });
  });

  it("emits the first chunk before completion when firstByteDelayMs is within the duration", async () => {
    const provider = new MockStreamingTtsProvider({
      chunkBytes: 4096,
      chunkIntervalMs: 100,
      firstByteDelayMs: 100,
      durationMs: 1000,
    });
    const session = await provider.start(makeRequest(), new AbortController().signal);
    const iterator = session.chunks[Symbol.asyncIterator]();

    // Attach an outcome handler immediately so a later rejection/settlement
    // can never surface as an unhandled promise rejection.
    const completionOutcome = session.completion.then(
      () => "completed",
      () => "rejected",
    );

    const first = iterator.next();
    await vi.advanceTimersByTimeAsync(100);
    const firstResult = await first;
    expect(firstResult.done).toBe(false);
    expect((firstResult.value as Uint8Array).byteLength).toBe(4096);
    expect(await Promise.race([completionOutcome, Promise.resolve("pending")])).toBe("pending");

    // Pull the remaining chunks (t=200, 300, 400) so the generator can finish.
    let chunkCount = 1;
    for (;;) {
      const pending = iterator.next();
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;
      if (result.done) break;
      chunkCount++;
    }
    expect(chunkCount).toBe(4);
    expect(await completionOutcome).toBe("completed");
    await expect(session.completion).resolves.toEqual({ totalBytes: 16000, durationMs: 1000 });
  });

  it("produces exactly durationMs/1000*sampleRate*2 bytes when concatenated", async () => {
    const provider = new MockStreamingTtsProvider({
      chunkBytes: 4096,
      chunkIntervalMs: 50,
      durationMs: 1000,
    });
    const parts = await drainAll(provider, makeRequest());
    const all = concat(parts);
    expect(all.byteLength).toBe((1000 / 1000) * 8000 * 2); // 16000

    // s16le means every two bytes are one sample; chunks must stay even.
    expect(all.byteLength % 2).toBe(0);
    expect(parts.length).toBeGreaterThan(1);
  });

  it("is deterministic: same seed + recipe => identical bytes, different seed => different bytes", async () => {
    const options = { chunkBytes: 4096, chunkIntervalMs: 50, durationMs: 1000 };
    const a = concat(await drainAll(new MockStreamingTtsProvider(options), makeRequest({ seed: 1 })));
    const b = concat(await drainAll(new MockStreamingTtsProvider(options), makeRequest({ seed: 1 })));
    const c = concat(await drainAll(new MockStreamingTtsProvider(options), makeRequest({ seed: 2 })));

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it("stops emission on abort and resolves completion with the partial byte count", async () => {
    const provider = new MockStreamingTtsProvider({
      chunkBytes: 4096,
      chunkIntervalMs: 100,
      firstByteDelayMs: 100,
      durationMs: 1000,
    });
    const controller = new AbortController();
    const session = await provider.start(makeRequest(), controller.signal);
    const iterator = session.chunks[Symbol.asyncIterator]();

    const first = iterator.next();
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).done).toBe(false);

    const second = iterator.next();
    await vi.advanceTimersByTimeAsync(100);
    expect((await second).done).toBe(false);

    controller.abort();
    await expect(session.completion).resolves.toEqual({ totalBytes: 8192 });

    const after = await iterator.next();
    expect(after.done).toBe(true);
  });

  it("fails mid-stream at failAfterBytes: iteration throws and completion rejects", async () => {
    const provider = new MockStreamingTtsProvider({
      chunkBytes: 4096,
      chunkIntervalMs: 100,
      firstByteDelayMs: 100,
      durationMs: 1000,
      failAfterBytes: 4096,
    });
    const session = await provider.start(makeRequest(), new AbortController().signal);
    const iterator = session.chunks[Symbol.asyncIterator]();

    // Attach early so the completion rejection can never be reported unhandled.
    const completionOutcome = session.completion.then(
      () => "resolved",
      (reason: unknown) => `rejected: ${(reason as Error).message}`,
    );

    // 4096 emitted bytes does not exceed failAfterBytes=4096, so chunk 1 flows.
    const first = iterator.next();
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).done).toBe(false);

    const second = iterator.next();
    // Attach at creation: the rejection lands inside advanceTimersByTimeAsync,
    // which crosses a macrotask boundary — a late handler would be flagged as
    // an unhandled rejection.
    const secondOutcome = second.then(
      () => "resolved",
      (reason: unknown) => `rejected: ${(reason as Error).message}`,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await secondOutcome).toBe(
      "rejected: mock streaming TTS provider failed after 8192 bytes (failAfterBytes=4096)",
    );
    expect(await completionOutcome).toBe(
      "rejected: mock streaming TTS provider failed after 8192 bytes (failAfterBytes=4096)",
    );
    await expect(session.completion).rejects.toThrow(/failed after 8192 bytes/);
  });
});
