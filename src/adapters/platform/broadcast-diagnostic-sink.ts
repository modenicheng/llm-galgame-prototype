/**
 * BroadcastDiagnosticSink — fans every diagnostic out to an inner sink plus
 * a side-channel callback (the MonitorHub's diagnostics ring).
 *
 * The monitor dashboard needs the DiagnosticSink traffic as data; wrapping
 * (instead of replacing) keeps the console output byte-identical.
 */
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";

export type DiagnosticFanout = (level: "info" | "warn", scope: string, message: string) => void;

export class BroadcastDiagnosticSink implements DiagnosticSink {
  constructor(
    private readonly inner: DiagnosticSink,
    private readonly fanout: DiagnosticFanout,
  ) {}

  info(scope: string, message: string): void {
    this.inner.info(scope, message);
    this.fanout("info", scope, message);
  }

  warn(scope: string, message: string): void {
    this.inner.warn(scope, message);
    this.fanout("warn", scope, message);
  }
}
