/**
 * LocalQwen3TtsProvider — streaming synthesis against a local inference
 * server, implements `TtsProviderPort`.
 *
 * Default dialect "openai" targets qwentts.cpp's tts-server (C++/GGML,
 * D:\tmp\qwentts.cpp): POST /v1/audio/speech → chunked s16le 24 kHz mono
 * PCM streamed frame-by-frame; client abort destroys the fetch body which
 * the server treats as a cancel. Dialect "tts-server" targets the Python
 * fallback engine (tts-server/server.py, POST /tts + X-Audio-* headers).
 *
 * Neither engine takes rate/pitch/volume/seed or per-request instructions
 * on the clone path — mirrors the DashScope qwen3-tts-vc semantics.
 *
 * Session semantics (same contract as the DashScope provider):
 *  - `completion` resolves with `{ totalBytes, durationMs }` on normal end
 *    and with `{ totalBytes }` on abort.
 *  - `completion` rejects with `TtsProviderError` (`http_<status>`,
 *    `first_chunk_timeout`, `connection`) on provider failure.
 */
import type {
  TtsCompletion,
  TtsProviderPort,
  TtsStreamMetadata,
  TtsSynthesisRequest,
  TtsStreamSession,
} from "../../core/ports/tts-provider-port.js";
import { ttsLog } from "../../application/audio/tts-log.js";

export const LOCAL_TTS_DEFAULT_BASE_URL = "http://127.0.0.1:9766";
export const LOCAL_TTS_DEFAULT_TIMEOUT_MS = 120_000;

export class TtsProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TtsProviderError";
    this.code = code;
  }
}

export interface LocalQwen3TtsProviderOptions {
  baseUrl?: string;
  /**
   * Wire dialect of the local server:
   *  - "openai" (default): qwentts.cpp tts-server — POST /v1/audio/speech
   *    {model, input, voice, response_format:"pcm"}, chunked s16le 24 kHz.
   *  - "tts-server": the Python tts-server/server.py — POST /tts
   *    {text, voice} with X-Audio-* metadata headers.
   */
  dialect?: "openai" | "tts-server";
  /** First-chunk deadline in ms. Default 120000. */
  timeoutMs?: number;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class LocalQwen3TtsProvider implements TtsProviderPort {
  private readonly baseUrl: string;
  private readonly dialect: "openai" | "tts-server";
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LocalQwen3TtsProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? LOCAL_TTS_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.dialect = options.dialect ?? "openai";
    this.timeoutMs = options.timeoutMs ?? LOCAL_TTS_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async start(
    request: TtsSynthesisRequest,
    signal: AbortSignal,
  ): Promise<TtsStreamSession> {
    const controller = new AbortController();
    const onUpstreamAbort = () => controller.abort();
    if (signal.aborted) {
      throw new TtsProviderError("canceled", "canceled before start");
    }
    signal.addEventListener("abort", onUpstreamAbort, { once: true });

    const [url, body] =
      this.dialect === "openai"
        ? [
            `${this.baseUrl}/v1/audio/speech`,
            JSON.stringify({
              model: request.model,
              input: request.text,
              voice: request.voiceId,
              response_format: "pcm",
            }),
          ]
        : [
            `${this.baseUrl}/tts`,
            JSON.stringify({ text: request.text, voice: request.voiceId }),
          ];

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      signal.removeEventListener("abort", onUpstreamAbort);
      if (signal.aborted) {
        throw new TtsProviderError("canceled", "canceled during connect");
      }
      throw new TtsProviderError(
        "connection",
        `local tts unreachable at ${this.baseUrl}: ${(error as Error).message}`,
      );
    }

    if (!response.ok || response.body === null) {
      signal.removeEventListener("abort", onUpstreamAbort);
      // Consume the error body so the socket is released.
      await response.text().catch(() => "");
      throw new TtsProviderError(
        `http_${response.status}`,
        `local tts error ${response.status}`,
      );
    }

    const requestId = response.headers.get("x-audio-task-id");
    const metadata: TtsStreamMetadata = {
      ...(requestId ? { providerRequestId: requestId } : {}),
      encoding: "pcm_s16le",
      sampleRate: Number(response.headers.get("x-audio-sample-rate")) || request.sampleRate,
      channels: 1,
      bitDepth: 16,
    };

    let totalBytes = 0;
    let firstChunkSeen = false;
    let settled = false;
    const { promise: completion, resolve, reject } = Promise.withResolvers<TtsCompletion>();
    const startedAt = Date.now();

    const finish = (result: TtsCompletion | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(firstChunkTimer);
      signal.removeEventListener("abort", onUpstreamAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    // The server streams sentence-granularity PCM; the deadline applies to
    // the first chunk only (later sentences may queue behind other waves).
    const firstChunkTimer = setTimeout(() => {
      controller.abort();
      finish(new TtsProviderError("first_chunk_timeout", `no PCM within ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    const reader = response.body.getReader();
    const onAbort = () => {
      // Upstream canceled: tear down the connection AND the body reader
      // (defensive: injected fetches may ignore the abort signal); the
      // consumer keeps whatever chunks were already yielded.
      controller.abort();
      reader.cancel().catch(() => {});
      finish({ totalBytes });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const chunks: AsyncGenerator<Uint8Array> = (async function* () {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            clearTimeout(firstChunkTimer);
          }
          totalBytes += value.byteLength;
          yield new Uint8Array(value);
        }
        finish({ totalBytes, durationMs: Date.now() - startedAt });
      } catch (error) {
        if (signal.aborted || settled) {
          finish({ totalBytes });
        } else {
          finish(new TtsProviderError("connection", `local tts stream broke: ${(error as Error).message}`));
        }
      } finally {
        reader.releaseLock();
      }
    })();

    const stream: TtsStreamSession = {
      metadata,
      chunks,
      completion,
    };
    ttsLog("local-start", request.voiceId, `${request.text.length} chars`);
    return stream;
  }
}
