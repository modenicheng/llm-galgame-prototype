/**
 * NarrativeDirectorService — composition root of the narrative-memory
 * layer (narrative director, Task 6).
 *
 * Owns the in-memory state, exposes a synchronous brief for the model,
 * batches committed events for background (optional) consolidation, and
 * provides a public consolidatePending() for testability and manual
 * integration.
 */

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
  EpisodeSummaryOp,
  RejectedOp,
} from "../../core/narrative/memory-operation.js";
import type {
  NarrativeBrief,
  NarrativeBriefRequest,
} from "../../core/narrative/narrative-brief.js";
import {
  validateThreadOp,
  validateSetupOp,
  validateEpisodeOp,
  classifySetup,
} from "./memory-validator.js";
import { retrieveEpisodes } from "./episode-retriever.js";

// ---------------------------------------------------------------------------
// Consolidator port (defined here; implemented by Task 8)
// ---------------------------------------------------------------------------

export interface ConsolidationRequest {
  events: StoredEvent[];
  threads: PlotThread[];
  setups: SetupPayoff[];
  stateLocation: string;
  stateCharacters: string[];
}

export interface ConsolidationResult {
  episode: EpisodeSummaryOp;
  threadOps: ThreadOp[];
  setupOps: SetupOp[];
}

export interface MemoryConsolidatorPort {
  consolidate(request: ConsolidationRequest): Promise<ConsolidationResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Thread statuses that count as "active" for brief and consolidation. */
const ACTIVE_THREAD_STATUSES: ReadonlySet<PlotThread["status"]> = new Set([
  "open",
  "developing",
  "ready_to_resolve",
]);

/** Setup statuses that are non-terminal (still relevant). */
const NON_TERMINAL_SETUP_STATUSES: ReadonlySet<SetupPayoff["status"]> = new Set([
  "planned",
  "seeded",
  "reinforced",
  "ready",
]);

/** Maximum episode IDs to retain in the recent list. */
const MAX_RECENT_EPISODE_IDS = 20;

/** Status order for sorting anchors in the brief. */
const ANCHOR_STATUS_ORDER: Record<StoryAnchorState["status"], number> = {
  pending: 0,
  reached: 1,
  passed: 2,
};

// ---------------------------------------------------------------------------
// NarrativeDirectorService
// ---------------------------------------------------------------------------

export class NarrativeDirectorService implements NarrativeDirectorPort {
  private readonly config: NarrativeConfig;
  private readonly store: NarrativeMemoryStorePort;
  private readonly consolidator: MemoryConsolidatorPort | undefined;
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
    this.config = opts.config;
    this.store = opts.store;
    this.consolidator = opts.consolidator;
    this.plan = opts.plan;
    this.diagnostics = opts.diagnostics ?? silentDiagnosticSink;
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
    if (this.consolidator === undefined) {
      return { applied: 0, rejected: [] };
    }

    // Take pending events, capped to max_events_per_call (keep last N)
    const maxEvents = this.config.consolidation.max_events_per_call;
    const batch =
      this.pendingEvents.length > maxEvents
        ? this.pendingEvents.slice(-maxEvents)
        : [...this.pendingEvents];

    if (batch.length === 0) {
      return { applied: 0, rejected: [] };
    }

    const batchLastSeq = batch[batch.length - 1]!.seq;

    // Active threads and non-terminal setups for the consolidator
    const activeThreads = Object.values(this.memory.threads).filter((t) =>
      ACTIVE_THREAD_STATUSES.has(t.status),
    );
    const nonTerminalSetups = Object.values(this.memory.setups).filter((s) =>
      NON_TERMINAL_SETUP_STATUSES.has(s.status),
    );

    // --- Call consolidator ---
    let result: ConsolidationResult;
    try {
      result = await this.consolidator.consolidate({
        events: batch,
        threads: activeThreads,
        setups: nonTerminalSetups,
        stateLocation: "",
        stateCharacters: [],
      });
    } catch (err) {
      this.diagnostics.warn(
        "NarrativeDirector",
        `consolidation failed: ${String(err)}`,
      );
      return { applied: 0, rejected: [] };
    }

    // --- Apply results ---
    const rejected: RejectedOp[] = [];
    let applied = 0;

    // 1) Episode
    const epReason = validateEpisodeOp(result.episode);
    if (epReason === null) {
      const ep = this.buildEpisode(result.episode, batch);
      this.episodes.push(ep);
      applied += 1;
    } else {
      rejected.push({ kind: "episode", op: result.episode, reason: epReason });
    }

    // 2) Thread ops
    for (const op of result.threadOps) {
      const reason = validateThreadOp(op, this.memory, this.config);
      if (reason === null) {
        this.applyThreadOp(op, batchLastSeq);
        applied += 1;
      } else {
        rejected.push({ kind: "thread", op, reason });
      }
    }

    // 3) Setup ops
    for (const op of result.setupOps) {
      const reason = validateSetupOp(op, this.memory, this.config);
      if (reason === null) {
        this.applySetupOp(op, batchLastSeq);
        applied += 1;
      } else {
        rejected.push({ kind: "setup", op, reason });
      }
    }

    // --- Advance state ---
    this.memory.revision += 1;
    this.memory.consolidatedThroughEventSeq = batchLastSeq;

    // Build the episode and insert into recentEpisodeIds
    if (epReason === null) {
      const epId = this.makeEpisodeId(result.episode, batch);
      this.memory.recentEpisodeIds.unshift(epId);
      if (this.memory.recentEpisodeIds.length > MAX_RECENT_EPISODE_IDS) {
        this.memory.recentEpisodeIds = this.memory.recentEpisodeIds.slice(
          0,
          MAX_RECENT_EPISODE_IDS,
        );
      }
    }

    // Persist
    await this.store.saveState(this.memory);
    if (epReason === null) {
      const lastEp = this.episodes[this.episodes.length - 1];
      if (lastEp) {
        await this.store.appendEpisodes([lastEp]);
      }
    }
    if (rejected.length > 0) {
      await this.store.appendOps(rejected);
    }

    // Clear pending batch
    this.pendingEvents = [];
    this.lastConsolidateAt = Date.now();

    return { applied, rejected };
  }

  // -----------------------------------------------------------------------
  // Internal: scheduling
  // -----------------------------------------------------------------------

  private maybeSchedule(): void {
    if (this.consolidator === undefined) return;
    if (this.consolidateRunning) return;
    if (this.pendingEvents.length < this.config.consolidation.batch_min_events)
      return;

    const gapMs = Date.now() - this.lastConsolidateAt;
    if (gapMs < this.config.consolidation.min_checkpoint_gap_ms) return;

    this.consolidateRunning = true;
    void this.consolidatePending()
      .catch((err: unknown) => {
        this.diagnostics.warn(
          "NarrativeDirector",
          `scheduled consolidation error: ${String(err)}`,
        );
      })
      .finally(() => {
        this.consolidateRunning = false;
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

  // -----------------------------------------------------------------------
  // Internal: episode helpers
  // -----------------------------------------------------------------------

  private makeEpisodeId(
    _op: EpisodeSummaryOp,
    batch: StoredEvent[],
  ): string {
    const from = batch[0]!.seq;
    const to = batch[batch.length - 1]!.seq;
    const ts = Date.now();
    return `ep-${ts}-${from}-${to}`;
  }

  private buildEpisode(
    op: EpisodeSummaryOp,
    batch: StoredEvent[],
  ): EpisodeMemory {
    const from = batch[0]!.seq;
    const to = batch[batch.length - 1]!.seq;
    const id = this.makeEpisodeId(op, batch);
    return {
      id,
      fromEventSeq: from,
      toEventSeq: to,
      summary: op.summary,
      characters: op.characters,
      locations: op.locations,
      threads: op.threads,
      setups: op.setups,
      importance: op.importance,
    };
  }
}
