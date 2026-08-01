import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";

/**
 * Terminal formatting for structured runtime diagnostics.
 *
 * Player-facing messages ("player" scope) print plainly; background noise
 * (prefetch, repair) is dimmed; warnings go to stderr.
 */
export class ConsoleDiagnosticSink implements DiagnosticSink {
  info(scope: string, message: string): void {
    if (scope === "player") {
      console.log(`\n${message}`);
    } else {
      console.log(`\x1b[2m[${scope}] ${message}\x1b[0m`);
    }
  }

  warn(scope: string, message: string): void {
    console.warn(`[${scope}] ${message}`);
  }
}
