/**
 * Time source abstraction.
 *
 * Core runtime code must never call `Date.now()` or
 * `new Date().toISOString()` directly — that keeps every state transition
 * (timestamps, dwell measurements, task IDs) deterministic in tests and
 * injectable in any host environment.
 */
export interface ClockPort {
  /** Monotonic-ish wall clock in milliseconds since the Unix epoch. */
  nowMs(): number;
  /** Current time as an ISO-8601 string. */
  nowIso(): string;
}
