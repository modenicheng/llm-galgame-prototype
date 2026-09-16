/**
 * Identifier generation abstraction.
 *
 * The runtime never derives IDs from wall-clock time or global counters
 * directly; it asks the injected generator instead. Hosts can back this
 * with time-based session IDs (Node CLI) or fully deterministic counters
 * (tests, browsers).
 */
export interface IdGeneratorPort {
  /** Stable identifier for a new session. */
  nextSessionId(): string;
  /** Unique, monotonically increasing line ID inside one session. */
  nextLineId(sessionId: string): string;
  /**
   * Optional resume support: push the line counter past every line id
   * already committed for this session so restored and freshly generated
   * ids never collide. Implementations may omit it (fresh sessions,
   * deterministic test fakes).
   */
  seedLineCounter?(sessionId: string, events: readonly object[]): void;
  /** Unique identifier for a background generation task. */
  nextGenerationId(kind: string): string;
  /** Unique identifier for an input preview session. */
  nextPreviewId(interactionId: string): string;
}
