import type { ClockPort } from "../../core/ports/clock-port.js";

/** Real wall clock for Node hosts. */
export class SystemClock implements ClockPort {
  nowMs(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date().toISOString();
  }
}
