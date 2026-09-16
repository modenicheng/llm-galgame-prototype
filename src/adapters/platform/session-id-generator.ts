import type { IdGeneratorPort } from "../../core/ports/id-generator-port.js";

/**
 * Time-based ID generator for Node hosts.
 *
 * Session IDs derive from the wall clock (safe filename characters);
 * line/generation/preview IDs use per-instance monotonic counters so a
 * single runtime instance never repeats an ID.
 */
export class SessionIdGenerator implements IdGeneratorPort {
  private lineCounter = 0;
  private generationCounter = 0;
  private previewCounter = 0;

  nextSessionId(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  nextLineId(sessionId: string): string {
    this.lineCounter += 1;
    return `line_${sessionId}_${this.lineCounter.toString().padStart(6, "0")}`;
  }

  /**
   * Resume support: push the line counter past every line id already
   * committed in this session, so freshly generated lines never collide
   * with restored ones. Counts only ids of THIS session (the prefix match);
   * the counter is monotonic — never lowered.
   */
  seedLineCounter(sessionId: string, events: readonly object[]): void {
    const prefix = `line_${sessionId}_`;
    for (const event of events) {
      const id = (event as { line_id?: unknown }).line_id;
      if (typeof id !== "string" || !id.startsWith(prefix)) continue;
      const n = Number.parseInt(id.slice(prefix.length), 10);
      if (Number.isInteger(n) && n > this.lineCounter) this.lineCounter = n;
    }
  }

  nextGenerationId(kind: string): string {
    this.generationCounter += 1;
    return `${kind}:${this.generationCounter}`;
  }

  nextPreviewId(interactionId: string): string {
    this.previewCounter += 1;
    return `preview_${interactionId}_${this.previewCounter}`;
  }
}
