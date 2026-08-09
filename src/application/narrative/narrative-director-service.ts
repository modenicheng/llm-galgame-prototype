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
import { classifySetup } from "./memory-validator.js";
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
      // Plan seeds take precedence over loaded state for same ids
      threads: { ...loadedState.threads, ...seedThreads },
      setups: { ...loadedState.setups, ...seedSetups },
      anchors: { ...loadedState.anchors, ...seedAnchors },
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
          lastTouchedAt: number;
          nextPressure?: string;
        } = {
          id: t.id,
          kind: t.kind,
          summary: t.summary,
          status: t.status,
          importance: t.importance,
          lastTouchedAt: t.lastTouchedAt,
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

    // Relevant episodes via retriever
    const threadIds = Object.keys(this.memory.threads);
    const relevantEpisodes = retrieveEpisodes(this.episodes, {
      characters: request.characters,
      threads: threadIds,
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
      // failure.
      if (outcome.result === null) {
        this.pendingEvents = [...pending, ...this.pendingEvents];
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

      // --- Apply results (already validated by the consolidator) ---
      const rejected = [...outcome.rejected];
      let applied = 0;

      const batchLastSeq = batch[batch.length - 1]!.seq;
      // FIFO guarantees the batch's last seq is exactly the new continuous
      // front: every event up to batchLastSeq has now been consolidated
      // (older events were consolidated in previous calls). No Math.max
      // needed — the front only ever moves forward.
      const newWatermark = batchLastSeq;

      // 1) Episode
      let newEpisode: EpisodeMemory | undefined;
      if (outcome.episode !== null) {
        newEpisode = outcome.episode;
        this.episodes.push(newEpisode);
        applied += 1;
      }

      // 2) Thread ops
      for (const op of outcome.threadOps) {
        this.applyThreadOp(op, batchLastSeq);
        applied += 1;
      }

      // 3) Setup ops
      for (const op of outcome.setupOps) {
        this.applySetupOp(op, batchLastSeq);
        applied += 1;
      }

      // --- Advance state ---
      this.memory.revision += 1;
      this.memory.consolidatedThroughEventSeq = newWatermark;

      // Insert the episode id into recentEpisodeIds (the same id the
      // consolidator generated for the appended episode).
      if (newEpisode) {
        this.memory.recentEpisodeIds.unshift(newEpisode.id);
        if (this.memory.recentEpisodeIds.length > MAX_RECENT_EPISODE_IDS) {
          this.memory.recentEpisodeIds = this.memory.recentEpisodeIds.slice(
            0,
            MAX_RECENT_EPISODE_IDS,
          );
        }
      }

      // Persist
      await this.store.saveState(this.memory);
      if (newEpisode) {
        await this.store.appendEpisodes([newEpisode]);
      }
      if (rejected.length > 0) {
        await this.store.appendOps(rejected);
      }

      this.lastConsolidateAt = Date.now();

      return { applied, rejected };
    } finally {
      this.consolidateRunning = false;
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
   * Find the first pending anchor after the most recent reached/passed
   * anchor. Returns undefined if no such anchor exists.
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

    // Look for first pending after that index
    for (let i = lastResolvedIdx + 1; i < sorted.length; i++) {
      if (sorted[i]!.status === "pending") {
        return sorted[i]!.id;
      }
    }

    return undefined;
  }

  // -----------------------------------------------------------------------
  // Internal: apply ops to in-memory state
  // -----------------------------------------------------------------------

  private applyThreadOp(op: ThreadOp, now: number): void {
    switch (op.type) {
      case "touch": {
        const t = this.memory.threads[op.id];
        if (t) {
          t.lastTouchedAt = now;
          if (op.progress !== undefined) {
            t.summary = op.progress;
          }
        }
        break;
      }
      case "advance": {
        const t = this.memory.threads[op.id];
        if (t) {
          const nextStatuses = VALID_THREAD_TRANSITIONS[t.status] ?? [];
          const nextStatus = nextStatuses[0];
          if (nextStatus) {
            t.status = nextStatus;
          }
          t.lastTouchedAt = now;
        }
        break;
      }
      case "resolve": {
        const t = this.memory.threads[op.id];
        if (t) {
          t.status = "resolved";
          t.lastTouchedAt = now;
        }
        break;
      }
      case "abandon": {
        const t = this.memory.threads[op.id];
        if (t) {
          t.status = "abandoned";
          t.lastTouchedAt = now;
        }
        break;
      }
      case "create": {
        this.memory.threads[op.id] = {
          id: op.id,
          kind: "main",
          summary: op.progress ?? `Thread ${op.id}`,
          status: "open",
          importance: "minor",
          introducedAt: now,
          lastTouchedAt: now,
          source: "runtime",
        };
        break;
      }
    }
  }

  private applySetupOp(op: SetupOp, now: number): void {
    const s = this.memory.setups[op.id];
    if (!s) return;

    switch (op.type) {
      case "seed": {
        s.status = "seeded";
        s.seededAt = now;
        s.lastTouchedAt = now;
        break;
      }
      case "reinforce": {
        s.status = "reinforced";
        s.reinforcementCount += 1;
        s.lastTouchedAt = now;
        break;
      }
      case "payoff": {
        s.status = "paid_off";
        s.payoffAt = now;
        s.lastTouchedAt = now;
        break;
      }
      case "hold": {
        // No change
        break;
      }
      case "drop": {
        s.status = "dropped";
        break;
      }
    }
  }

}
