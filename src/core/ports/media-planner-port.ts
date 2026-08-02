/**
 * MediaPlannerPort — the pure media-intent interface the Core depends on.
 *
 * The planner expresses only what the runtime knows: which lines exist,
 * which path they belong to, and their lifecycle (registered, selected,
 * discarded, presented). It never expresses playback state, cache state,
 * or synthesis completion — those belong to the browser.
 *
 * `isReady` / `waitUntilReady` are transitional readiness queries kept so
 * the CLI host can gate text pacing on mock audio. The browser host never
 * calls them: V2 text is presented immediately and never waits for audio.
 */
import type { RuntimePlayableEvent } from "../../schema.js";

export interface MediaPlannerPort {
  /** Register lines on the formal (active) path. */
  registerActive(lines: RuntimePlayableEvent[]): void;

  /** Register a candidate branch's first lines for speculative prefetch. */
  registerCandidate(branchId: string, lines: RuntimePlayableEvent[]): void;

  /** Promote a candidate branch to the active path; discard all others. */
  activateCandidate(branchId: string): void;

  /** Invalidate a candidate branch (discarded or preview canceled). */
  discardCandidate(branchId: string): void;

  /** The line has been presented; the media cursor moves past it. */
  markPresented(lineId: string): void;

  // --- Transitional readiness queries (CLI pacing only) ---

  /** Whether the line's audio is ready (or media is disabled). */
  isReady(lineId: string): boolean;

  /** Wait until the line is ready, degrading to text on failure/timeout. */
  waitUntilReady(lineId: string, timeoutMs?: number): Promise<boolean>;
}
