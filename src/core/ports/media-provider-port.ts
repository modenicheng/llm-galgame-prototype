/**
 * Media provider abstraction.
 *
 * The runtime schedules *when* media is needed; the provider performs the
 * actual synthesis (mock audio, real TTS, future visuals).
 */
import type { RuntimePlayableEvent } from "../../schema.js";

export interface MediaAsset {
  lineId: string;
  path: string;
}

export interface MediaProviderPort {
  synthesize(lines: RuntimePlayableEvent[], signal: AbortSignal): Promise<MediaAsset[]>;
}
