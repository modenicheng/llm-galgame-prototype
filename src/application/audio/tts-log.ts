/**
 * tts-log — lightweight structured logging for the TTS/voice pipeline.
 *
 * Every line is `[tts] <event> <context> <k=v ...>` so a session can be
 * followed end to end with one grep: descriptor build → task queue →
 * provider POST → SSE stream → HTTP relay. `context` is a lineId (or
 * short task/cache key); `detail` is whitespace-separated key=value pairs.
 *
 * Silenced under Vitest so test output stays pristine — this is
 * observability, not behavior.
 */
const ENABLED =
  typeof process === "undefined" || process.env.VITEST !== "true";

export function ttsLog(event: string, context: string, detail?: string): void {
  if (!ENABLED) return;
  const line = detail !== undefined ? `${event} ${context} ${detail}` : `${event} ${context}`;
  console.log(`[tts] ${line}`);
}
