/**
 * Diagnostic output abstraction.
 *
 * Core runtime code publishes structured (scope, message) pairs instead of
 * printing to the console directly. The host decides how to format them —
 * the Node CLI dims background noise, a web app routes them to a log
 * buffer, tests record them.
 */
export interface DiagnosticSink {
  /** Informational message. `scope` is a short category such as "Prefetch". */
  info(scope: string, message: string): void;
  /** Warning message that should be more prominent than `info`. */
  warn(scope: string, message: string): void;
}

/** Sink that discards everything. Safe default for non-interactive hosts. */
export const silentDiagnosticSink: DiagnosticSink = {
  info: () => undefined,
  warn: () => undefined,
};
