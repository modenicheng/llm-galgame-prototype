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
  /**
   * Called once per consumer line when the stream is fully consumed —
   * success, HTTP error, read error or abort. No more PCM will arrive for
   * that line; the coordinator uses it to arm playback below the startup
   * threshold and to finish the line once the worklet drains (EOF/drain
   * lifecycle, §10.6).
   */
  onEof: (lineId: string) => void;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

const SYNTHESIZE_PATH = "/api/audio/synthesize";

/** Shared state for one in-flight cacheKey (§12.4 dedup). */
interface InFlightSlot {
  promise: Promise<void>;
  /** The one fetch controller; aborted when ANY consumer signal fires. */
  controller: AbortController;
  /** Every consumer lineId — each receives the decoded PCM via onPcm. */
  lineIds: Set<string>;
}

export class AudioDownloader {
  /** One in-flight download per cacheKey, shared across instances (§12.4). */
  private static readonly inFlight = new Map<string, InFlightSlot>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AudioDownloaderOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** True while a download for `cacheKey` is in flight (any instance). */
  static hasInFlight(cacheKey: string): boolean {
    return AudioDownloader.inFlight.has(cacheKey);
  }

  /**
   * Stream, decode and cache one descriptor. Resolves when the HTTP body
   * has been fully consumed; whether the cache asset becomes `complete` is
   * decided by the `audio.task_status` finished message (§8.2).
   *
   * Deduped callers share the in-flight fetch AND the decoded PCM: every
   * registered line receives the stream via `onPcm` (each consumer line is
   * a separate timeline segment that needs the same audio). All consumers'
   * AbortSignals are fanned into one fetch controller, so invalidating any
   * consumer stops the shared stream (§12.5). `taskId` (optional, generated
   * when absent) is the id POSTed to the synthesizer and returned to the
   * caller's bookkeeping so POST and status tracking share one id.
   */
  download(descriptor: AudioDescriptor, signal: AbortSignal, taskId?: string): Promise<void> {
    const { lineId, cacheKey } = descriptor;
    let slot: InFlightSlot | undefined = AudioDownloader.inFlight.get(cacheKey);
    if (slot === undefined) {
      const decoder =
        typeof this.options.decoder === "function"
          ? this.options.decoder()
          : this.options.decoder;
      const controller = new AbortController();
      slot = {
        promise: Promise.resolve(),
        controller,
        lineIds: new Set([lineId]),
      };
      // run() must fan out to the SAME Set object the slot owns: a
      // consumer joining mid-stream is added to slot.lineIds and must
      // receive the remaining PCM (and EOF) of this shared download.
      slot.promise = this.run(
        slot.lineIds,
        cacheKey,
        taskId ?? crypto.randomUUID(),
        descriptor,
        decoder,
        controller.signal,
      );
      AudioDownloader.inFlight.set(cacheKey, slot);
      // Release the dedup slot on either outcome without creating an
      // unhandled rejection (a bare `promise.finally(...)` would).
      slot.promise.then(
        () => {
          AudioDownloader.inFlight.delete(cacheKey);
        },
        () => {
          AudioDownloader.inFlight.delete(cacheKey);
        },
      );
    } else {
      slot.lineIds.add(lineId);
    }
    this.wireSignal(signal, slot);
    return slot.promise;
  }

  /** Abort the shared fetch when ANY consumer's signal fires. */
  private wireSignal(signal: AbortSignal, slot: InFlightSlot): void {
    if (signal.aborted) {
      slot.controller.abort();
      return; // already fired — nothing to detach later
    }
    const onAbort = (): void => {
      slot.controller.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // Detach on completion so a stale signal cannot abort a later fetch that
    // happens to reuse the same AbortController/signal pair.
    slot.promise.then(
      () => signal.removeEventListener("abort", onAbort),
      () => signal.removeEventListener("abort", onAbort),
    );
  }

  private async run(
    lineIds: Set<string>,
    cacheKey: string,
    taskId: string,
    descriptor: AudioDescriptor,
    decoder: PcmDecoder,
    signal: AbortSignal,
  ): Promise<void> {
    const lineId = descriptor.lineId;
    try {
      // The writer session must exist before the first append — append()
      // silently drops chunks while no session is registered for the key.
      await this.options.writer.startAsset(cacheKey, lineId, {
        encoding: descriptor.format.encoding,
        sampleRate: descriptor.format.sampleRate,
        channels: descriptor.format.channels,
        bitDepth: 16,
        scopeAtCreation: descriptor.scope.type,
      });
    console.log(`[tts-web] fetch ${lineId} task=${taskId.slice(0, 8)} cache=${cacheKey.slice(0, 8)}`);
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
      console.log(`[tts-web] http-fail ${lineId} status=${response.status}`);
      throw new Error(`TTS synthesis failed: HTTP ${response.status}`);
    }
    const body = response.body;
    if (body === null) {
      throw new Error("TTS synthesis returned an empty body");
    }
    const reader = body.getReader();
    const feed = (samples: Int16Array): void => {
      if (samples.length === 0) return;
      for (const consumer of lineIds) {
        this.options.onPcm(consumer, samples);
      }
    };
    let bytes = 0;
    console.log(`[tts-web] stream-start ${lineId}`);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && value.byteLength > 0) {
        bytes += value.byteLength;
        // Raw bytes to the cache (fire-and-forget), decoded samples to playback.
        this.options.writer.append(cacheKey, value);
        feed(decoder.push(value));
      }
    }
    feed(decoder.flush());
    console.log(`[tts-web] stream-done ${lineId} bytes=${bytes}`);
    } finally {
      // EOF for every consumer regardless of outcome: the stream will never
      // produce more PCM, so each consumer line can arm/advance its own
      // playback lifecycle (a partial line still finishes via EOF + drain).
      for (const consumer of lineIds) {
        this.options.onEof(consumer);
      }
    }
  }
}
