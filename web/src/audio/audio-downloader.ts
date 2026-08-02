/**
 * AudioDownloader — the browser's TTS fetch pipeline (V2 §8.2).
 *
 * POSTs the minimal `{taskId, lineId, cacheKey}` to `/api/audio/synthesize`
 * with the session token (§22 invariant 9/3), streams the PCM response body,
 * decodes it to Int16Array samples (handed to `onPcm` for playback) and
 * hands the raw bytes to the cache writer fire-and-forget (§22 invariant 13 —
 * playback never waits for IndexedDB).
 *
 * Dedup (§12.4): at most one in-flight fetch per cacheKey, shared across
 * instances through a static map; a concurrent `download()` for the same key
 * returns the same promise.
 */
import type { AudioDescriptor } from "@shared/wire/audio-descriptor.js";
import type { AudioCacheWriter } from "../storage/audio-cache-writer.js";
import { PcmDecoder } from "./pcm-decoder.js";

export interface AudioDownloaderOptions {
  /** Local Session Token (§8.3), sent as the `X-Session-Token` header. */
  token: string;
  writer: AudioCacheWriter;
  /**
   * A shared decoder instance, or a factory for a fresh per-download
   * decoder. Concurrent streams must never share one PcmDecoder — its
   * pending odd byte belongs to a single stream (§10.2).
   */
  decoder: PcmDecoder | (() => PcmDecoder);
  /** Called with every decoded batch of samples (playback feed). */
  onPcm: (lineId: string, samples: Int16Array) => void;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

const SYNTHESIZE_PATH = "/api/audio/synthesize";

export class AudioDownloader {
  /** One in-flight download per cacheKey, shared across instances (§12.4). */
  private static readonly inFlight = new Map<string, Promise<void>>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AudioDownloaderOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** True while a download for `cacheKey` is in flight (any instance). */
  static hasInFlight(cacheKey: string): boolean {
    return AudioDownloader.inFlight.has(cacheKey);
  }

  /**
   * Stream, decode and cache one descriptor. Resolves when the HTTP body
   * has been fully consumed; whether the cache asset becomes `complete` is
   * decided by the `audio.task_status` finished message (§8.2).
   */
  download(descriptor: AudioDescriptor, signal: AbortSignal): Promise<void> {
    const { lineId, cacheKey } = descriptor;
    const existing = AudioDownloader.inFlight.get(cacheKey);
    if (existing !== undefined) {
      return existing; // dedup — one in-flight fetch per cacheKey
    }
    const decoder =
      typeof this.options.decoder === "function"
        ? this.options.decoder()
        : this.options.decoder;
    const taskId = crypto.randomUUID();
    const promise = this.run(lineId, cacheKey, taskId, descriptor, decoder, signal);
    AudioDownloader.inFlight.set(cacheKey, promise);
    // Release the dedup slot on either outcome without creating an unhandled
    // rejection (a bare `promise.finally(...)` would).
    promise.then(
      () => {
        AudioDownloader.inFlight.delete(cacheKey);
      },
      () => {
        AudioDownloader.inFlight.delete(cacheKey);
      },
    );
    return promise;
  }

  private async run(
    lineId: string,
    cacheKey: string,
    taskId: string,
    descriptor: AudioDescriptor,
    decoder: PcmDecoder,
    signal: AbortSignal,
  ): Promise<void> {
    // The writer session must exist before the first append — append()
    // silently drops chunks while no session is registered for the key.
    await this.options.writer.startAsset(cacheKey, lineId, {
      encoding: descriptor.format.encoding,
      sampleRate: descriptor.format.sampleRate,
      channels: descriptor.format.channels,
      bitDepth: 16,
      scopeAtCreation: descriptor.scope.type,
    });

    const response = await this.fetchImpl(SYNTHESIZE_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Token": this.options.token,
      },
      body: JSON.stringify({ taskId, lineId, cacheKey }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`TTS synthesis failed: HTTP ${response.status}`);
    }
    const body = response.body;
    if (body === null) {
      throw new Error("TTS synthesis returned an empty body");
    }
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && value.byteLength > 0) {
        // Raw bytes to the cache (fire-and-forget), decoded samples to playback.
        this.options.writer.append(cacheKey, value);
        const samples = decoder.push(value);
        if (samples.length > 0) {
          this.options.onPcm(lineId, samples);
        }
      }
    }
    const tail = decoder.flush();
    if (tail.length > 0) {
      this.options.onPcm(lineId, tail);
    }
  }
}
