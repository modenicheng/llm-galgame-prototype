/**
 * Stream line decoder — turns raw network chunks into complete lines
 * (docs/llm-outputs-refactor.md §41).
 *
 * Splits on "\n" and "\r\n" (a trailing "\r" on a line is stripped).
 * Empty lines are dropped. A truncated tail without a newline stays
 * buffered until `flush()`.
 *
 * Pure text processing: no runtime, wire, or LLM dependencies.
 */
export class StreamLineDecoder {
  private buffer = "";

  /**
   * Feed one network chunk. Returns the complete lines that became
   * available with this chunk (may be empty).
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      // A "\r\n" ending leaves a trailing "\r" on the line — strip it.
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }

  /**
   * Returns whatever is left without a newline (a truncated tail) and
   * clears it; returns null when nothing is pending.
   */
  flush(): string | null {
    if (this.buffer.length === 0) return null;
    const tail = this.buffer;
    this.buffer = "";
    return tail;
  }

  /** Whether an unterminated partial line is buffered. */
  hasPending(): boolean {
    return this.buffer.length > 0;
  }
}
