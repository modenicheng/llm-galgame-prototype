/**
 * TtsProviderError — typed failure shared by every TTS provider adapter.
 *
 * `code` is a stable machine-readable token (`http_<status>`,
 * `first_chunk_timeout`, `connection`, `sse_parse`, `canceled`); consumers
 * duck-type on `code` (e.g. the 429 backoff in TtsTaskService) rather than
 * instanceof. Defined once here so providers and their tests import the
 * same class instead of growing per-module duplicates.
 */
export class TtsProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TtsProviderError";
    this.code = code;
  }
}
