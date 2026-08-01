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

  nextGenerationId(kind: string): string {
    this.generationCounter += 1;
    return `${kind}:${this.generationCounter}`;
  }

  nextPreviewId(interactionId: string): string {
    this.previewCounter += 1;
    return `preview_${interactionId}_${this.previewCounter}`;
  }
}
