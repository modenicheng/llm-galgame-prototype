/**
 * DashScopeCosyVoiceProvider — streaming CosyVoice synthesis over DashScope HTTP SSE.
 *
 * Implements `TtsProviderPort`. PCM chunks are streamed as they arrive over the
 * DashScope SpeechSynthesizer SSE endpoint; no file is written and no
 * audio URL is downloaded — PCM stays on the wire (V2 semantics). This module
 * is Node-only: it never imports IndexedDB or any browser API.
 *
 * Wire shape (verified against Alibaba Cloud Model Studio docs; see report):
 *   POST https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
 *   Authorization: Bearer <apiKey>
 *   Content-Type: application/json
 *   X-DashScope-Data-Inspector: enable   (inspection header per design contract)
 *   X-DashScope-SSE: enable              (documented streaming enabler for this endpoint)
 *   body: { model, input: { text, voice, format: "pcm", sample_rate, rate, pitch, volume, seed, instruction? } }
 *   events: `data: { "output": { "audio": { ...base64 pcm... }, "finish_reason": ... } }`
 *
 * The base64 field is read from `output.audio.audio_data` first (legacy name
 * used by the design contract) and falls back to `output.audio.data` (the name
 * used by the current official docs). `finish_reason: "stop"` ends the stream.
 *
 * Session semantics:
 *  - `completion` RESOLVES with `{ totalBytes, durationMs, providerRequestId }`
 *    on normal end, and with `{ totalBytes }` on abort (bytes so far; the
 *    consumer distinguishes abort via the AbortSignal). On abort the fetch is
 *    aborted and parsing stops.
 *  - `completion` REJECTS with a typed `TtsProviderError` on provider failure:
 *    `http_<status>`, `first_chunk_timeout`, or `sse_parse`.
 *  - No retry logic here — retries live in TtsTaskService (Task G).
 */

import type {
  TtsCompletion,
  TtsProviderPort,
  TtsStreamMetadata,
  TtsSynthesisRequest,
  TtsStreamSession,
} from "../../core/ports/tts-provider-port.js";
import { ttsLog } from "../../application/audio/tts-log.js";

export const DASHSCOPE_DEFAULT_BASE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
export const DASHSCOPE_DEFAULT_TIMEOUT_MS = 120_000;

export interface DashScopeCosyVoiceProviderOptions {
  apiKey: string;
  /** DashScope SpeechSynthesizer endpoint. Defaults to the official TTS service URL. */
  baseUrl?: string;
  /** First-chunk deadline in ms. Default 120000. */
  timeoutMs?: number;
  /** Injectable fetch implementation for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable base64 decoder. Defaults to `Buffer.from(b64, "base64")`. */
  decode?: (base64Chunk: string) => Uint8Array;
}

/** Typed provider failure. `code` is one of `http_<status>`, `first_chunk_timeout`, `sse_parse`. */
export class TtsProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TtsProviderError";
    this.code = code;
  }
}

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

interface DashScopeSseEvent {
  request_id?: string;
  code?: unknown;
  message?: unknown;
  output?: {
    finish_reason?: unknown;
    audio?: {
      /** Legacy base64 PCM field (design contract). */
      audio_data?: unknown;
      /** Base64 PCM field per current official docs. */
      data?: unknown;
    };
  };
}

/** Extract a non-empty base64 PCM payload from an SSE event, if any. */
function extractAudioPayload(event: DashScopeSseEvent): string | undefined {
  const audio = event.output?.audio;
  if (audio === undefined) return undefined;
  const raw = audio.audio_data ?? audio.data;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** DashScope surfaces API errors as SSE events carrying a non-200 `code`. */
function isApiErrorEvent(event: DashScopeSseEvent): boolean {
  const code = event.code;
  if (code === undefined || code === null || code === "") return false;
  if (code === 200) return false;
  return true;
}

/** Parse a DashScope SSE byte stream into JSON events (`data:` lines, blank-line separated). */
async function* parseSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<DashScopeSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitBlock = function* (block: string): Generator<DashScopeSseEvent> {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new TtsProviderError("sse_parse", `malformed SSE data payload: ${payload.slice(0, 120)}`);
      }
      yield parsed as DashScopeSseEvent;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let sepIndex = buffer.indexOf("\n\n");
      while (sepIndex !== -1) {
        const block = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        yield* emitBlock(block);
        sepIndex = buffer.indexOf("\n\n");
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) yield* emitBlock(tail);
  } finally {
    reader.releaseLock();
  }
}

/** Best-effort PCM duration from bytes: s16le mono = bytes / 2 samples. */
function estimatePcmDurationMs(totalBytes: number, sampleRate: number): number {
  if (totalBytes <= 0 || sampleRate <= 0) return 0;
  return Math.round((totalBytes / 2 / sampleRate) * 1000);
}

/**
 * Bounded async queue bridging the SSE driver (producer) and the consumer of
 * `chunks` (AsyncIterable). Applies backpressure so an unread provider never
 * buffers unboundedly.
 */
class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly items: T[] = [];
  private readonly takers: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private readonly spaceWaiters: Array<() => void> = [];
  private done = false;
  private error: unknown;

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    this.drain();
  }

  finish(): void {
    this.done = true;
    this.drain();
  }

  fail(error: unknown): void {
    this.error = error;
    this.done = true;
    this.drain();
  }

  /** Abort path: discard buffered items, end the stream, unblock producers. */
  close(): void {
    this.items.length = 0;
    this.done = true;
    this.drain();
  }

  /** Resolves once there is room for at least one more item (backpressure). */
  waitForSpace(): Promise<void> {
    if (this.items.length < this.capacity) return Promise.resolve();
    const result = deferred<void>();
    this.spaceWaiters.push(() => result.resolve());
    return result.promise;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift() as T, done: false });
    }
    if (this.done) {
      return this.error !== undefined
        ? Promise.reject(this.error)
        : Promise.resolve({ value: undefined, done: true });
    }
    const result = deferred<IteratorResult<T>>();
    this.takers.push({ resolve: result.resolve, reject: result.reject });
    return result.promise;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  private drain(): void {
    while (this.takers.length > 0 && (this.items.length > 0 || this.done)) {
      const taker = this.takers.shift();
      if (taker === undefined) break;
      if (this.items.length > 0) {
        taker.resolve({ value: this.items.shift() as T, done: false });
      } else if (this.error !== undefined) {
        taker.reject(this.error);
      } else {
        taker.resolve({ value: undefined, done: true });
      }
    }
    while (this.spaceWaiters.length > 0 && this.items.length < this.capacity) {
      const waiter = this.spaceWaiters.shift();
      if (waiter === undefined) break;
      waiter();
    }
  }
}

export class DashScopeCosyVoiceProvider implements TtsProviderPort {
  constructor(private readonly options: DashScopeCosyVoiceProviderOptions) {}

  async start(request: TtsSynthesisRequest, signal: AbortSignal): Promise<TtsStreamSession> {
    const apiKey = this.options.apiKey;
    const baseUrl = this.options.baseUrl ?? DASHSCOPE_DEFAULT_BASE_URL;
    const timeoutMs = this.options.timeoutMs ?? DASHSCOPE_DEFAULT_TIMEOUT_MS;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const decode = this.options.decode ?? ((base64Chunk: string) => Buffer.from(base64Chunk, "base64"));

    // External signal aborts the fetch controller. The `once` listener
    // self-removes when it fires; if the session settles first it simply stays
    // attached to the caller-owned signal and later aborts are no-ops.
    const controller = new AbortController();
    signal.addEventListener("abort", () => controller.abort(), { once: true });
    if (signal.aborted) controller.abort();

    // Official CosyVoice HTTP API: synthesis params live inside `input`
    // (not a separate `parameters` object), Beijing region. No SSML this
    // round — plain text only (see plan: SSML deferred with pronunciation
    // markers).
    const input: Record<string, unknown> = {
      text: request.text,
      voice: request.voiceId,
      format: "pcm",
      sample_rate: request.sampleRate,
      rate: request.rate,
      pitch: request.pitch,
      volume: request.volume,
      seed: request.seed,
    };
    if (request.instruction !== undefined) {
      input.instruction = request.instruction;
    }
    const body = {
      model: request.model,
      input,
    };
    // Correlation id: same key in provider-post / provider-first-chunk /
    // provider-done so one synthesis can be followed across events.
    const corr = request.text.slice(0, 16).replace(/\s+/g, "");
    ttsLog(
      "provider-post",
      corr,
      `url=${baseUrl} model=${request.model} voice=${request.voiceId} ` +
        `text=${request.text.length}chars instr=${request.instruction === undefined ? "none" : "yes"} ` +
        `rate=${request.rate} pitch=${request.pitch} volume=${request.volume} seed=${request.seed}`,
    );

    let response: Response;
    try {
      response = await fetchImpl(baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-DashScope-Data-Inspector": "enable",
          "X-DashScope-SSE": "enable",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // Abort propagates as-is (the caller triggered it); network failures
      // also propagate unchanged — typed mapping only covers HTTP/SSE/timeout.
      throw error;
    }

    if (!response.ok) {
      let detail = "";
      try {
        const text = await response.text();
        if (text.length > 0) detail = text.slice(0, 300);
      } catch {
        // best effort — the status code is the primary signal
      }
      ttsLog("provider-http", String(response.status), `detail=${detail}`);
      throw new TtsProviderError(
        `http_${response.status}`,
        `DashScope TTS request failed with HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`,
      );
    }
    if (response.body === null) {
      throw new TtsProviderError("sse_parse", "DashScope TTS response has no body");
    }

    // Session state shared by the background driver, the timeout, and abort.
    const queue = new AsyncQueue<Uint8Array>(32);
    let bytesSent = 0;
    let providerRequestId: string | undefined;
    let sawFirstChunk = false;
    let settled = false;
    let firstChunkTimer: NodeJS.Timeout | undefined;
    const completion = deferred<TtsCompletion>();
    const startedAt = Date.now();

    const onAbort = (): void => {
      controller.abort();
      queue.close();
      settleResolve({ totalBytes: bytesSent });
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const settleResolve = (value: TtsCompletion): void => {
      if (settled) return;
      settled = true;
      clearTimeout(firstChunkTimer);
      cleanup();
      completion.resolve(value);
    };
    const settleReject = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(firstChunkTimer);
      cleanup();
      completion.reject(reason);
    };

    // Abort is a normal end: abort the fetch, stop parsing, resolve with bytes so far.
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    // First-chunk deadline: abort the fetch and fail if nothing arrived in time.
    firstChunkTimer = setTimeout(() => {
      if (sawFirstChunk || settled) return;
      const error = new TtsProviderError(
        "first_chunk_timeout",
        `no first audio chunk from DashScope TTS within ${timeoutMs}ms`,
      );
      controller.abort();
      queue.fail(error);
      settleReject(error);
    }, timeoutMs);

    const run = async (): Promise<void> => {
      try {
        for await (const event of parseSseEvents(response.body as ReadableStream<Uint8Array>)) {
          if (signal.aborted) break;
          if (typeof event.request_id === "string" && event.request_id !== "") {
            providerRequestId = event.request_id;
          }
          const payload = extractAudioPayload(event);
          if (payload !== undefined) {
            if (!sawFirstChunk) {
              sawFirstChunk = true;
              clearTimeout(firstChunkTimer);
              ttsLog("provider-first-chunk", corr, `ttfb=${Date.now() - startedAt}ms`);
            }
            const bytes = decode(payload);
            await queue.waitForSpace();
            if (signal.aborted) break;
            bytesSent += bytes.byteLength;
            queue.push(bytes);
            continue;
          }
          if (isApiErrorEvent(event)) {
            throw new TtsProviderError(
              "sse_parse",
              `DashScope SSE error event: ${JSON.stringify(event).slice(0, 300)}`,
            );
          }
          if (event.output?.finish_reason === "stop") break;
        }
        if (!sawFirstChunk) {
          throw new TtsProviderError("sse_parse", "DashScope TTS stream ended without any audio chunks");
        }
        queue.finish();
        ttsLog(
          "provider-done",
          corr,
          `bytes=${bytesSent} elapsed=${Date.now() - startedAt}ms req=${providerRequestId ?? "none"}`,
        );
        const result: TtsCompletion = {
          totalBytes: bytesSent,
          durationMs: estimatePcmDurationMs(bytesSent, request.sampleRate),
        };
        if (providerRequestId !== undefined) result.providerRequestId = providerRequestId;
        settleResolve(result);
      } catch (error) {
        if (signal.aborted) {
          // Consumer aborted: abort is a normal end — resolve with partial bytes.
          queue.finish();
          const result: TtsCompletion = { totalBytes: bytesSent };
          if (providerRequestId !== undefined) result.providerRequestId = providerRequestId;
          settleResolve(result);
        } else {
          const mapped =
            error instanceof TtsProviderError
              ? error
              : new TtsProviderError(
                  "sse_parse",
                  `DashScope TTS stream error: ${error instanceof Error ? error.message : String(error)}`,
                );
          queue.fail(mapped);
          settleReject(mapped);
        }
      }
    };
    void run();

    const metadata: TtsStreamMetadata = {
      encoding: "pcm_s16le",
      sampleRate: request.sampleRate,
      channels: 1,
      bitDepth: 16,
    };

    return {
      metadata,
      chunks: queue,
      completion: completion.promise,
    };
  }
}
