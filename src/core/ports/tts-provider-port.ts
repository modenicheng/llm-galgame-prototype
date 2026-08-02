/**
 * TtsProviderPort — the streaming synthesis boundary.
 *
 * V2 providers stream PCM chunks as an AsyncIterable instead of returning
 * completed file assets.
 *
 * Implementations: DashScope CosyVoice adapter (real) and the streaming
 * mock (tests / offline demo).
 */

/** Provider-facing synthesis parameters, compiled by the Node app layer. */
export interface TtsSynthesisRequest {
  text: string;
  model: string;
  voiceId: string;
  instruction?: string;
  rate: number;
  pitch: number;
  volume: number;
  seed: number;
  format: "pcm_s16le";
  sampleRate: number;
}

/** Stream metadata, available as soon as the session starts. */
export interface TtsStreamMetadata {
  providerRequestId?: string;
  encoding: "pcm_s16le";
  sampleRate: number;
  channels: 1;
  bitDepth: 16;
}

/** Final outcome of a completed/aborted synthesis stream. */
export interface TtsCompletion {
  totalBytes?: number;
  durationMs?: number;
  providerRequestId?: string;
}

/**
 * A live synthesis session. `chunks` yields PCM bytes as they arrive;
 * `completion` resolves when the upstream task finishes (success, failure,
 * or abort). The consumer may stop iterating `chunks` at any time and
 * abort the upstream task via the AbortSignal passed to `start()`.
 */
export interface TtsStreamSession {
  metadata: TtsStreamMetadata;
  chunks: AsyncIterable<Uint8Array>;
  completion: Promise<TtsCompletion>;
}

export interface TtsProviderPort {
  start(
    request: TtsSynthesisRequest,
    signal: AbortSignal,
  ): Promise<TtsStreamSession>;
}
