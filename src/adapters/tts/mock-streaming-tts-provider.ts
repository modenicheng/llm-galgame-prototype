/**
 * MockStreamingTtsProvider — deterministic streaming PCM mock for TtsProviderPort.
 *
 * Emits a gentle sine wave as s16le PCM chunks on a fixed cadence. The wave is
 * seeded from `request.seed` (same seed + same options => identical bytes;
 * different seed => different bytes) via a tiny deterministic PRNG
 * (mulberry32). It never writes to disk — the legacy `MockAudioSynthesizer`
 * wrote `mock-audio.json`; that behavior is gone in V2.
 *
 * Session semantics (documented contract):
 *  - `completion` RESOLVES with `{ totalBytes, durationMs }` on normal end.
 *  - On abort, `completion` RESOLVES promptly with `{ totalBytes }` captured so
 *    far; the consumer distinguishes abort from normal completion via the
 *    AbortSignal. Emission stops (timers cleared, iteration ends).
 *  - On `failAfterBytes` the stream THROWS mid-iteration AND `completion`
 *    REJECTS — a provider failure is an error, unlike an abort.
 */

import type {
  TtsCompletion,
  TtsProviderPort,
  TtsStreamMetadata,
  TtsSynthesisRequest,
  TtsStreamSession,
} from "../../core/ports/tts-provider-port.js";

export interface MockStreamingTtsProviderOptions {
  /** Fallback sample rate when `request.sampleRate` is not positive. Default 22050. */
  sampleRate?: number;
  /** PCM chunk size in bytes (must be even, a multiple of 2; normalized down to even). Default 4096. */
  chunkBytes?: number;
  /** Wall-clock gap between chunks after the first one. Default 100. */
  chunkIntervalMs?: number;
  /** Extra delay before the first chunk — simulates first-packet (首包) latency. Default 0. */
  firstByteDelayMs?: number;
  /** Total PCM duration in milliseconds. Default 2000. */
  durationMs?: number;
  /** If set, the stream fails once cumulative emitted bytes exceed this value (mid-stream failure). */
  failAfterBytes?: number;
}

const DEFAULT_SAMPLE_RATE = 22050;
const DEFAULT_CHUNK_BYTES = 4096;
const DEFAULT_CHUNK_INTERVAL_MS = 100;
const DEFAULT_FIRST_BYTE_DELAY_MS = 0;
const DEFAULT_DURATION_MS = 2000;

/**
 * Promise.withResolvers-style deferred. `Promise.withResolvers` itself needs
 * lib ES2024, which the project's ES2022 target does not provide, so this
 * module-local helper keeps the same linear, typed-resolver shape.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** mulberry32 — tiny deterministic PRNG: same seed, same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One continuous stretch of the sine wave, little-endian s16 PCM. */
function buildChunk(
  startSample: number,
  numSamples: number,
  sampleRate: number,
  frequency: number,
  phase: number,
): Uint8Array {
  const bytes = new Uint8Array(numSamples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < numSamples; i++) {
    const n = startSample + i;
    const value = Math.round(0.25 * 32767 * Math.sin((2 * Math.PI * frequency * n) / sampleRate + phase));
    view.setInt16(i * 2, value, true);
  }
  return bytes;
}

export class MockStreamingTtsProvider implements TtsProviderPort {
  constructor(private readonly options: MockStreamingTtsProviderOptions = {}) {}

  start(request: TtsSynthesisRequest, signal: AbortSignal): Promise<TtsStreamSession> {
    const sampleRate =
      request.sampleRate > 0 ? request.sampleRate : (this.options.sampleRate ?? DEFAULT_SAMPLE_RATE);
    const chunkBytes = Math.max(2, (this.options.chunkBytes ?? DEFAULT_CHUNK_BYTES) & ~1);
    const intervalMs = this.options.chunkIntervalMs ?? DEFAULT_CHUNK_INTERVAL_MS;
    const firstByteDelayMs = this.options.firstByteDelayMs ?? DEFAULT_FIRST_BYTE_DELAY_MS;
    const durationMs = this.options.durationMs ?? DEFAULT_DURATION_MS;
    const failAfterBytes = this.options.failAfterBytes;

    const totalSamples = Math.floor((durationMs / 1000) * sampleRate);
    const totalBytes = totalSamples * 2;
    const numChunks = totalBytes === 0 ? 0 : Math.ceil(totalBytes / chunkBytes);

    // Deterministic wave parameters derived from the request seed.
    const rng = mulberry32(request.seed);
    const phase = rng() * 2 * Math.PI;
    const frequency = 180 + rng() * 80;

    let bytesSent = 0;
    let completionSettled = false;
    const completion = deferred<TtsCompletion>();
    const timers = new Set<NodeJS.Timeout>();

    const clearTimers = (): void => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const settleResolve = (value: TtsCompletion): void => {
      if (completionSettled) return;
      completionSettled = true;
      clearTimers();
      completion.resolve(value);
    };
    const settleReject = (reason: unknown): void => {
      if (completionSettled) return;
      completionSettled = true;
      clearTimers();
      completion.reject(reason);
    };

    // Abort is a normal end for the mock: resolve with the partial byte count.
    signal.addEventListener("abort", () => settleResolve({ totalBytes: bytesSent }), { once: true });
    if (signal.aborted) settleResolve({ totalBytes: bytesSent });

    /** Resolves after `ms`, or immediately when the signal aborts mid-wait. */
    const wait = (ms: number): Promise<void> => {
      const result = deferred<void>();
      if (signal.aborted) {
        result.resolve();
        return result.promise;
      }
      const onAbortWait = (): void => {
        clearTimeout(timer);
        timers.delete(timer);
        result.resolve();
      };
      const timer = setTimeout(() => {
        timers.delete(timer);
        signal.removeEventListener("abort", onAbortWait);
        result.resolve();
      }, ms);
      timers.add(timer);
      signal.addEventListener("abort", onAbortWait, { once: true });
      return result.promise;
    };

    async function* generateChunks(): AsyncGenerator<Uint8Array> {
      let index = 0;
      let sampleIndex = 0;
      while (index < numChunks) {
        if (signal.aborted) break;
        await wait(index === 0 ? firstByteDelayMs : intervalMs);
        if (signal.aborted) break;
        const size = Math.min(chunkBytes, totalBytes - bytesSent);
        const samples = size / 2;
        const chunk = buildChunk(sampleIndex, samples, sampleRate, frequency, phase);
        sampleIndex += samples;
        bytesSent += size;
        if (failAfterBytes !== undefined && bytesSent > failAfterBytes) {
          const error = new Error(
            `mock streaming TTS provider failed after ${bytesSent} bytes (failAfterBytes=${failAfterBytes})`,
          );
          settleReject(error);
          throw error;
        }
        yield chunk;
        index++;
      }
      settleResolve({ totalBytes: bytesSent, durationMs });
    }

    const metadata: TtsStreamMetadata = {
      encoding: "pcm_s16le",
      sampleRate,
      channels: 1,
      bitDepth: 16,
    };

    return Promise.resolve({
      metadata,
      chunks: generateChunks(),
      completion: completion.promise,
    });
  }
}
