/**
 * DashScopeCosyVoiceProvider — streaming synthesis over DashScope HTTP SSE,
 * supporting both model families configured in voices.yaml:
 *
 *  - `cosyvoice*` / `qwen-audio*` (SpeechSynthesizer endpoint):
 *      POST https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
 *      body: { model, input: { text, voice, format: "pcm", sample_rate,
 *              rate, pitch, volume, seed, instruction? } }
 *      events: `data: { output: { audio: { data: <base64 pcm> }, finish_reason } }`
 *      The base64 field is read from `output.audio.audio_data` first (legacy
 *      design-contract name) and falls back to `output.audio.data` (current
 *      official docs). `finish_reason: "stop"` ends the stream.
 *
 *  - `qwen3-tts*` (multimodal-generation endpoint; verified live 2026-09):
 *      POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 *      body: { model, input: { text, voice, instructions? } }
 *      rate/pitch/volume/seed/format/sample_rate are NOT supported by this
 *      family and are dropped; `instruction` maps to `instructions` and is
 *      only legal on `qwen3-tts-instruct*` models.
 *      events: same SSE shape, but `output.audio.data` chunks concatenate
 *      into a RIFF/WAVE file whose payload is 24 kHz s16le mono PCM — the
 *      container header is stripped before PCM is forwarded downstream.
 *
 * Implements `TtsProviderPort`. PCM chunks are streamed as they arrive; no
 * file is written and no audio URL is downloaded. Node-only module.
 *
 * Session semantics:
 *  - `completion` RESOLVES with `{ totalBytes, durationMs, providerRequestId }`
 *    on normal end, and with `{ totalBytes }` on abort (bytes so far; the
 *    consumer distinguishes abort via the AbortSignal).
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
import {
  QWEN3_TTS_SAMPLE_RATE,
  isQwen3TtsInstructModel,
  ttsModelFamilyOf,
} from "../../core/ports/tts-model-family.js";
import { ttsLog } from "../../application/audio/tts-log.js";

export const DASHSCOPE_DEFAULT_BASE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
export const DASHSCOPE_QWEN3_TTS_DEFAULT_BASE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
export const DASHSCOPE_DEFAULT_TIMEOUT_MS = 120_000;

export interface DashScopeCosyVoiceProviderOptions {
  apiKey: string;
  /** CosyVoice/qwen-audio SpeechSynthesizer endpoint. */
  baseUrl?: string;
  /** qwen3-tts multimodal-generation endpoint. */
  qwen3BaseUrl?: string;
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

/** Extract a non-empty base64 audio payload from an SSE event, if any. */
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
 * Strips the RIFF/WAVE container header from a qwen3-tts audio stream.
 *
 * qwen3-tts SSE `output.audio.data` chunks concatenate into one audio file.
 * Verified live (2026-09): `qwen3-tts-flash` sends a RIFF/WAVE container
 * (24 kHz s16le mono payload; RIFF/data size fields are streaming
 * placeholders), while `qwen3-tts-instruct-flash` sends headerless raw PCM
 * with the same encoding. So the header is consumed when present; a stream
 * that never looks like RIFF/WAVE passes through as raw PCM (the family's
 * fixed rate). Buffers until the header is complete or the raw-PCM verdict
 * is reachable (≥4 bytes).
 */
class WavHeaderStripper {
  private pending: Buffer = Buffer.alloc(0);
  private resolved = false;
  private pcmStart = -1;
  private rawPassthrough = false;
  sampleRate = QWEN3_TTS_SAMPLE_RATE;
  channels = 1;

  /** Feed one decoded chunk; returns the PCM bytes to forward (may be empty). */
  write(chunk: Buffer): Buffer {
    if (this.resolved) return chunk;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.pending = this.pending.length === 0 ? buf : Buffer.concat([this.pending, buf]);
    const start = this.locateDataChunk();
    if (start < 0) return Buffer.alloc(0);
    this.resolved = true;
    return this.pending.subarray(start);
  }

  /**
   * Walk RIFF chunks until the `data` payload offset is known; -1 while the
   * header is still incomplete. A stream that is definitely not RIFF/WAVE
   * switches to raw-PCM passthrough (some qwen3 models emit headerless PCM);
   * a non-PCM fmt chunk is still a typed failure, since forwarding container
   * or compressed bytes as raw PCM would be noise.
   */
  private locateDataChunk(): number {
    const b = this.pending;
    if (b.length >= 4 && b.toString("ascii", 0, 4) !== "RIFF") {
      this.rawPassthrough = true;
      this.resolved = true;
      return 0;
    }
    let pos = 12; // "RIFF" + size + "WAVE"
    for (;;) {
      if (pos + 8 > b.length) return -1;
      const id = b.toString("ascii", pos, pos + 4);
      const size = b.readUInt32LE(pos + 4);
      if (id === "fmt ") {
        if (pos + 8 + 16 > b.length) return -1;
        const audioFormat = b.readUInt16LE(pos + 8);
        if (audioFormat !== 1) {
          throw new TtsProviderError(
            "sse_parse",
            `qwen3-tts WAV fmt chunk is not PCM (audio_format=${audioFormat})`,
          );
        }
        this.channels = b.readUInt16LE(pos + 10);
        this.sampleRate = b.readUInt32LE(pos + 12);
        // The downstream pipeline is pinned to 24 kHz s16le mono; a
        // different container layout would play as pitch-shifted noise
        // with no error anywhere — fail typed instead.
        if (this.sampleRate !== QWEN3_TTS_SAMPLE_RATE || this.channels !== 1) {
          throw new TtsProviderError(
            "sse_parse",
            `qwen3-tts WAV layout changed: ${this.sampleRate}Hz/${this.channels}ch (expected ${QWEN3_TTS_SAMPLE_RATE}Hz/1ch)`,
          );
        }
        pos += 8 + size + (size % 2);
        continue;
      }
      if (id === "data") {
        this.pcmStart = pos + 8;
        return this.pcmStart;
      }
      // Skip any other chunk (LIST/JUNK/...). A bogus huge size on a
      // non-data chunk means the header is malformed, not merely partial.
      if (size > 1 << 20) {
        throw new TtsProviderError(
          "sse_parse",
          `qwen3-tts WAV header malformed at chunk "${id}" (size=${size})`,
        );
      }
      pos += 8 + size + (size % 2);
    }
  }

  get headerConsumed(): boolean {
    return this.resolved;
  }

  /** Header bytes consumed (0 when the stream was headerless raw PCM). */
  get byteOffset(): number {
    return this.rawPassthrough ? 0 : this.pcmStart;
  }
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
    const family = ttsModelFamilyOf(request.model);
    const isQwen3 = family === "qwen3-tts";
    const baseUrl = isQwen3
      ? this.options.qwen3BaseUrl ?? DASHSCOPE_QWEN3_TTS_DEFAULT_BASE_URL
      : this.options.baseUrl ?? DASHSCOPE_DEFAULT_BASE_URL;
    const timeoutMs = this.options.timeoutMs ?? DASHSCOPE_DEFAULT_TIMEOUT_MS;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const decode = this.options.decode ?? ((base64Chunk: string) => Buffer.from(base64Chunk, "base64"));

    // External signal aborts the fetch controller. The `once` listener
    // self-removes when it fires; if the session settles first it simply stays
    // attached to the caller-owned signal and later aborts are no-ops.
    const controller = new AbortController();
    signal.addEventListener("abort", () => controller.abort(), { once: true });
    if (signal.aborted) controller.abort();

    // Request body per family:
    //  - cosyvoice: SpeechSynthesizer contract — synthesis params inside
    //    `input` (not a separate `parameters` object), Beijing region.
    //  - qwen3-tts: multimodal-generation contract — text/voice only;
    //    rate/pitch/volume/seed/format are unsupported and must not be sent.
    //    `instruction` maps to `instructions`, legal only on instruct models.
    let body: Record<string, unknown>;
    if (isQwen3) {
      const input: Record<string, unknown> = {
        text: request.text,
        voice: request.voiceId,
      };
      if (request.instruction !== undefined && isQwen3TtsInstructModel(request.model)) {
        input.instructions = request.instruction;
      }
      body = { model: request.model, input };
    } else {
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
      body = { model: request.model, input };
    }
    // Correlation id: same key in provider-post / provider-first-chunk /
    // provider-done so one synthesis can be followed across events.
    const corr = request.text.slice(0, 16).replace(/\s+/g, "");
    ttsLog(
      "provider-post",
      corr,
      `url=${baseUrl} model=${request.model} family=${family} voice=${request.voiceId} ` +
        `text=${request.text.length}chars instr=${request.instruction === undefined ? "none" : isQwen3 && !isQwen3TtsInstructModel(request.model) ? "dropped(non-instruct)" : "yes"} ` +
        (isQwen3
          ? `rate/pitch/volume/seed=unsupported(dropped)`
          : `rate=${request.rate} pitch=${request.pitch} volume=${request.volume} seed=${request.seed}`),
    );

    let response: Response;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "enable",
      };
      if (!isQwen3) {
        // Inspection header per the SpeechSynthesizer design contract only —
        // the multimodal-generation docs do not carry it.
        headers["X-DashScope-Data-Inspector"] = "enable";
      }
      response = await fetchImpl(baseUrl, {
        method: "POST",
        headers,
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
    const stripper = isQwen3 ? new WavHeaderStripper() : null;
    let bytesSent = 0;
    let providerRequestId: string | undefined;
    let sawFirstChunk = false;
    let settled = false;
    let firstChunkTimer: NodeJS.Timeout | undefined;
    const completion = deferred<TtsCompletion>();
    const startedAt = Date.now();
    // Duration math must use the family's real sample rate, not the
    // descriptor value: qwen3 emits 24 kHz regardless of request.sampleRate.
    const effectiveSampleRate = isQwen3 ? QWEN3_TTS_SAMPLE_RATE : request.sampleRate;

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
            let bytes = decode(payload) as Buffer;
            if (stripper !== null) {
              bytes = stripper.write(bytes);
              if (bytes.byteLength === 0) continue;
            }
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
        if (stripper !== null && !stripper.headerConsumed) {
          throw new TtsProviderError(
            "sse_parse",
            "qwen3-tts stream ended before the WAV header was complete",
          );
        }
        queue.finish();
        ttsLog(
          "provider-done",
          corr,
          `bytes=${bytesSent} elapsed=${Date.now() - startedAt}ms req=${providerRequestId ?? "none"}` +
            (stripper !== null
              ? ` wavHeader=${stripper.byteOffset}B rate=${stripper.sampleRate}`
              : ""),
        );
        const result: TtsCompletion = {
          totalBytes: bytesSent,
          durationMs: estimatePcmDurationMs(bytesSent, effectiveSampleRate),
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
      // Metadata is consumed before any chunk arrives, so the qwen3 rate is
      // the family constant (verified live); the parsed header value only
      // feeds the provider-done log.
      sampleRate: effectiveSampleRate,
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
