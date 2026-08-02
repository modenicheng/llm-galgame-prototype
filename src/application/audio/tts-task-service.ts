/**
 * TtsTaskService — Node-side synthesis task orchestration (§7.5).
 *
 * Validates `lineId + cacheKey`, enforces concurrency and priority
 * limits, delegates to the TtsProviderPort, exposes PCM chunks as an
 * AsyncIterable, records per-task metrics, and cancels the upstream task
 * when the browser aborts the HTTP request.
 */
import type { AudioFetchRequest } from "../../shared/wire/client-message.js";
import type { TtsStreamSession } from "../../core/ports/tts-provider-port.js";

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
