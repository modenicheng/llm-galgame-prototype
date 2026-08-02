/**
 * InternalAudioRecipe — the authoritative synthesis recipe Node keeps
 * server-side for each line. The browser never sees these fields; it only
 * sees the derived `cacheKey`.
 */
export interface InternalAudioRecipe {
  lineId: string;
  cacheKey: string;
  text: string;
  model: string;
  voiceId: string;
  voiceRevision: number;
  instruction?: string;
  rate: number;
  pitch: number;
  /** Compiled lead-in silence (ms) before the line starts speaking. */
  pauseBeforeMs: number;
  /** Compiled trailing silence (ms) after the line finishes. */
  pauseAfterMs: number;
  volume: number;
  seed: number;
}
