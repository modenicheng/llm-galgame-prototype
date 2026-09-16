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
  Lesson,
  FactRecord,
} from "../../core/narrative/memory-types.js";
import {
  VALID_THREAD_TRANSITIONS,
} from "../../core/narrative/memory-types.js";
import type {
  ThreadOp,
  SetupOp,
  RejectedOp,
  AuditFinding,
} from "../../core/narrative/memory-operation.js";
import type {
  MemoryProjection,
  MemoryProjectionRequest,
} from "../../core/narrative/memory-projection.js";
import { memoryDigestFromState, memoryStateFromDigest } from "../../core/graph/memory-digest.js";
import type { MemoryDigest } from "../../core/graph/types.js";
import {
  applyThreadOpToState,
  applySetupOpToState,
  applyFactOpToState,
  applyBeliefOpToState,
  setupPrerequisitesSatisfied,
} from "./memory-validator.js";
import {
  computeCurrentAnchorId,
  scheduleSetups,
} from "./setup-scheduler.js";
import { retrieveEpisodes } from "./episode-retriever.js";
import { retrieveFacts } from "./fact-retriever.js";
import { LessonService } from "./lesson-service.js";
import { buildEndingReport } from "./ending-report.js";
import {
  MemoryConsolidator,
  ACTIVE_THREAD_STATUSES,
  factId,
  beliefId,
} from "./memory-consolidator.js";
import type {
  MemoryConsolidatorPort,
  ConsolidationOutcome,
} from "./memory-consolidator.js";

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
    lessons: { ...d.lessons, ...raw.lessons },
    facts: { ...d.facts, ...raw.facts },
    beliefs: { ...d.beliefs, ...raw.beliefs },
    consolidation: { ...d.consolidation, ...raw.consolidation },
    brief: { ...d.brief, ...raw.brief },
    confluence: { ...d.confluence, ...raw.confluence },
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

  // In-memory consolidated state
  private memory!: NarrativeMemoryState;
  private episodes: EpisodeMemory[] = [];

  // 教训库（记忆 spec §7，MA-A）：rejection 晋升 + brief 规避清单来源。
  private readonly lessonService: LessonService;

  // 终局报告单飞（§8.4）：EndEvent 可能经重放多次到达，幂等覆盖写。
  private endingReportRunning = false;

  // Pending events not yet consolidated
  private pendingEvents: StoredEvent[] = [];

  // Director plan lifecycle (Task 8)
  private lastBriefRequest: MemoryProjectionRequest | undefined;

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
    plan: StoryPlan;
    diagnostics?: DiagnosticSink;
  }) {
    this.config = normalizeNarrativeConfig(opts.config);
    this.lessonService = new LessonService(this.config);
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
      facts: [...loadedState.facts],
      beliefs: [...loadedState.beliefs],
    };

    this.episodes = [...loadedEpisodes];

    // 教训库：载入既有 lessons（MA-A §7.3；晋升序号在其之上继续）。
    // 载入失败降级为空——lessons 是诊断数据，不得阻塞会话启动。
    try {
      this.lessonService.load(await this.store.loadLessons());
    } catch (err) {
      this.diagnostics.warn(
        "NarrativeDirector",
        `loadLessons failed (degraded to empty): ${String(err)}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // getBrief — synchronous digest
  // -----------------------------------------------------------------------

  getMemoryProjection(request: MemoryProjectionRequest): MemoryProjection {
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
      this.config.setups.max_untouched_checkpoints,
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

    this.lastBriefRequest = request;

    const projection: MemoryProjection = {
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
      // 规避清单（§7.3）：纯内存切片，零 await（§11 红线）。
      avoidanceLessons: this.lessonService.briefLessons(),
      // 相关既定事实（§5.3）+ 在场角色认知（§6.2）：纯内存数组扫描。
      relatedFacts: retrieveFacts(this.memory.facts, {
        characters: request.characters,
        location: request.location,
        max: this.config.facts.brief_max,
      }),
      characterBeliefs: this.memory.beliefs.filter(
        (b) =>
          b.status === "active" &&
          (request.characters.length === 0 ||
            request.characters.includes(b.characterId)),
      ),
    };
    return projection;
  }

  // -----------------------------------------------------------------------
  // memory digest — 快照真源（M1.1 决议）
  // -----------------------------------------------------------------------

  getMemoryDigest(): MemoryDigest {
    return memoryDigestFromState(this.memory);
  }

  restoreFromDigest(digest: MemoryDigest): void {
    // digest 是决策时点的完整记忆快照，原样重建即可——initialize 的 plan
    // 种子合并只服务于全新开局；恢复时已演化过的 lifecycle（status/计数）
    // 不允许被种子回滚。episodes 缓存从空重新积累（M1.1 决议）。
    this.memory = memoryStateFromDigest(digest);
    this.episodes = [];
    this.pendingEvents = [];
  }

  // -----------------------------------------------------------------------
  // observeCommitted
  // -----------------------------------------------------------------------

  observeCommitted(events: readonly StoredEvent[]): void {
    const watermark = this.memory.consolidatedThroughEventSeq;
    const freshEvents = events.filter((event) => event.seq > watermark);
    if (freshEvents.length === 0) {
      // 恢复重放会把水位之下的事件再喂一遍——即便全部过期，终局事件也
      // 已在首次提交时触发过报告；此处无需补发。
      return;
    }
    // 终局报告（§8.4）：EndEvent 正式提交后异步聚合，不阻塞播放（红线）。
    if (freshEvents.some((event) => event.type === "end")) {
      void this.writeEndingReport().catch((err: unknown) => {
        this.diagnostics.warn(
          "NarrativeDirector",
          `ending report failed: ${String(err)}`,
        );
      });
    }
    this.pendingEvents.push(...freshEvents);
    this.maybeSchedule();
  }

  /**
   * 终局报告（§8.4，MA-A）：确定性聚合当前 memory + lessons，写
   * `ending-report.json`。fire-and-forget（调用方 catch）；单飞防抖，
   * 幂等覆盖写——重放/多周目重复触发安全。
   */
  async writeEndingReport(): Promise<void> {
    if (this.endingReportRunning) return;
    this.endingReportRunning = true;
    try {
      const report = buildEndingReport(
        this.memory,
        this.lessonService.all(),
        new Date().toISOString(),
      );
      await this.store.writeEndingReport(report);
    } finally {
      this.endingReportRunning = false;
    }
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
      // Timeline fields are checkpoint units (narrative beats), not event
      // seqs: classifySetup's age math compares them against the checkpoint
      // counter (audit finding 3).
      const nowCheckpoint = current.checkpointCount;
      const { appliedCount, newFacts } = this.applyOutcomeToShadow(
        shadow,
        outcome,
        nowCheckpoint,
        current.revision + 1,
      );

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
        if (newFacts.length > 0) {
          // facts.jsonl append-only 留痕（§5.3）；facts 真源随 state 快照走。
          await this.store.appendFacts(newFacts);
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
    if (outcome.findings.length > 0) {
      await this.recordFindings(outcome.findings);
    }
    this.lastConsolidateAt = Date.now();
    return { applied: applied.applied, rejected };
  }

  /**
   * 把已校验的 consolidation 结果应用到 shadow（纯内存、原地修改）。
   * fact/belief id 与 consolidator 校验循环同一确定性公式（revision 派生，
   * 重放幂等）；checkpoint 用本批真实值。返回应用计数与本批新 facts
   * （供 facts.jsonl 留痕）。
   */
  private applyOutcomeToShadow(
    shadow: NarrativeMemoryState,
    outcome: ConsolidationOutcome,
    nowCheckpoint: number,
    idRevision: number,
  ): { appliedCount: number; newFacts: FactRecord[] } {
    let appliedCount = 0;

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

    // 4) Fact ops（§5.2，MA-B）
    let factSeq = 0;
    const newFacts: FactRecord[] = [];
    for (const op of outcome.factOps) {
      applyFactOpToState(shadow, op, factId(idRevision, ++factSeq), nowCheckpoint);
      newFacts.push(shadow.facts[shadow.facts.length - 1]!);
      appliedCount += 1;
    }

    // 5) Belief ops（§6.1，MA-B）：correct 解析目标后追加新认知。
    let beliefSeq = 0;
    for (const op of outcome.beliefOps) {
      applyBeliefOpToState(shadow, op, beliefId(idRevision, ++beliefSeq), nowCheckpoint);
      appliedCount += 1;
    }

    return { appliedCount, newFacts };
  }

  // -----------------------------------------------------------------------
  // flush — normal shutdown drain (audit P1-7)
  // -----------------------------------------------------------------------

  /**
   * flush（audit P1-7）——正常关停：整理最后的 pending 事件、等待在飞写入
   * 落定、并重试计划落盘。幂等；可安全地在任意时刻调用。
   */
  async flush(): Promise<void> {
    // C6: pending 为空但 consolidation 仍在飞（批在开始时已排空、LLM 调用
    // 尚在跑）时也必须等它——consolidatePending 的单飞分支会返回在飞
    // promise。否则 shutdown/restart 会在写入落定前返回，与 saveState 竞速。
    if (
      this.hasConsolidator &&
      (this.pendingEvents.length > 0 || this.consolidateRunning)
    ) {
      await this.consolidatePending();
    }
    await this.memoryWriteChain; // 等在链内所有写入（含在飞 consolidation）落定
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
   * MA-A：被拒 op 同时喂教训库（§7.2 来源 2，同规则 ≥ 阈值自动晋升），
   * 新晋升/累加的 lessons 同通道落盘（失败仅告警，不回滚内存）。
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
    try {
      const promoted = this.lessonService.observeRejections(
        ops,
        this.memory.checkpointCount,
      );
      if (promoted.length > 0) {
        await this.store.appendLessons(promoted);
      }
    } catch (err) {
      this.diagnostics.warn(
        "NarrativeDirector",
        `lesson promotion failed: ${String(err)}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Internal: scheduling
  // -----------------------------------------------------------------------

  /**
   * MA-B（§9.2/§9.3）：findings 全量落 narrative-ops.jsonl 留痕（复用被拒 op
   * 通道的文件）；critical/major 自动蒸馏成 lesson（§7.2 来源 1），下批 brief
   * 规避清单即生效。失败仅告警，绝不参与记忆提交。
   */
  private async recordFindings(findings: readonly AuditFinding[]): Promise<void> {
    try {
      await this.store.appendOps(
        findings.map((f) => ({
          kind: "finding" as const,
          op: f,
          reason: `[FINDING:${f.severity}] ${f.content}`,
        })),
      );
    } catch (err) {
      this.diagnostics.warn(
        "NarrativeDirector",
        `appendOps(findings) failed: ${String(err)}`,
      );
    }
    const promoted: Lesson[] = [];
    for (const finding of findings) {
      if (finding.severity !== "critical" && finding.severity !== "major") continue;
      promoted.push(
        this.lessonService.promote(
          finding.dimension,
          finding.content.slice(0, 100),
          "audit",
          finding.subject,
          this.memory.checkpointCount,
        ),
      );
    }
    if (promoted.length > 0) {
      try {
        await this.store.appendLessons(promoted);
      } catch (err) {
        this.diagnostics.warn(
          "NarrativeDirector",
          `appendLessons(findings) failed: ${String(err)}`,
        );
      }
    }
  }

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
