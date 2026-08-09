/**
 * NarrativeDirectorService — composition root of the narrative-memory
 * layer (narrative director, Task 6).
 *
 * Owns the in-memory state, exposes a synchronous brief for the model,
 * batches committed events for background (optional) consolidation, and
 * provides a public consolidatePending() for testability and manual
 * integration. Since Task 8, the consolidation pipeline (truncation,
 * port call, validator filtering, episode id) lives in MemoryConsolidator.
 */

import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";
import type { NarrativeConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { NarrativeMemoryStorePort } from "../../core/ports/narrative-memory-store-port.js";
import type {
  NarrativeCheckpointReason,
  NarrativeDirectorPort,
} from "../../core/ports/narrative-director-port.js";
import type { StoryPlan } from "../../adapters/static/story-plan-loader.js";
import type { StoredEvent } from "../../schema.js";
import type {
  NarrativeMemoryState,
  PlotThread,
  SetupPayoff,
  StoryAnchorState,
  EpisodeMemory,
} from "../../core/narrative/memory-types.js";
import {
  VALID_THREAD_TRANSITIONS,
} from "../../core/narrative/memory-types.js";
import type {
  ThreadOp,
  SetupOp,
  RejectedOp,
} from "../../core/narrative/memory-operation.js";
import type {
  NarrativeBrief,
  NarrativeBriefRequest,
} from "../../core/narrative/narrative-brief.js";
import {
  classifySetup,
  applyThreadOpToState,
  applySetupOpToState,
} from "./memory-validator.js";
import { retrieveEpisodes } from "./episode-retriever.js";
import {
  MemoryConsolidator,
  ACTIVE_THREAD_STATUSES,
  NON_TERMINAL_SETUP_STATUSES,
} from "./memory-consolidator.js";
import type { MemoryConsolidatorPort } from "./memory-consolidator.js";

// ---------------------------------------------------------------------------
// Consolidator port (implemented by Task 8 in memory-consolidator.ts;
// re-exported here so Task 6 imports keep working)
// ---------------------------------------------------------------------------

export type {
  MemoryConsolidatorPort,
  ConsolidationRequest,
  ConsolidationResult,
} from "./memory-consolidator.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum episode IDs to retain in the recent list. */
const MAX_RECENT_EPISODE_IDS = 20;

/** Status order for sorting anchors in the brief. */
const ANCHOR_STATUS_ORDER: Record<StoryAnchorState["status"], number> = {
  pending: 0,
  reached: 1,
  passed: 2,
};

// ---------------------------------------------------------------------------
// Config normalization
// ---------------------------------------------------------------------------

/**
 * Deep-merge a (potentially partial) NarrativeConfig with defaults so
 * getBrief / scheduling never see undefined sub-sections.
 *
 * Callers may shallow-merge configs (e.g. `makeTestConfig` does
 * `{ narrative: DEFAULT_NARRATIVE_CONFIG, ...overrides }`, which
 * replaces the whole narrative section).  This function fills the gaps.
 */
function normalizeNarrativeConfig(raw: NarrativeConfig): NarrativeConfig {
  const d = DEFAULT_NARRATIVE_CONFIG;
  return {
    mode: raw.mode ?? d.mode,
    story_plan_path: raw.story_plan_path ?? d.story_plan_path,
    threads: { ...d.threads, ...raw.threads },
    setups: { ...d.setups, ...raw.setups },
    consolidation: { ...d.consolidation, ...raw.consolidation },
    brief: { ...d.brief, ...raw.brief },
  };
}

// ---------------------------------------------------------------------------
// NarrativeDirectorService
// ---------------------------------------------------------------------------

export class NarrativeDirectorService implements NarrativeDirectorPort {
  private readonly config: NarrativeConfig;
  private readonly store: NarrativeMemoryStorePort;
  private readonly consolidator: MemoryConsolidator;
  private readonly hasConsolidator: boolean;
  private readonly plan: StoryPlan;
  private readonly diagnostics: DiagnosticSink;

  // In-memory consolidated state
  private memory!: NarrativeMemoryState;
  private episodes: EpisodeMemory[] = [];

  // Pending events not yet consolidated
  private pendingEvents: StoredEvent[] = [];

  // Scheduling state
  private lastConsolidateAt = 0;
  private consolidateRunning = false;

  constructor(opts: {
    config: NarrativeConfig;
    store: NarrativeMemoryStorePort;
    consolidator: MemoryConsolidatorPort | undefined;
    plan: StoryPlan;
    diagnostics?: DiagnosticSink;
  }) {
    this.config = normalizeNarrativeConfig(opts.config);
    this.store = opts.store;
    this.plan = opts.plan;
    this.diagnostics = opts.diagnostics ?? silentDiagnosticSink;
    this.hasConsolidator = opts.consolidator !== undefined;
    // Wrap the optional Task 6 port in a MemoryConsolidator; an absent
    // port yields an empty outcome without calling anything.
    this.consolidator = new MemoryConsolidator({
      port: opts.consolidator,
      config: this.config,
      diagnostics: this.diagnostics,
    });
  }

  // -----------------------------------------------------------------------
  // initialize
  // -----------------------------------------------------------------------

  /**
   * Load persisted state and merge author plan seeds.
   *
   * IMPORTANT: the loaded state object is NOT mutated in place — we build
   * a fresh state to avoid the JSON store's EMPTY_STATE reference-sharing
   * pitfall (Task 4 review).
   */
  async initialize(): Promise<void> {
    const { state: loadedState, episodes: loadedEpisodes } =
      await this.store.load();

    // Build fresh state from loaded + plan seeds (plan wins on id conflicts)
    const seedThreads: Record<string, PlotThread> = {};
    for (const t of this.plan.threads) {
      seedThreads[t.id] = t;
    }
    const seedSetups: Record<string, SetupPayoff> = {};
    for (const s of this.plan.setups) {
      seedSetups[s.id] = s;
    }
    const seedAnchors: Record<string, StoryAnchorState> = {};
    for (const a of this.plan.anchors) {
      seedAnchors[a.id] = a;
    }

    this.memory = {
      revision: loadedState.revision,
      consolidatedThroughEventSeq: loadedState.consolidatedThroughEventSeq,
      checkpointCount: loadedState.checkpointCount,
      // Loaded (persisted) state wins over plan seeds for same ids: the
      // static plan only creates entries that do not exist yet (first
      // start). A resumed session must keep its runtime lifecycle
      // (status, timestamps, reinforcement counts) — the plan must never
      // roll them back (audit finding 2).
      threads: { ...seedThreads, ...loadedState.threads },
      setups: { ...seedSetups, ...loadedState.setups },
      anchors: { ...seedAnchors, ...loadedState.anchors },
      recentEpisodeIds: [...loadedState.recentEpisodeIds],
    };

    this.episodes = [...loadedEpisodes];
  }

  // -----------------------------------------------------------------------
  // getBrief — synchronous digest
  // -----------------------------------------------------------------------

  getBrief(request: NarrativeBriefRequest): NarrativeBrief {
    // Active threads (non-terminal)
    const activeThreads = Object.values(this.memory.threads)
      .filter((t) => ACTIVE_THREAD_STATUSES.has(t.status))
      .map((t) => {
        const entry: {
          id: string;
          kind: PlotThread["kind"];
          summary: string;
          status: PlotThread["status"];
          importance: PlotThread["importance"];
          lastTouchedAtCheckpoint: number;
          nextPressure?: string;
        } = {
          id: t.id,
          kind: t.kind,
          summary: t.summary,
          status: t.status,
          importance: t.importance,
          lastTouchedAtCheckpoint: t.lastTouchedAtCheckpoint,
        };
        if (t.nextPressure !== undefined) {
          entry.nextPressure = t.nextPressure;
        }
        return entry;
      });

    // Setup directives for all non-terminal setups
    const currentAnchorId = this.computeCurrentAnchorId();
    const setupDirectives = Object.values(this.memory.setups)
      .filter((s) => NON_TERMINAL_SETUP_STATUSES.has(s.status))
      .map((s) =>
        classifySetup(s, this.memory.checkpointCount, currentAnchorId),
      )
      .filter((d): d is NonNullable<typeof d> => d !== undefined);

    // Relevant episodes via retriever: active threads only (resolved/
    // abandoned threads are dead weight and would blunt the signal), plus
    // the current location (audit finding 9).
    const activeThreadIds = Object.values(this.memory.threads)
      .filter((t) => ACTIVE_THREAD_STATUSES.has(t.status))
      .map((t) => t.id);
    const relevantEpisodes = retrieveEpisodes(this.episodes, {
      characters: request.characters,
      locations: request.location !== "" ? [request.location] : [],
      threads: activeThreadIds,
      max: this.config.brief.max_relevant_episodes,
    });

    // Anchors sorted by status (pending → reached → passed)
    const anchors = Object.values(this.memory.anchors).sort((a, b) => {
      const orderDiff =
        ANCHOR_STATUS_ORDER[a.status] - ANCHOR_STATUS_ORDER[b.status];
      if (orderDiff !== 0) return orderDiff;
      return a.id.localeCompare(b.id);
    });

    return {
      revision: this.memory.revision,
      consolidatedThroughEventSeq: this.memory.consolidatedThroughEventSeq,
      currentEventSeq: request.eventSeq,
      checkpointCount: this.memory.checkpointCount,
      location: request.location,
      characters: request.characters,
      activeThreads,
      setupDirectives,
      relevantEpisodes,
      anchors,
      revealLocks: [],
    };
  }

  // -----------------------------------------------------------------------
  // observeCommitted
  // -----------------------------------------------------------------------

  observeCommitted(events: readonly StoredEvent[]): void {
    this.pendingEvents.push(...events);
    this.maybeSchedule();
  }

  // -----------------------------------------------------------------------
  // checkpoint
  // -----------------------------------------------------------------------

  checkpoint(_reason: NarrativeCheckpointReason): void {
    this.memory.checkpointCount += 1;
    this.maybeSchedule();
  }

  // -----------------------------------------------------------------------
  // consolidatePending — public for testability
  // -----------------------------------------------------------------------

  async consolidatePending(): Promise<{
    applied: number;
    rejected: RejectedOp[];
  }> {
    // No consolidator → nothing to do
    if (!this.hasConsolidator) {
      return { applied: 0, rejected: [] };
    }

    // Guard against concurrent calls (safe for both direct and scheduled)
    if (this.consolidateRunning) {
      return { applied: 0, rejected: [] };
    }
    this.consolidateRunning = true;

    try {
      // Atomically drain pending events at the start so observeCommitted
      // during async consolidation does not lose events.
      const pending = this.pendingEvents;
      this.pendingEvents = [];

      if (pending.length === 0) {
        return { applied: 0, rejected: [] };
      }

      // FIFO batching: take the OLDEST max_events_per_call events first
      // (the continuous front of the watermark). Newer overflow events stay
      // pending and are requeued on success — narrative time order is
      // preserved and the watermark advances continuously. The
      // MemoryConsolidator also caps internally (defense in depth, now
      // idempotent since the director already capped).
      const maxEvents = this.config.consolidation.max_events_per_call;
      const batch =
        pending.length > maxEvents ? pending.slice(0, maxEvents) : pending;
      const overflow =
        pending.length > maxEvents ? pending.slice(maxEvents) : [];

      if (overflow.length > 0) {
        this.diagnostics.info(
          "NarrativeDirector",
          `Batch capped to ${maxEvents} oldest events; ${overflow.length} newer events deferred to a later call`,
        );
      }

      // Delegate the pipeline (port call, validator filtering, episode id
      // generation) to the MemoryConsolidator. The batch is already capped.
      const outcome = await this.consolidator.consolidate(
        batch,
        this.memory,
        "",
        [],
      );

      // Port failure → empty outcome: re-queue the FULL drained batch at
      // the front so events are not permanently lost on consolidation
      // failure. lastConsolidateAt is also advanced so the retry is
      // throttled by min_checkpoint_gap_ms (no failure storm).
      if (outcome.result === null) {
        this.pendingEvents = [...pending, ...this.pendingEvents];
        this.lastConsolidateAt = Date.now();
        return { applied: 0, rejected: [] };
      }

      // --- Success: defer the newer overflow events to a later call ---
      if (overflow.length > 0) {
        this.pendingEvents = [...overflow, ...this.pendingEvents];
        this.diagnostics.info(
          "NarrativeDirector",
          `${overflow.length} newer events deferred for next consolidation`,
        );
      }

      // --- Apply results onto a SHADOW, persist, then swap ---
      // Copy-on-write (audit finding 6): nothing touches live memory until
      // every persistence step succeeded. On any failure the full drained
      // batch is requeued and memory stays untouched; a retry regenerates
      // the same episode id (revision did not advance) so appendEpisodes
      // stays idempotent (load() dedupes by id).
      const rejected = [...outcome.rejected];
      let applied = 0;

      const batchLastSeq = batch[batch.length - 1]!.seq;
      // FIFO guarantees the batch's last seq is exactly the new continuous
      // front: every event up to batchLastSeq has now been consolidated
      // (older events were consolidated in previous calls). No Math.max
      // needed — the front only ever moves forward.
      const newWatermark = batchLastSeq;

      // Timeline fields are checkpoint units (narrative beats), not event
      // seqs: classifySetup's age math compares them against the checkpoint
      // counter (audit finding 3).
      const nowCheckpoint = this.memory.checkpointCount;

      const shadow = structuredClone(this.memory);
      const nextEpisodes = [...this.episodes];

      // 1) Episode
      let newEpisode: EpisodeMemory | undefined;
      if (outcome.episode !== null) {
        newEpisode = outcome.episode;
        nextEpisodes.push(newEpisode);
        applied += 1;
      }

      // 2) Thread ops (shared pure apply; timeline in checkpoint units)
      for (const op of outcome.threadOps) {
        applyThreadOpToState(shadow, op, nowCheckpoint);
        applied += 1;
      }

      // 3) Setup ops
      for (const op of outcome.setupOps) {
        applySetupOpToState(shadow, op, nowCheckpoint);
        applied += 1;
      }

      // --- Advance state (on the shadow) ---
      shadow.revision += 1;
      shadow.consolidatedThroughEventSeq = newWatermark;

      // Insert the episode id into recentEpisodeIds (the same id the
      // consolidator generated for the appended episode).
      if (newEpisode) {
        shadow.recentEpisodeIds.unshift(newEpisode.id);
        if (shadow.recentEpisodeIds.length > MAX_RECENT_EPISODE_IDS) {
          shadow.recentEpisodeIds = shadow.recentEpisodeIds.slice(
            0,
            MAX_RECENT_EPISODE_IDS,
          );
        }
      }

      // Persist — saveState is the commit point and goes first. Any
      // failure: memory untouched, full batch requeued.
      try {
        await this.store.saveState(shadow);
        if (newEpisode) {
          await this.store.appendEpisodes([newEpisode]);
        }
      } catch (err) {
        this.pendingEvents = [...pending, ...this.pendingEvents];
        this.diagnostics.warn(
          "NarrativeDirector",
          `persist failed, batch requeued: ${String(err)}`,
        );
        return { applied: 0, rejected: [] };
      }
      if (rejected.length > 0) {
        try {
          await this.store.appendOps(rejected);
        } catch (err) {
          // Debug log only — not part of the memory commit.
          this.diagnostics.warn(
            "NarrativeDirector",
            `appendOps failed (debug log only): ${String(err)}`,
          );
        }
      }

      // Everything persisted → swap in the new state.
      this.memory = shadow;
      this.episodes = nextEpisodes;
      this.lastConsolidateAt = Date.now();

      return { applied, rejected };
    } finally {
      this.consolidateRunning = false;
      // Events observed WHILE this consolidation was in flight may now
      // cross the batch threshold — re-check the scheduler (the gap
      // throttle and batch_min guard still apply; the single-flight flag
      // is already released) so pending work drains without manual
      // intervention (audit finding 5).
      this.maybeSchedule();
    }
  }

  // -----------------------------------------------------------------------
  // Internal: scheduling
  // -----------------------------------------------------------------------

  private maybeSchedule(): void {
    if (!this.hasConsolidator) return;
    if (this.consolidateRunning) return;
    if (this.pendingEvents.length < this.config.consolidation.batch_min_events)
      return;

    const gapMs = Date.now() - this.lastConsolidateAt;
    if (gapMs < this.config.consolidation.min_checkpoint_gap_ms) return;

    void this.consolidatePending().catch((err: unknown) => {
      this.diagnostics.warn(
        "NarrativeDirector",
        `scheduled consolidation error: ${String(err)}`,
      );
    });
  }

  // -----------------------------------------------------------------------
  // Internal: anchor id computation
  // -----------------------------------------------------------------------

  /**
   * Find the first pending anchor AFTER the most recent reached/passed
   * anchor. Returns undefined when no anchor has been reached yet.
   *
   * Anchor progression (reach/pass) is a Step-3 PlotPlanner concern; in
   * Step 1+2 no anchor can ever become reached, so this returns undefined
   * and payoffBeforeAnchor directives stay inert — the brief must not
   * claim a payoff deadline it cannot honor (audit finding 3).
   */
  private computeCurrentAnchorId(): string | undefined {
    // Sort anchors by id for determinism
    const sorted = Object.values(this.memory.anchors).sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    // Find last reached/passed index
    let lastResolvedIdx = -1;
    for (let i = 0; i < sorted.length; i++) {
      const status = sorted[i]!.status;
      if (status === "reached" || status === "passed") {
        lastResolvedIdx = i;
      }
    }

    // No anchor has been reached yet → no "current" anchor exists
    // (Step 2 has no anchor-progression mechanism).
    if (lastResolvedIdx === -1) {
      return undefined;
    }

    // Look for first pending after that index
    for (let i = lastResolvedIdx + 1; i < sorted.length; i++) {
      if (sorted[i]!.status === "pending") {
        return sorted[i]!.id;
      }
    }

    return undefined;
  }


}
