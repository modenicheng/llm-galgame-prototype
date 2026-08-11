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
import type { DirectorPlan } from "../../core/narrative/director-plan.js";
import {
  applyThreadOpToState,
  applySetupOpToState,
  setupPrerequisitesSatisfied,
} from "./memory-validator.js";
import {
  computeCurrentAnchorId,
  scheduleSetups,
} from "./setup-scheduler.js";
import { retrieveEpisodes } from "./episode-retriever.js";
import {
  MemoryConsolidator,
  ACTIVE_THREAD_STATUSES,
} from "./memory-consolidator.js";
import type { MemoryConsolidatorPort } from "./memory-consolidator.js";
import {
  PlotPlanner,
  PLANNER_RECENT_EVENTS_MAX,
  validateAnchorOp,
  applyAnchorOpToState,
} from "./plot-planner.js";
import type { PlotPlannerPort } from "./plot-planner.js";

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
    event: { ...d.event, ...raw.event },
    threads: { ...d.threads, ...raw.threads },
    setups: { ...d.setups, ...raw.setups },
    consolidation: { ...d.consolidation, ...raw.consolidation },
    brief: { ...d.brief, ...raw.brief },
    plan: { ...d.plan, ...raw.plan },
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
  private readonly storyPlan: StoryPlan;
  private readonly diagnostics: DiagnosticSink;
  private readonly planner: PlotPlanner;
  private readonly hasPlanner: boolean;

  // In-memory consolidated state
  private memory!: NarrativeMemoryState;
  private episodes: EpisodeMemory[] = [];

  // Pending events not yet consolidated
  private pendingEvents: StoredEvent[] = [];

  // Director plan lifecycle (Task 8)
  private plan: DirectorPlan | undefined;
  private planRunning = false;
  private recentCommittedEvents: StoredEvent[] = [];
  private lastBriefRequest: NarrativeBriefRequest | undefined;

  // Serializes all "read this.memory → shadow → saveState → swap" writes
  // (consolidation apply and anchor progression) so concurrent writers
  // never overwrite each other's changes.
  private memoryWriteChain: Promise<void> = Promise.resolve();

  // Scheduling state
  private lastConsolidateAt = 0;
  private consolidateRunning = false;
  /** In-flight consolidation (single-flight); flush() awaits it. */
  private consolidationPromise: Promise<{
    applied: number;
    rejected: RejectedOp[];
  }> | null = null;

  // Author declaration order of plan anchors (audit P1-5): drives
  // computeCurrentAnchorId ordering instead of id lexicographic order.
  private readonly seedAnchorOrder: ReadonlyMap<string, number>;

  constructor(opts: {
    config: NarrativeConfig;
    store: NarrativeMemoryStorePort;
    consolidator: MemoryConsolidatorPort | undefined;
    planner?: PlotPlannerPort;
    plan: StoryPlan;
    diagnostics?: DiagnosticSink;
  }) {
    this.config = normalizeNarrativeConfig(opts.config);
    this.store = opts.store;
    this.storyPlan = opts.plan;
    this.seedAnchorOrder = new Map(
      opts.plan.anchors.map((a, index) => [a.id, index]),
    );
    this.diagnostics = opts.diagnostics ?? silentDiagnosticSink;
    this.hasConsolidator = opts.consolidator !== undefined;
    // Wrap the optional Task 6 port in a MemoryConsolidator; an absent
    // port yields an empty outcome without calling anything.
    this.consolidator = new MemoryConsolidator({
      port: opts.consolidator,
      config: this.config,
      diagnostics: this.diagnostics,
    });
    // Wrap the optional Task 7 port in a PlotPlanner; an absent port
    // yields a null plan without calling anything.
    this.planner = new PlotPlanner({
      port: opts.planner,
      config: this.config,
      diagnostics: this.diagnostics,
    });
    this.hasPlanner = opts.planner !== undefined;
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

    // Build fresh state from loaded + plan seeds (loaded wins on id conflicts)
    const seedThreads: Record<string, PlotThread> = {};
    for (const t of this.storyPlan.threads) {
      seedThreads[t.id] = t;
    }
    const seedSetups: Record<string, SetupPayoff> = {};
    for (const s of this.storyPlan.setups) {
      seedSetups[s.id] = s;
    }
    const seedAnchors: Record<string, StoryAnchorState> = {};
    for (const a of this.storyPlan.anchors) {
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

    // Resume the director plan (if any) from the store; a fresh session
    // starts without one and the first checkpoint creates it. The store
    // contract is `DirectorPlan | null` — normalize to undefined so every
    // `this.plan !== undefined` guard holds.
    this.plan = (await this.store.loadPlan()) ?? undefined;
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
    const currentAnchorId = computeCurrentAnchorId(
      this.memory.anchors,
      this.seedAnchorOrder,
    );
    // 前置满足集合（setup prerequisites：锚点/线程/伏笔引用，确定性判定）
    const satisfiedSetupIds = new Set(
      Object.values(this.memory.setups)
        .filter((s) => setupPrerequisitesSatisfied(s.prerequisites, this.memory))
        .map((s) => s.id),
    );
    const setupDirectives = scheduleSetups(
      Object.values(this.memory.setups),
      this.memory.checkpointCount,
      currentAnchorId,
      (id) => satisfiedSetupIds.has(id),
    );

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

    // Director plan section: expose phase/goal/beats/revealLocks while the
    // plan is still in effect. A hard-expired plan acts as a non-blocking
    // barrier — the brief simply omits the plan section (the model keeps
    // playing; replanning happens in the background) instead of blocking
    // the turn on the LLM.
    const planInEffect =
      this.plan !== undefined &&
      this.memory.checkpointCount <= this.plan.expiresAfterCheckpoint
        ? this.plan
        : undefined;

    this.lastBriefRequest = request;

    const brief: NarrativeBrief = {
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
      revealLocks: planInEffect?.revealLocks ?? [],
    };
    // exactOptionalPropertyTypes: an explicit `undefined` is not assignable
    // to an optional property — assign conditionally instead.
    if (planInEffect !== undefined) {
      brief.phase = planInEffect.phase;
      brief.currentGoal = planInEffect.currentGoal;
      brief.beats = planInEffect.beats;
    }
    return brief;
  }

  // -----------------------------------------------------------------------
  // observeCommitted
  // -----------------------------------------------------------------------

  observeCommitted(events: readonly StoredEvent[]): void {
    this.pendingEvents.push(...events);
    // Rolling window of recently committed events for the planner.
    this.recentCommittedEvents.push(...events);
    if (this.recentCommittedEvents.length > PLANNER_RECENT_EVENTS_MAX) {
      this.recentCommittedEvents = this.recentCommittedEvents.slice(
        -PLANNER_RECENT_EVENTS_MAX,
      );
    }
    this.maybeSchedule();
  }

  // -----------------------------------------------------------------------
  // checkpoint
  // -----------------------------------------------------------------------

  checkpoint(_reason: NarrativeCheckpointReason): void {
    this.memory.checkpointCount += 1;
    this.maybeSchedule();
    this.maybeReplan();
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

    // Guard against concurrent calls (safe for both direct and scheduled):
    // a caller that arrives while a consolidation is in flight gets the
    // in-flight promise so flush() can wait for it to settle.
    if (this.consolidateRunning) {
      return this.consolidationPromise ?? { applied: 0, rejected: [] };
    }
    this.consolidateRunning = true;
    this.consolidationPromise = this.runConsolidatePending();
    try {
      return await this.consolidationPromise;
    } finally {
      this.consolidateRunning = false;
      this.consolidationPromise = null;
      // Events observed WHILE this consolidation was in flight may now
      // cross the batch threshold — re-check the scheduler (the gap
      // throttle and batch_min guard still apply; the single-flight flag
      // is already released) so pending work drains without manual
      // intervention (audit finding 5).
      this.maybeSchedule();
    }
  }

  /** consolidatePending 主体（原 try 块内逻辑，含批量、port 调用、mutateMemory）。 */
  private async runConsolidatePending(): Promise<{
    applied: number;
    rejected: RejectedOp[];
  }> {
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
      this.lastBriefRequest?.location ?? "",
      this.lastBriefRequest?.characters ?? [],
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
    //
    // The apply/persist/swap section runs inside the memory-write mutex
    // (Task 8): the callback re-reads the chain-latest this.memory so a
    // concurrent replan's anchor progression is never overwritten (and
    // vice versa). The LLM call above stays outside the chain — only the
    // write section is serialized.
    const rejected = [...outcome.rejected];

    const batchLastSeq = batch[batch.length - 1]!.seq;
    // FIFO guarantees the batch's last seq is exactly the new continuous
    // front: every event up to batchLastSeq has now been consolidated
    // (older events were consolidated in previous calls). No Math.max
    // needed — the front only ever moves forward.
    const newWatermark = batchLastSeq;

    const applied = await this.mutateMemory(async (current) => {
      const shadow = structuredClone(current);
      let appliedCount = 0;

      // Timeline fields are checkpoint units (narrative beats), not event
      // seqs: classifySetup's age math compares them against the checkpoint
      // counter (audit finding 3).
      const nowCheckpoint = current.checkpointCount;

      // 1) Episode
      if (outcome.episode !== null) {
        shadow.recentEpisodeIds.unshift(outcome.episode.id);
        if (shadow.recentEpisodeIds.length > MAX_RECENT_EPISODE_IDS) {
          shadow.recentEpisodeIds = shadow.recentEpisodeIds.slice(
            0,
            MAX_RECENT_EPISODE_IDS,
          );
        }
        appliedCount += 1;
      }

      // 2) Thread ops (shared pure apply; timeline in checkpoint units)
      for (const op of outcome.threadOps) {
        applyThreadOpToState(shadow, op, nowCheckpoint);
        appliedCount += 1;
      }

      // 3) Setup ops
      for (const op of outcome.setupOps) {
        applySetupOpToState(shadow, op, nowCheckpoint);
        appliedCount += 1;
      }

      // --- Advance state (on the shadow) ---
      shadow.revision += 1;
      shadow.consolidatedThroughEventSeq = newWatermark;

      // Persist — saveState is the commit point and goes first. Any
      // failure: memory untouched, full batch requeued.
      try {
        await this.store.saveState(shadow);
        if (outcome.episode !== null) {
          await this.store.appendEpisodes([outcome.episode]);
          // In-memory episode list swaps in sync with the state, inside
          // the chain, so a concurrent writer cannot lose either half.
          this.episodes = [...this.episodes, outcome.episode];
        }
      } catch (err) {
        this.pendingEvents = [...pending, ...this.pendingEvents];
        this.lastConsolidateAt = Date.now();
        this.diagnostics.warn(
          "NarrativeDirector",
          `persist failed, batch requeued: ${String(err)}`,
        );
        return { applied: 0, failed: true } as const;
      }

      // Everything persisted → swap in the new state.
      // final review P3: checkpoint() 在克隆与交换之间同步递增时，保留该增量
      shadow.checkpointCount = this.memory.checkpointCount;
      this.memory = shadow;
      return { applied: appliedCount, failed: false } as const;
    });

    if (applied.failed) {
      return { applied: 0, rejected: [] };
    }
    if (rejected.length > 0) {
      await this.recordRejectedOps(rejected);
    }
    this.lastConsolidateAt = Date.now();
    return { applied: applied.applied, rejected };
  }

  // -----------------------------------------------------------------------
  // flush — normal shutdown drain (audit P1-7)
  // -----------------------------------------------------------------------

  /**
   * flush（audit P1-7）——正常关停：整理最后的 pending 事件、等待在飞写入
   * 落定、并重试计划落盘。幂等；可安全地在任意时刻调用。
   */
  async flush(): Promise<void> {
    if (this.hasConsolidator && this.pendingEvents.length > 0) {
      await this.consolidatePending();
    }
    await this.memoryWriteChain; // 等在链内所有写入（含在飞 consolidation）落定
    if (this.plan !== undefined) {
      try {
        await this.store.savePlan(this.plan);
      } catch (err) {
        this.diagnostics.warn(
          "NarrativeDirector",
          `flush savePlan failed: ${String(err)}`,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Director plan lifecycle (Task 8)
  // -----------------------------------------------------------------------

  private maybeReplan(): void {
    if (!this.hasPlanner || this.planRunning) return;
    if (this.plan === undefined) {
      this.startReplan();
      return;
    }
    const ahead = this.config.plan.replan_ahead_checkpoints;
    const needsReplan =
      this.memory.checkpointCount > this.plan.expiresAfterCheckpoint ||
      (this.memory.revision > this.plan.basedOnMemoryRevision &&
        this.memory.checkpointCount >=
          this.plan.expiresAfterCheckpoint - ahead);
    if (needsReplan) this.startReplan();
  }

  private startReplan(): void {
    // NOTE (Task 8 deviation from the plan draft): replan() itself flips
    // planRunning synchronously before its first await, so setting it here
    // first would make the guard inside replan() early-return and wedge
    // planRunning true forever (the scheduled plan would never be created).
    // This mirrors the maybeSchedule/consolidatePending pattern: the
    // public method owns its own running flag.
    void this.replan().catch((err: unknown) => {
      this.diagnostics.warn(
        "NarrativeDirector",
        `scheduled replan error: ${String(err)}`,
      );
    });
  }

  /** Public for testability — same pattern as consolidatePending. */
  async replan(): Promise<void> {
    if (!this.hasPlanner || this.planRunning) return;
    this.planRunning = true;
    try {
      const outcome = await this.planner.plan({
        events: [...this.recentCommittedEvents],
        memory: this.memory,
        currentPlan: this.plan,
        anchorOrderById: this.seedAnchorOrder,
        location: this.lastBriefRequest?.location ?? "",
        characters: this.lastBriefRequest?.characters ?? [],
      });

      if (outcome.plan === null) {
        if (outcome.rejected.length > 0) {
          await this.recordRejectedOps(outcome.rejected);
        }
        return; // 旧计划继续生效；下一次 checkpoint 重试
      }

      // 锚点推进：走内存写互斥，链内重新读取最新 memory
      await this.mutateMemory(async (current) => {
        const shadow = structuredClone(current);
        let appliedAny = false;
        for (const op of outcome.anchorOps) {
          // Re-validate against the chain-latest anchor state; ops that no
          // longer apply (e.g. an anchor another writer already reached)
          // are silently skipped.
          if (validateAnchorOp(op, shadow.anchors) === null) {
            applyAnchorOpToState(shadow, op);
            appliedAny = true;
          }
        }
        if (!appliedAny) return;
        shadow.revision += 1;
        await this.store.saveState(shadow); // 提交点；失败 → 链 reject → 计划不换
        // final review P3: checkpoint() 在克隆与交换之间同步递增时，保留该增量
        shadow.checkpointCount = this.memory.checkpointCount;
        this.memory = shadow;
      });

      // 计划激活时以链内最新内存为准重新锚定（final review P2）：
      // 生成期间 consolidation 可能已推进 checkpointCount/revision。
      outcome.plan.expiresAfterCheckpoint =
        this.memory.checkpointCount + this.config.plan.horizon_checkpoints;
      outcome.plan.basedOnMemoryRevision = this.memory.revision;

      this.plan = outcome.plan;
      try {
        await this.store.savePlan(outcome.plan); // 失败仅记日志，内存计划照常生效
      } catch (err) {
        this.diagnostics.warn(
          "NarrativeDirector",
          `savePlan failed (plan still active in memory): ${String(err)}`,
        );
      }
      if (outcome.rejected.length > 0) {
        await this.recordRejectedOps(outcome.rejected);
      }
    } finally {
      this.planRunning = false;
    }
  }

  /**
   * 串行化所有"读 this.memory → 计算 shadow → saveState → swap"的内存写。
   * fn 在链内执行并收到**链内最新**的 this.memory；返回的 T 透传给调用方。
   * The chain itself never rejects (only the caller's promise does), so a
   * failed write cannot wedge subsequent writers.
   */
  private mutateMemory<T>(
    fn: (state: NarrativeMemoryState) => Promise<T>,
  ): Promise<T> {
    const run = this.memoryWriteChain.then(() => fn(this.memory));
    this.memoryWriteChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Debug-log rejected ops to the store; failures are warn-only and never
   * part of the memory commit (shared by consolidatePending and replan).
   */
  private async recordRejectedOps(ops: RejectedOp[]): Promise<void> {
    try {
      await this.store.appendOps(ops);
    } catch (err) {
      this.diagnostics.warn(
        "NarrativeDirector",
        `appendOps failed (debug log only): ${String(err)}`,
      );
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

}
