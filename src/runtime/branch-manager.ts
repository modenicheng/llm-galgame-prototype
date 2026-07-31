/**
 * Thin lifecycle wrapper around BranchPrefetchGroup that formalises branch
 * transactions as BranchCandidate objects per the story/types.ts protocol.
 *
 * BranchPrefetchGroup handles the raw generation pipeline (queued → running
 * → ready / failed / cancelled).  BranchManager adds a semantic layer on
 * top: it creates a BranchCandidate for each option, tracks status
 * transitions (queued / generating / ready / selected / discarded / failed),
 * records observability metrics, and exposes a simple API for the Game
 * class.
 */

import { BranchPrefetchGroup } from "../prefetch.js";
import type { BranchPrefetchOptions, LiveBranchSelection } from "../prefetch.js";
import type { ChoiceOption, RuntimePlayableEvent } from "../schema.js";
import type {
  BranchCandidate,
  BranchSource,
  BranchStatus,
  GeneratedEvent,
  StoryStatePatch,
} from "../story/types.js";
import type { Metrics } from "./metrics.js";

// ---------------------------------------------------------------------------
// BranchManager
// ---------------------------------------------------------------------------

export class BranchManager {
  private group: BranchPrefetchGroup | null = null;
  private readonly candidates = new Map<string, BranchCandidate>();

  constructor(private readonly metrics?: Metrics) {}

  // ------------------------------------------------------------------
  // Candidate lifecycle
  // ------------------------------------------------------------------

  /**
   * Create a single BranchCandidate and register it.
   *
   * The candidate starts in `"queued"` status.  Call `startPrefetch` (or
   * create all candidates first, then call `startPrefetch`) to begin the
   * generation pipeline.
   */
  createCandidate(
    id: string,
    interactionId: string,
    source: BranchSource,
    overrides?: Partial<
      Pick<BranchCandidate, "predicted_input" | "intent">
    >,
  ): BranchCandidate {
    const candidate: BranchCandidate = {
      id,
      interaction_id: interactionId,
      source,
      status: "queued",
      events: [],
      ...overrides,
    };
    this.candidates.set(id, candidate);
    return candidate;
  }

  /**
   * Start the underlying BranchPrefetchGroup with the given options.
   *
   * Wraps the user-supplied `generate` and `onReady` callbacks so that
   * every branch is transitioned to "generating" when generation starts
   * and to "ready" when it completes.
   */
  startPrefetch(options: BranchPrefetchOptions): void {
    const wrapped: BranchPrefetchOptions = {
      ...options,
      generate: (option, signal, onEvent) => {
        this.updateCandidateStatus(option.id, "generating");
        return options.generate(option, signal, onEvent);
      },
      onEvent: (option, event) => {
        const candidate = this.candidates.get(option.id);
        if (
          candidate &&
          !candidate.events.some(
            (existing) => (existing as RuntimePlayableEvent).line_id === event.line_id,
          )
        ) {
          candidate.events.push(event);
        }
        options.onEvent?.(option, event);
      },
      onReady: (option, events) => {
        this.updateCandidateStatus(option.id, "ready", events);
        options.onReady?.(option, events);
      },
    };

    this.group = new BranchPrefetchGroup(wrapped);
    this.group.start();

    this.metrics?.recordBranchRequested(options.choice.options.length);
  }

  /**
   * Transition a candidate to a new lifecycle status, optionally attaching
   * generated events and a state patch.
   */
  updateCandidateStatus(
    id: string,
    status: BranchStatus,
    events?: GeneratedEvent[],
    statePatch?: StoryStatePatch,
  ): void {
    const candidate = this.candidates.get(id);
    if (!candidate) return;
    candidate.status = status;
    if (events !== undefined) candidate.events = events;
    if (statePatch !== undefined) candidate.state_patch = statePatch;
  }

  /**
   * Select the branch identified by `optionId`, wait for its generation
   * to complete (or return immediately if already ready), mark the
   * candidate as `"selected"`, and record a prefetch hit.
   *
   * Throws if generation failed — the candidate will have been marked
   * `"failed"` and a miss recorded before the error propagates.
   */
  async selectCandidate(optionId: string): Promise<RuntimePlayableEvent[]> {
    if (!this.group) throw new Error("No active prefetch group");

    try {
      const events = await this.group.take(optionId);
      this.updateCandidateStatus(optionId, "selected");
      this.metrics?.recordPrefetchHit();
      return events;
    } catch (error) {
      this.updateCandidateStatus(optionId, "failed");
      this.metrics?.recordPrefetchMiss();
      throw error;
    }
  }

  /** Select without waiting for the candidate's current request to finish. */
  selectCandidateLive(optionId: string): LiveBranchSelection {
    if (!this.group) throw new Error("No active prefetch group");
    const selection = this.group.selectLive(optionId);
    this.updateCandidateStatus(optionId, "selected", selection.events);
    this.metrics?.recordPrefetchHit();
    return selection;
  }

  /**
   * Mark a single candidate as `"discarded"` without cancelling the
   * underlying prefetch group.
   */
  discardCandidate(id: string): void {
    this.updateCandidateStatus(id, "discarded");
  }

  /**
   * Discard every candidate that has not been selected or already failed,
   * cancel the underlying prefetch group, and release its resources.
   */
  discardAll(): void {
    for (const [, candidate] of this.candidates) {
      if (candidate.status !== "selected" && candidate.status !== "failed") {
        candidate.status = "discarded";
      }
    }
    this.group?.cancelAll();
    this.group = null;
    this.candidates.clear();
  }

  // ------------------------------------------------------------------
  // Read accessors
  // ------------------------------------------------------------------

  getCandidate(id: string): BranchCandidate | undefined {
    return this.candidates.get(id);
  }

  getCandidates(): BranchCandidate[] {
    return [...this.candidates.values()];
  }

  /** True when a prefetch group is active (started and not yet discarded). */
  isActive(): boolean {
    return this.group !== null;
  }
}
