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
import type { CharacterRegistry } from "../../core/characters/types.js";
import type {
  NarrativeMemoryState,
  PlotThread,
  SetupPayoff,
  StoryAnchorState,
  EpisodeMemory,
  Lesson,
  FactRecord,
  ConsolidationFailedInterval,
} from "../../core/narrative/memory-types.js";
import {
  VALID_THREAD_TRANSITIONS,
} from "../../core/narrative/memory-types.js";
import type {
  ThreadOp,
  SetupOp,
  RejectedOp,
  AuditFinding,
  IdentityValidationIssue,
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

/** §6.2 issues 的简短渲染（诊断日志用：path=value（code）分号连接）。 */
function formatIdentityIssuesBrief(
  issues: readonly IdentityValidationIssue[],
): string {
  return issues
    .map((issue) => `${issue.path}=${issue.value}（${issue.code}）`)
    .join("；");
}

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
    story_plan_path: raw.story_plan_path ?? d.story_plan_path,
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
    /** C8 §6.2：registry 在场时记忆整理请求携带身份视图与证据投影。 */
    registry?: CharacterRegistry;
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
      ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
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
      // §6.2 M2：失败整理区间随会话恢复——已降级区间不再重试，成功水位
      // 仍停在缺口前。
      consolidationFailedIntervals: [...loadedState.consolidationFailedIntervals],
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
    // §6.2 M2：读取/尝试游标与成功水位分离——降级区间的事件已消耗（不再
    // 重试），恢复重放把它们再喂一遍时必须被过滤；成功整理的水位之下
    // 同样过滤（既有语义）。空过滤结果无需补发终局报告（首次提交时已触发）。
    const attemptCursor = this.attemptThroughEventSeq();
    const freshEvents = events.filter((event) => event.seq > attemptCursor);
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
   * §6.2 M2 读取/尝试游标：max(成功水位, 降级区间末尾)。成功水位
   * （consolidatedThroughEventSeq）只覆盖连续成功前沿；降级区间虽未成功，
   * 其事件也已消耗（有限重试耗尽）——两者都不得再次入队。
   */
  private attemptThroughEventSeq(): number {
    let cursor = this.memory.consolidatedThroughEventSeq;
    for (const interval of this.memory.consolidationFailedIntervals) {
      cursor = Math.max(cursor, interval.toSeq);
    }
    return cursor;
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
    let outcome = await this.consolidator.consolidate(
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

    // --- §6.2 M2：身份/引用非法的提案不等于 no-op——整批不提交 ---
    // 最多 1 次定向修复（同一批次携带上一次 issues 重试）；仍失败则记录
    // 失败区间并降级：本批事件不再重试，播放继续，成功水位停在缺口前。
    // 修复 ROOT CAUSE #1：此前身份被拒批次带着非空 result 一路流到水位
    // 推进，把非法区间标记成了「已成功提取」。
    if (outcome.identityIssues.length > 0) {
      const firstAttemptRejected = [...outcome.rejected];
      this.diagnostics.warn(
        "NarrativeDirector",
        `记忆提案身份/引用非法（§6.2 整批不提交）：${formatIdentityIssuesBrief(outcome.identityIssues)}；尝试定向修复`,
      );
      const repaired = await this.consolidator.consolidate(
        batch,
        this.memory,
        this.lastBriefRequest?.location ?? "",
        this.lastBriefRequest?.characters ?? [],
        { priorIssues: outcome.identityIssues },
      );
      if (repaired.result !== null && repaired.identityIssues.length === 0) {
        // 定向修复成功：以修复结果继续（首试拒绝留审计痕）。episode id
        // 由 revision 派生——revision 未动，两次尝试生成同一 id，幂等。
        if (firstAttemptRejected.length > 0) {
          await this.recordRejectedOps(firstAttemptRejected);
        }
        outcome = repaired;
      } else {
        // 修复仍失败（身份仍非法或提取失败）：降级。失败区间入 state 并
        // 持久化；本批事件不回队（有限重试已耗尽）；更新溢出事件照常
        // 留待后续批次（后续批次可处理，但水位不得越过缺口）。
        this.lastConsolidateAt = Date.now();
        if (overflow.length > 0) {
          this.pendingEvents = [...overflow, ...this.pendingEvents];
        }
        await this.recordDegradedInterval(
          batch,
          repaired.identityIssues.length > 0
            ? repaired.identityIssues
            : outcome.identityIssues,
          [...firstAttemptRejected, ...repaired.rejected],
        );
        return {
          applied: 0,
          rejected:
            repaired.rejected.length > 0
              ? repaired.rejected
              : firstAttemptRejected,
        };
      }
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
    // §6.2 M2：连续成功水位不越过未解决缺口——本批区间内存在降级区间时
    // 水位停在缺口前（缺口不能被标记为已成功提取；后续批次照常应用）。
    // 降级区间的事件已从队列消耗，批区间可以跳过缺口开始，所以这里的
    // FIFO 连续性保证不再无条件成立。
    const currentWatermark = this.memory.consolidatedThroughEventSeq;
    const blockingGap = this.memory.consolidationFailedIntervals.some(
      (interval) =>
        interval.fromSeq > currentWatermark && interval.fromSeq <= batchLastSeq,
    );
    const newWatermark = blockingGap ? currentWatermark : batchLastSeq;

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
   * §6.2 M2：记录降级的失败整理区间（定向修复耗尽）。区间入 state（经
   * memory-write 链，与其它内存写串行）并持久化；两次尝试的被拒提案走
   * 既有 appendOps/lessons 审计通道。降级区间是诊断级状态：持久化失败
   * 只告警不回滚——会话内语义（不再重试、水位不越过缺口）保持一致。
   */
  private async recordDegradedInterval(
    batch: readonly StoredEvent[],
    issues: readonly IdentityValidationIssue[],
    auditRejected: RejectedOp[],
  ): Promise<void> {
    const fromSeq = batch[0]!.seq;
    const toSeq = batch[batch.length - 1]!.seq;
    const interval: ConsolidationFailedInterval = {
      fromSeq,
      toSeq,
      attempts: 2,
      status: "degraded",
    };
    await this.mutateMemory(async (current) => {
      const shadow = structuredClone(current);
      shadow.consolidationFailedIntervals.push(interval);
      try {
        await this.store.saveState(shadow);
      } catch (err) {
        this.diagnostics.warn(
          "NarrativeDirector",
          `degraded interval persist failed (kept in memory): ${String(err)}`,
        );
      }
      this.memory = shadow;
    });
    this.diagnostics.warn(
      "NarrativeDirector",
      `记忆区间 [${fromSeq},${toSeq}] 定向修复后仍被拒，降级（不再重试；成功水位停在缺口前）：` +
        `${formatIdentityIssuesBrief(issues)}`,
    );
    if (auditRejected.length > 0) {
      await this.recordRejectedOps(auditRejected);
    }
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
