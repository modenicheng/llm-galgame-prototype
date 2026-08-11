import type { AppConfig } from "./config.js";
import { InputEngine } from "./interaction/input-engine.js";
import { AsyncEventQueue } from "./core/runtime/async-event-queue.js";
import { InputBridgeBuffer } from "./core/interaction/input-bridge.js";
import {
  InputResponseSession,
} from "./core/interaction/input-session.js";
import type { RuntimeCommand } from "./core/runtime/runtime-command.js";
import type {
  RuntimeOutput,
  StagePresentationDelta,
} from "./core/runtime/runtime-output.js";
import type { ClockPort } from "./core/ports/clock-port.js";
import {
  silentDiagnosticSink,
  type DiagnosticSink,
} from "./core/ports/diagnostic-sink.js";
import type { IdGeneratorPort } from "./core/ports/id-generator-port.js";
import type {
  SessionStorePort,
} from "./core/ports/session-store-port.js";
import type { StoryGenerator } from "./adapters/llm/openai-compatible-generator.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import type { NarrativeDirectorPort } from "./core/ports/narrative-director-port.js";
import type { NarrativeBrief } from "./core/narrative/narrative-brief.js";
import { BranchManager } from "./runtime/branch-manager.js";
import type { LiveBranchSelection } from "./prefetch.js";
import { GenerationScheduler } from "./runtime/generation-scheduler.js";
import { Metrics } from "./runtime/metrics.js";
import type { MetricsSnapshot } from "./runtime/metrics.js";
import { PlaybackBuffer } from "./runtime/playback-buffer.js";
import { compileEventGroup } from "./core/protocol/gal-dsl/compiler.js";
import type {
  AssetDiagnostic,
  DslInteractionDraft,
  EventGroupDraft,
  SegmentEndStatus,
} from "./core/protocol/gal-dsl/types.js";
import type { AssetCatalog } from "./core/assets/types.js";
import { toCharacterRegistry } from "./core/assets/catalog.js";
import {
  createDefaultsFromRegistry,
  createInitialVisualState,
} from "./core/presentation/defaults.js";
import { createVisualStateReducer } from "./core/presentation/reducer.js";
import type {
  CharacterRegistry,
  CharacterRegistryEntry,
  PresentationDefaults,
  StageCue,
  VisualState,
} from "./core/presentation/types.js";
import type {
  ChoiceEvent,
  ChoiceOption,
  EndEvent,
  HybridInteraction,
  InputInteraction,
  InteractionEvent,
  PlayerDialogueEvent,
  RuntimeModelEvent,
  RuntimePlayableEvent,
  RuntimeBufferEvent,
  RuntimeDialogueEvent,
  RuntimeNarrationEvent,
  StoredEvent,
  StoredModelEvent,
  StoredPlayerChoiceEvent,
  StoredPlayerDialogueEvent,
  StoredPlayerInputEvent,
  StoryContextEvent
} from "./schema.js";
import { isPlayableEvent } from "./schema.js";
import { InteractionPolicy } from "./story/interaction-policy.js";
import type { InteractionMode, InputSpec } from "./story/types.js";
import { applyPatch } from "./story/patch.js";
import { createInitialState } from "./story/state.js";
import type {
  GeneratedEvent,
  StoryState,
  StoryStatePatch,
} from "./story/types.js";
import type { RuntimeStatus } from "./status.js";

interface ActiveSegment {
  turn: number;
  taskId: string;
  events: RuntimeModelEvent[];
  queue: AsyncEventQueue<RuntimeModelEvent>;
  done: Promise<void>;
  branchManager: BranchManager | null;
  terminal: RuntimeModelEvent | null;
  schedulerReleased: boolean;
  /**
   * DSL mode: set when the segment ends cleanly with `@end ... buffer`
   * (docs §46/§76). A clean buffer end is NOT a failure.
   */
  endStatus: SegmentEndStatus | null;
  /**
   * Set when the segment's generation task settles with a rejection
   * (segment.done rejected). The advance-trigger must not start a low-water
   * refill while the current segment has failed — the repair path is about
   * to take over the single-slot generation scheduler, and a concurrent
   * refill would make startActivePath throw and kill run() (and waste a
   * generation call).
   */
  failed: boolean;
}

type ActiveSegmentKind = "opening" | "continuation";

interface ChoiceOutcome {
  type: "choice";
  nextTurn: number;
  preview: RuntimePlayableEvent[];
  liveSelection?: LiveBranchSelection;
  /** Response stream still running after input confirm (live promotion). */
  liveResponse?: InputResponseSession;
}

type ChoiceSelection = Pick<ChoiceOutcome, "preview" | "liveSelection">;

/**
 * Result of committing an input: the committed prefix plus optional live
 * stream, or — hybrid only — a preview-cancel sentinel that returns control
 * to the hybrid loop so the full form (options + input) stays armed (§11.7).
 */
type InputCommitOutcome =
  | {
      type: "committed";
      preview: RuntimePlayableEvent[];
      liveResponse?: InputResponseSession;
    }
  | { type: "canceled" };

/** Structural contract for live-consumable streams. */
interface LiveStreamLike {
  events: readonly RuntimePlayableEvent[];
  done: Promise<unknown>;
  subscribe(listener: (event: RuntimePlayableEvent) => void): () => void;
}

interface EndOutcome {
  type: "end";
}

/**
 * DSL mode: the segment ended cleanly with `@end ... buffer` — no terminal
 * event, the story simply pauses for a low-water refill (docs §46, §76).
 */
interface BufferOutcome {
  type: "buffer";
  nextTurn: number;
}

type SegmentOutcome = ChoiceOutcome | EndOutcome | BufferOutcome;

/**
 * Host-provided ports. The Game receives concrete adapters (Node CLI
 * wires file store / system clock; tests wire in-memory fakes).
 */
export interface GamePorts {
  store: SessionStorePort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  /** Session id for this game instance (narrative memory binds to it).
   * Omitted → generated from `ids`. */
  sessionId?: string;
  diagnostics?: DiagnosticSink;
  narrativeDirector?: NarrativeDirectorPort;
}

/** Raised when the driver sends `shutdown`. */
export class RuntimeShutdownError extends Error {
  constructor() {
    super("运行时已收到关闭指令");
    this.name = "RuntimeShutdownError";
  }
}

/** Raised when a generated interaction violates InteractionPolicy (§8.5). */
export class InteractionPolicyViolationError extends Error {
  constructor(reason: string) {
    super(`InteractionPolicy 拒绝：${reason}`);
    this.name = "InteractionPolicyViolationError";
  }
}

/** §8.4: keep only the most recent formally-opened interaction modes. */
const MAX_INTERACTION_MODE_HISTORY = 8;

/** Registry fallback when no asset catalog is wired. */
const emptyRegistry: CharacterRegistry = {
  resolveByScriptName(): undefined {
    return undefined;
  },
  resolveById(): undefined {
    return undefined;
  },
  entries(): CharacterRegistryEntry[] {
    return [];
  },
};

export class Game {
  private readonly events: StoredEvent[] = [];
  private readonly buffered = new Map<string, RuntimePlayableEvent>();
  private seq = 1;
  private readonly sessionId: string;
  private readonly store: SessionStorePort;
  private readonly clock: ClockPort;
  private readonly ids: IdGeneratorPort;
  private readonly diagnostics: DiagnosticSink;
  private readonly inputEngine = new InputEngine();
  private readonly bridgeBuffer = new InputBridgeBuffer();
  /** line_ids of bridge narration currently staged for playback. */
  private readonly bridgeLineIds = new Set<string>();
  /** line_ids of staged input response events (for bridge-cover timing). */
  private readonly responseLineIds = new Set<string>();
  private readonly interactionPolicy: InteractionPolicy;
  /** §8.4: modes of formally opened interactions, newest last (cap 8). */
  private readonly recentInteractionModes: InteractionMode[] = [];
  /** Confirm timestamp awaiting the first response line (E3/G1 metric). */
  private inputConfirmAtMs: number | null = null;
  /** Bridge playback start awaiting the first response line play. */
  private bridgePlayStartedAtMs: number | null = null;
  private storyState: StoryState;
  private readonly metrics: Metrics;
  private choiceTimestamp: number | null = null;
  private readonly narrativeDirector: NarrativeDirectorPort | undefined;
  private readonly playbackBuffer = new PlaybackBuffer();
  private readonly generationScheduler = new GenerationScheduler();
  /**
   * §75：低水位触发时已启动、待 run loop 接管的续写段。
   */
  private pendingRefillSegment: ActiveSegment | null = null;
  /** 当前正在播放的段 turn（reconcileTextBuffer 计算续写 turn 用）。 */
  private activeSegmentTurn = 1;
  private readonly commands = new AsyncEventQueue<RuntimeCommand>();
  private readonly deferredCommands: RuntimeCommand[] = [];

  // ------------------------------------------------------------------
  // DSL visual state (docs §52–§56)
  // ------------------------------------------------------------------
  private readonly catalog: AssetCatalog | undefined;
  private readonly registry: CharacterRegistry;
  private readonly defaults: PresentationDefaults;
  private readonly reduce: (state: VisualState, cues: StageCue[]) => VisualState;
  /**
   * Predictive state after everything committed to the buffer — what the
   * next generation must see (docs §54–§55). Updated at group commit.
   */
  private tailVisualState: VisualState = createInitialVisualState();
  /**
   * What the player actually sees. Updated when a group's cues play
   * (docs §54–§55). Never runs ahead of playback.
   */
  private renderedVisualState: VisualState = createInitialVisualState();
  /** Stage cues of interaction groups, applied when the form opens. */
  private readonly pendingInteractionStage = new Map<string, StageCue[]>();
  /** Per-branch tail state (docs §56): keyed by option id. */
  private readonly branchTailStates = new Map<string, VisualState>();
  /** Input-bridge prefetch controllers, keyed by interaction id. */
  private readonly bridgeControllers = new Map<string, AbortController>();
  /**
   * §10.2: interaction currently open for commands, set on
   * `interaction_opened` and cleared when the interaction resolves.
   */
  private activeInteractionId: string | null = null;
  /**
   * §10.2: input preview currently open for confirm/cancel, set on
   * `input_preview_opened` and cleared on cancel/confirm.
   */
  private activePreviewId: string | null = null;
  private readonly listeners = new Set<(output: RuntimeOutput) => void>();

  constructor(
    private readonly config: AppConfig,
    private readonly generator: StoryGenerator,
    private readonly status: RuntimeStatus,
    private readonly media: MediaPlannerPort,
    metrics: Metrics | undefined,
    ports: GamePorts,
    catalog?: AssetCatalog,
  ) {
    this.metrics = metrics ?? new Metrics();
    this.store = ports.store;
    this.clock = ports.clock;
    this.ids = ports.ids;
    this.diagnostics = ports.diagnostics ?? silentDiagnosticSink;
    this.narrativeDirector = ports.narrativeDirector;
    this.sessionId = ports.sessionId ?? this.ids.nextSessionId();
    this.interactionPolicy = new InteractionPolicy(config.interaction);
    this.storyState = createInitialState();
    this.catalog = catalog;
    this.registry = catalog ? toCharacterRegistry(catalog) : emptyRegistry;
    this.defaults = createDefaultsFromRegistry(this.registry);
    this.reduce = createVisualStateReducer(this.defaults);
    this.status.subscribe((snapshot) => {
      this.emit({ type: "status_changed", status: snapshot });
    });
  }
  /** Send a command to the runtime. Safe to call from output listeners. */
  dispatch(command: RuntimeCommand): void {
    // §10.2: drop obviously stale interaction commands at the door so a
    // resolved interaction can never accumulate commands. The authoritative
    // check still happens at the consumption point (waitForCommand), which
    // covers commands dispatched before this scope check observed the
    // resolution (e.g. two submissions in the same tick).
    if (this.isStaleInteractionCommand(command)) return;
    this.commands.push(command);
  }

  /**
   * §10.2: a command is stale when it addresses an interaction or preview
   * that is no longer the active one. Stale commands are dropped instead of
   * being parked in deferredCommands, so they cannot leak into a later
   * interaction's waiters.
   */
  private isStaleInteractionCommand(command: RuntimeCommand): boolean {
    if (command.type === "select_choice" || command.type === "preview_input") {
      return command.interactionId !== this.activeInteractionId;
    }
    if (command.type === "confirm_input" || command.type === "cancel_input") {
      return command.previewId !== this.activePreviewId;
    }
    return false;
  }
  /** Register an output listener; returns an unsubscribe function. */
  subscribe(listener: (output: RuntimeOutput) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Return an immutable snapshot of all collected runtime metrics. */
  getMetrics(): MetricsSnapshot {
    return this.metrics.snapshot();
  }

  async run(): Promise<void> {
    await this.store.initialize({ sessionId: this.sessionId });
    this.emit({
      type: "session_started",
      sessionId: this.sessionId,
      location: this.store.location,
    });

    this.status.setPhase("开场生成", "首条完整事件到达后立即进入播放缓冲");
    let segment = this.startActiveSegment("opening", 1, [], []);
    let outcome = await this.consumeActiveSegment(segment, 1, []);

    while (outcome.type !== "end") {
      // DSL mode: the segment ended cleanly with `@end ... buffer`. Its
      // events were already buffered and played while streaming; start a
      // low-water refill continuation from the committed history (docs
      // §74–§76). No new interaction is pending.
      if (outcome.type === "buffer") {
        this.activeInteractionId = null;
        this.activePreviewId = null;
        this.status.setPhase("后台续写", "缓冲段自然收束，启动续写");
        const historyBefore = [...this.events];
        // §75：低水位触发（任务收束钩子/玩家 advance）可能已提前启动续写；
        // 直接接管，否则（防御路径）现场启动。提前启动消除了
        // "读空 → 等 TTFT" 的空窗。
        const refill =
          this.pendingRefillSegment ??
          this.startActiveSegment(
            "continuation",
            outcome.nextTurn,
            historyBefore,
            [],
          );
        this.pendingRefillSegment = null;
        void refill.done.catch(() => undefined);
        const bufferTurn = outcome.nextTurn;
        segment = refill;
        outcome = await this.consumeActiveSegment(
          segment,
          bufferTurn,
          historyBefore,
        );
        if (outcome.type !== "end") {
          this.status.removeJob(`continuation:${bufferTurn}`);
        }
        await this.saveCurrentStateSnapshot();
        continue;
      }

      const currentOutcome = outcome;
      const historyBeforePreview = [...this.events];
      const speculativeContext: StoryContextEvent[] = [
        ...historyBeforePreview,
        ...currentOutcome.preview,
      ];

      // §10.2: playback start defensively clears any lingering interaction
      // scope, so a reconnecting client can never restore a resolved form.
      this.activeInteractionId = null;
      this.activePreviewId = null;
      // 分支接管后，下一段的 turn 是 currentOutcome.nextTurn；提前更新以便
      // 低水位续写在 preview 播放期间计算正确 turn。
      this.activeSegmentTurn = currentOutcome.nextTurn;
      // The selected branch is already the next active generation task. Its
      // existing events enter the formal buffer now; later events are routed
      // into the same buffer by the live task subscription. No new LLM
      // request is created until this task naturally completes.
      this.playbackBuffer.enqueueMany(currentOutcome.preview);
      for (const event of currentOutcome.preview) this.registerBuffered([event]);
      this.status.setPhase("后台续写", "已选分支接管正式路径，续写段持续流式补充");

      const continuationPromise = this.prepareContinuationAfterSelection(
        segment,
        currentOutcome,
        historyBeforePreview,
      );
      void continuationPromise.catch(() => undefined);

      if (currentOutcome.liveSelection) {
        await this.consumeLiveSelection(
          currentOutcome.preview,
          currentOutcome.liveSelection,
          currentOutcome.nextTurn,
        );
      } else if (currentOutcome.liveResponse) {
        await this.consumeLiveInputResponse(
          currentOutcome.preview,
          currentOutcome.liveResponse,
          currentOutcome.nextTurn,
        );
      } else {
        await this.consumePlayableEvents(currentOutcome.preview, currentOutcome.nextTurn);
      }
      segment = await continuationPromise;
      const selectedContext = currentOutcome.liveSelection
        ? [...historyBeforePreview, ...currentOutcome.liveSelection.events]
        : speculativeContext;
      outcome = await this.consumeActiveSegment(
        segment,
        currentOutcome.nextTurn,
        selectedContext,
      );
      this.status.removeJob(`continuation:${currentOutcome.nextTurn}`);
      await this.saveCurrentStateSnapshot();
    }
  }

  private prepareContinuationAfterSelection(
    previousSegment: ActiveSegment,
    outcome: ChoiceOutcome,
    history: StoryContextEvent[],
  ): Promise<ActiveSegment> {
    const live = outcome.liveSelection;
    const liveResponse = outcome.liveResponse;
    const waitForPrevious = previousSegment.done.catch(() => undefined);

    if (liveResponse) {
      // The confirmed response stream is still running. Its remaining events
      // join the committed prefix: player line + bridge + full response. No
      // new LLM request is created until the response task completes.
      return waitForPrevious
        .then(() => liveResponse.done.catch(() => undefined))
        .then(() => {
          const committed = [...outcome.preview];
          for (const event of liveResponse.responseEvents) {
            if (!committed.some((existing) => existing.line_id === event.line_id)) {
              committed.push(event);
            }
          }
          return this.startActiveSegment(
            "continuation",
            outcome.nextTurn,
            history,
            committed,
          );
        });
    }

    if (!live) {
      return waitForPrevious.then(() =>
        this.startActiveSegment(
          "continuation",
          outcome.nextTurn,
          history,
          outcome.preview,
        ),
      );
    }

    // The old active request may still be closing after emitting its terminal
    // event. Once it releases the scheduler, promote the existing branch
    // controller. The branch request itself is never restarted.
    return waitForPrevious
      .then(() => {
        this.generationScheduler.adoptCandidateBranch(
          live.taskId,
          live.branchId,
          live.controller,
        );
        void live.done.then(
          () => this.generationScheduler.completeActivePath(live.taskId),
          () => this.generationScheduler.completeActivePath(live.taskId),
        );
      })
      .then(() => live.done.catch(() => undefined))
      .then(() => {
        const selectedEvents = [...live.events];
        return this.startActiveSegment(
          "continuation",
          outcome.nextTurn,
          history,
          selectedEvents,
        );
      });
  }

  /**
   * §8.5/§13.1: enforce InteractionPolicy BEFORE a terminal enters the
   * formal buffer. A rejection throws, which fails the current generation
   * attempt and routes it into the repair loop; nothing (buffer, bridge,
   * BranchManager, interaction_opened) is published for the illegal event.
   */
  private assertInteractionPolicy(event: InteractionEvent): void {
    const result = this.interactionPolicy.validate(event, {
      previousModes: this.recentInteractionModes,
    });
    if (!result.accepted) {
      throw new InteractionPolicyViolationError(result.reason ?? "策略校验失败。");
    }
  }

  /**
   * §8.4: record the mode of a formally opened interaction (newest last).
   * Only accepted terminals reach this point — unselected candidates,
   * failed-repair interactions, and input-response fragments never record.
   */
  private recordInteractionMode(mode: InteractionMode): void {
    this.recentInteractionModes.push(mode);
    if (this.recentInteractionModes.length > MAX_INTERACTION_MODE_HISTORY) {
      this.recentInteractionModes.shift();
    }
  }

  private startActiveSegment(
    kind: ActiveSegmentKind,
    turn: number,
    history: StoryContextEvent[],
    prefetchedEvents: StoryContextEvent[],
    repairReason?: string,
  ): ActiveSegment {
    const queue = new AsyncEventQueue<RuntimeModelEvent>();
    const taskId = this.ids.nextGenerationId(kind === "opening" ? "opening" : `continuation:${turn}`);
    const segment: ActiveSegment = {
      turn,
      taskId,
      events: [],
      queue,
      done: Promise.resolve(),
      branchManager: null,
      terminal: null,
      schedulerReleased: false,
      endStatus: null,
      failed: false,
    };

    const controller = this.generationScheduler.startActivePath(taskId);

    // The generator emits complete EventGroupDrafts (docs §36, §63). Each
    // group is compiled (character resolution + stage cues) against the
    // current tail visual state and flattened into runtime events carrying
    // `stage`.
    const onGroup = (group: EventGroupDraft): void => {
      this.handleDslGroup(segment, history, turn, group);
    };
    const onSegmentEnd = (status: SegmentEndStatus): void => {
      this.handleSegmentEnd(segment, status, turn);
    };

    const jobId = kind === "opening" ? "opening" : `continuation:${turn}`;
    const label = kind === "opening" ? "初始剧情" : `第 ${turn} 回合后续`;
    const brief = this.makeBrief(turn);
    const dslOptions = {
      onGroup,
      onSegmentEnd,
      tailVisualState: this.tailVisualState,
      ...(brief ? { brief } : {}),
      ...(repairReason ? { repairReason } : {}),
    };
    segment.done = this.runTrackedJob(jobId, label, () => {
      const request = kind === "opening"
        ? this.generator.generateOpening(turn, this.storyState, controller.signal, dslOptions)
        : this.generator.generateContinuation(
            turn,
            this.storyState,
            history,
            prefetchedEvents,
            controller.signal,
            dslOptions,
          );

      return request.then((envelope) => {
        // Test doubles and envelope-format providers do not invoke
        // onGroup/onSegmentEnd. Preserve the same runtime behavior by
        // feeding their groups + segmentEnd here.
        if (segment.events.length === 0) {
          if (envelope.groups !== undefined && envelope.groups.length > 0) {
            for (const group of envelope.groups) onGroup(group);
            if (envelope.segmentEnd !== undefined && segment.endStatus === null) {
              onSegmentEnd(envelope.segmentEnd);
            }
          }
        }
        try {
          this.storyState = applyPatch(this.storyState, envelope.state_patch);
        } catch {
          this.metrics.recordStatePatchRejection();
        }
      });
    }).finally(() => {
      queue.close();
      if (!segment.schedulerReleased) {
        segment.schedulerReleased = true;
        this.generationScheduler.completeActivePath(segment.taskId);
      }
    });

    // Factory invariant: every segment's `done` promise must carry a handler
    // from birth. The run loop only attaches its own handler after the
    // preview playback finishes, which can be seconds after this segment
    // started generating in the background. An unhandled rejection in that
    // window (e.g. a mid-stream schema failure) would otherwise kill the
    // whole process via Node's default unhandledRejection=throw.
    void segment.done.catch(() => undefined);

    // §75：本段以 buffer 收束后立即评估低水位（不等玩家读空）——续写流
    // 与玩家阅读尾部重叠，消除段间 TTFT 空窗。带拒绝处理以保持
    // “每段 done 从出生即带 handler”的工厂不变量（失败段不产生
    // 未处理拒绝）。
    void segment.done
      .then(
        () => {
          if (
            segment.endStatus?.kind === "complete" &&
            segment.endStatus.reason === "buffer"
          ) {
            this.reconcileTextBuffer(segment.turn + 1);
          }
        },
        () => {
          // 失败段标记：advance-trigger 据此跳过低水续写（修复路径即将
          // 接管单槽调度器，杂散续写会让 startActivePath 抛错杀死 run()）。
          segment.failed = true;
        },
      )
      // MINOR D: 若 ok 回调抛错（如 reconcileTextBuffer → startActiveSegment
      // 抛错），派生 promise 会未处理拒绝——显式吞掉。
      .catch(() => undefined);

    return segment;
  }

  private async consumeActiveSegment(
    segment: ActiveSegment,
    turn: number,
    priorContext: StoryContextEvent[],
    repairBudget = Math.max(1, this.config.generation.repair_attempts),
  ): Promise<SegmentOutcome> {
    let firstPlayableSeen = false;
    // 供低水位续写计算 nextTurn（当前段 turn + 1）。
    this.activeSegmentTurn = segment.turn;
    while (true) {
      const next = await segment.queue.next();
      if (next.done) {
        // DSL mode: a clean `@end ... buffer` is a normal segment boundary
        // (docs §46/§76) — the segment is NOT a failure; the run loop
        // starts a low-water refill continuation.
        if (
          segment.endStatus?.kind === "complete" &&
          segment.endStatus.reason === "buffer"
        ) {
          return { type: "buffer", nextTurn: turn + 1 };
        }
        // The segment ended without a terminal event. This happens when the
        // underlying request failed mid-stream (network error or a schema
        // violation after events were already published). Preserve the events
        // that were generated before the failure and repair with a fresh
        // continuation request instead of crashing the whole run.
        const failure = await segment.done
          .then(() => new Error("生成段结束时没有收到 choice、interaction 或 end 事件。"))
          .catch((reason: unknown) =>
            reason instanceof Error ? reason : new Error(String(reason))
          );
        const playable = segment.events.filter(isPlayableEvent);
        // §8.5: a policy rejection is repairable even without any playable
        // prefix — the model must simply re-emit a legal interaction. Other
        // failures with nothing playable have no story to continue from and
        // stay fatal.
        const policyRejected =
          failure instanceof InteractionPolicyViolationError ||
          failure.cause instanceof InteractionPolicyViolationError ||
          failure.message.includes("InteractionPolicy 拒绝");
        if (playable.length === 0 && !policyRejected) {
          this.emit({
            type: "runtime_error",
            code: "segment_failed",
            message: failure.message,
          });
          throw failure;
        }
        // Budget exhausted is NOT fatal (author requirement): as long as
        // every repair publishes playable events — the truly fatal case (no
        // playable prefix at all) is handled above — the story keeps moving
        // along its last successful line instead of the whole run being
        // killed by a single truncated (no-@end) model output. Warn once.
        if (repairBudget === 0) {
          this.diagnostics.warn(
            "Repair",
            `修复续写预算已耗尽（${failure.message}）；继续沿最后一条成功事件续写`,
          );
        }

        // The failed segment may already have published a terminal event
        // (choice/interaction) whose branch prefetches are still running —
        // that terminal is never consumed once the stream broke. Discard the
        // orphaned prefetch group, remove its status jobs, and strip the
        // terminal event from the repair context so the repair continuation
        // does not regenerate the same interaction point. Reset the playback
        // buffer as well: any stale tail from the broken stream would
        // otherwise mismatch the repaired segment's events and crash the
        // ordering check in advanceBufferedEvent.
        segment.branchManager?.discardAll();
        this.playbackBuffer.clear();
        const terminal = segment.terminal;
        if (terminal?.type === "interaction" && terminal.mode !== "input") {
          for (const option of terminal.options) {
            this.status.removeJob(`branch:${option.id}`);
          }
          this.status.clearBranches();
        }
        const fullContext = terminal
          ? [
              ...priorContext,
              ...segment.events.filter((event) => event !== terminal),
            ]
          : [...priorContext, ...segment.events];
        this.diagnostics.info(
          "Repair",
          `生成段失败：${failure.message}，保留 ${playable.length} 条事件，启动修复续写（剩余 ${repairBudget - 1} 次）`,
        );
        this.status.setJob(`repair:${segment.taskId}`, "段失败修复续写", "running");
        try {
          const repaired = this.startActiveSegment(
            "continuation",
            turn,
            fullContext,
            playable,
            failure.message,
          );
          void repaired.done.catch(() => undefined);
          const outcome = await this.consumeActiveSegment(
            repaired,
            turn,
            fullContext,
            repairBudget - 1,
          );
          // The caller (run loop) will wait for the *original* segment's done
          // before adopting a live branch. Fully tear down the repaired
          // segment first so the generation scheduler is idle and the branch
          // controller is not aborted mid-adoption.
          await repaired.done.catch(() => undefined);
          return outcome;
        } finally {
          this.status.removeJob(`repair:${segment.taskId}`);
        }
      }

      const event = next.value;
      if (isPlayableEvent(event)) {
        if (!firstPlayableSeen) {
          firstPlayableSeen = true;
          await this.waitForStartThreshold(segment);
        }
        await this.consumePlayableEvent(event, turn, segment);
        continue;
      }

      if (event.type === "end") {
        this.advanceBufferedEvent(event);
        await this.recordModelEvent(event, turn);
        segment.branchManager?.discardAll();
        this.status.removeJob(`continuation:${turn}`);
        this.status.setPhase("结束", "剧情已经结束");
        this.emit({ type: "session_ended", ending: event });
        return { type: "end" };
      }

      this.advanceBufferedEvent(event);
      await this.recordModelEvent(event, turn);
      const context = [...priorContext, ...segment.events];
      // §8.4: the interaction is now formally opened (policy already passed
      // in handleDslGroup). Record its mode for consecutive-input tracking.
      this.recordInteractionMode(event.mode);

      if (event.mode === "choice") {
        const syntheticChoice: ChoiceEvent = {
          type: "choice",
          prompt: event.prompt,
          options: event.options.map((option) => ({ id: option.id, text: option.text })),
        };
        const preview = await this.handleChoice(syntheticChoice, turn, segment.branchManager, context, event.interaction_id);
        return { type: "choice", nextTurn: turn + 1, ...preview };
      }

      if (event.mode === "hybrid") {
        return this.handleHybridInteraction(event, turn, segment.branchManager, context);
      }

      const committed = await this.handleInteractionInput(event, turn, segment.branchManager);
      // A pure input never cancels back out of the commit loop; only the
      // hybrid path returns the canceled sentinel.
      if (committed.type !== "committed") throw new RuntimeShutdownError();
      return {
        type: "choice",
        nextTurn: turn + 1,
        preview: committed.preview,
        ...(committed.liveResponse ? { liveResponse: committed.liveResponse } : {}),
      };
    }
  }

  private emit(output: RuntimeOutput): void {
    for (const listener of this.listeners) listener(output);
  }

  /**
   * Publish `interaction_resolved` for `interactionId` — the interaction
   * can no longer be submitted from that moment on (§5.4). Callers release
   * the active interaction scope immediately after.
   */
  private resolveInteraction(
    interactionId: string,
    resolution: "choice" | "input",
  ): void {
    this.emit({ type: "interaction_resolved", interactionId, resolution });
  }

  /**
   * Await the next command matching `predicate`. Commands that do not
   * match are deferred and re-checked by later waiters — except §10.2
   * stale interaction commands, which are dropped so a resolved
   * interaction can never accumulate commands for later waiters.
   */
  private async waitForCommand(
    predicate: (command: RuntimeCommand) => boolean,
  ): Promise<RuntimeCommand> {
    // Scan the deferred list: take the first match, dropping any stale
    // interaction commands encountered on the way.
    for (let i = 0; i < this.deferredCommands.length; i++) {
      const command = this.deferredCommands[i]!;
      if (predicate(command)) {
        return this.deferredCommands.splice(i, 1)[0]!;
      }
      if (this.isStaleInteractionCommand(command)) {
        this.deferredCommands.splice(i, 1);
        i -= 1;
      }
    }
    while (true) {
      const next = await this.commands.next();
      if (next.done) throw new RuntimeShutdownError();
      const command = next.value;
      if (command.type === "shutdown") throw new RuntimeShutdownError();
      if (predicate(command)) return command;
      // The final judgment lives here: a stale interaction command is
      // dropped instead of parked in deferredCommands.
      if (this.isStaleInteractionCommand(command)) continue;
      this.deferredCommands.push(command);
    }
  }

  /**
   * §10.2: await the next interaction-scoped command for `interactionId`,
   * accepting only the given types. Commands that address another
   * interaction or a resolved interaction are dropped by waitForCommand;
   * unrelated commands (e.g. advance) are deferred as usual.
   */
  private async waitForInteractionCommand(
    interactionId: string,
    acceptedTypes: Readonly<Partial<Record<"select_choice" | "preview_input", true>>>,
  ): Promise<Extract<RuntimeCommand, { type: "select_choice" | "preview_input" }>> {
    const command = await this.waitForCommand(
      (c) =>
        (c.type === "select_choice" || c.type === "preview_input") &&
        acceptedTypes[c.type] === true &&
        c.interactionId === interactionId,
    );
    // The predicate above guarantees the accepted types; the cast narrows
    // the RuntimeCommand union for the declared return type.
    return command as Extract<
      RuntimeCommand,
      { type: "select_choice" | "preview_input" }
    >;
  }

  /**
   * Assign stable line_ids to an interaction's bridge narration and buffer
   * it. Bridge events never enter the formal event log.
   */
  private compileGroup(
    draft: EventGroupDraft,
    baseState: VisualState,
    turn: number,
  ): {
    playable: RuntimeDialogueEvent | RuntimeNarrationEvent | null;
    interaction: InteractionEvent | null;
    cues: StageCue[];
    tailState: VisualState;
  } {
    const diagnostics: AssetDiagnostic[] = [];
    const compiled = compileEventGroup(draft, {
      registry: this.registry,
      tailState: baseState,
      reduce: this.reduce,
      defaultsFor: this.defaults.defaultFor.bind(this.defaults),
      ...(this.catalog !== undefined ? { catalog: this.catalog, diagnostics } : {}),
    });
    for (const diagnostic of diagnostics) {
      this.metrics.recordAssetDiagnostic(diagnostic.code);
      console.warn(`[assets] ${diagnostic.code}: ${diagnostic.id}`);
    }
    const main = compiled.group.main;
    if (main.type === "dialogue") {
      const event: RuntimeDialogueEvent = {
        type: "dialogue",
        characterId: main.characterId,
        speaker: main.speaker,
        text: main.text,
        line_id: this.nextLineId(),
        ...(compiled.group.prelude.length > 0 ? { stage: compiled.group.prelude } : {}),
      };
      return { playable: event, interaction: null, cues: compiled.group.prelude, tailState: compiled.tailState };
    }
    if (main.type === "narration") {
      const event: RuntimeNarrationEvent = {
        type: "narration",
        text: main.text,
        line_id: this.nextLineId(),
        ...(compiled.group.prelude.length > 0 ? { stage: compiled.group.prelude } : {}),
      };
      return { playable: event, interaction: null, cues: compiled.group.prelude, tailState: compiled.tailState };
    }
    if (main.type === "interaction") {
      const interaction = this.buildRuntimeInteraction(main.interaction, turn);
      return { playable: null, interaction, cues: compiled.group.prelude, tailState: compiled.tailState };
    }
    // beat — pure stage node, no main event.
    return { playable: null, interaction: null, cues: compiled.group.prelude, tailState: compiled.tailState };
  }

  /**
   * Route one streamed DSL group into the active segment: compile it
   * against the tail state, update the predictive tail state, and either
   * buffer a playable event, open an interaction (policy-checked), or
   * apply a beat.
   */
  private handleDslGroup(
    segment: ActiveSegment,
    history: StoryContextEvent[],
    turn: number,
    draft: EventGroupDraft,
  ): void {
    const { playable, interaction, cues, tailState } = this.compileGroup(draft, this.tailVisualState, turn);
    // §50: the interaction is the segment's contract boundary. Groups that
    // arrive afterwards (the model's in-flight tail, streamed between the
    // form and `@end`) are never meant to play — the run loop already
    // returned at the terminal, so enqueueing them would desynchronize the
    // playback buffer and crash advanceBufferedEvent on the next segment.
    if (segment.terminal !== null) return;
    this.tailVisualState = tailState;

    if (playable !== null) {
      segment.events.push(playable);
      this.registerBuffered([playable]);
      this.media.registerActive([playable]);
      this.playbackBuffer.enqueue(playable);
      segment.queue.push(playable);
      void cues;
      return;
    }

    if (interaction !== null) {
      // Policy check BEFORE the terminal enters the buffer (docs §8.5).
      this.assertInteractionPolicy(interaction);
      segment.events.push(interaction);
      this.playbackBuffer.enqueue(interaction);
      segment.queue.push(interaction);
      segment.terminal = interaction;
      // The form opens with this stage (applied at interaction_opened).
      this.pendingInteractionStage.set(interaction.interaction_id, cues);
      if (interaction.mode === "input" || interaction.mode === "hybrid") {
        // DSL interactions carry no inline bridge — prefetch it as a
        // separate task (docs §32–§34).
        this.startBridgePrefetch(interaction, turn);
      }
      const context = [...history, ...segment.events];
      segment.branchManager = this.createBranchManagerForTerminal(interaction, turn, context);
      // The terminal group is the contract boundary of this segment.
      this.generationScheduler.cancelActivePath();
      return;
    }

    // Beat: a bare stage node. v1 applies it at commit time (no buffering)
    // and emits stage_beat_ready; the renderer decides its duration.
    this.renderedVisualState = tailState;
    this.emit({
      type: "stage_beat_ready",
      presentation: { cues, visualState: tailState },
    });
  }

  private createBranchManagerForTerminal(
    terminal: InteractionEvent,
    turn: number,
    context: StoryContextEvent[],
  ): BranchManager | null {
    if (terminal.mode === "choice" || terminal.mode === "hybrid") {
      const choice: ChoiceEvent = {
        type: "choice",
        prompt: terminal.prompt,
        options: terminal.options.map((option) => ({ id: option.id, text: option.text })),
      };
      return this.createBranchManager(choice, turn, context, terminal.interaction_id, "choice");
    }
    return null;
  }

  /**
   * Segment end sentinel handling (docs §44–§51, §76):
   * - `ending` → synthesize an internal EndEvent (docs §48);
   * - `buffer` → mark the segment as a clean buffer end so the run loop
   *   starts a low-water refill instead of treating it as a failure;
   * - `interaction` → the interaction group already terminated the
   *   segment; nothing to do.
   */
  private handleSegmentEnd(
    segment: ActiveSegment,
    status: SegmentEndStatus,
    turn: number,
  ): void {
    segment.endStatus = status;
    if (status.kind !== "complete") return;
    if (status.reason !== "ending") return;
    if (segment.terminal !== null) return;

    const endEvent: EndEvent = {
      type: "end",
      ending_id: this.ids.nextGenerationId("ending"),
      text: "故事到此结束。",
    };
    segment.terminal = endEvent;
    segment.events.push(endEvent);
    this.playbackBuffer.enqueue(endEvent);
    segment.queue.push(endEvent);
  }

  /**
   * Build the runtime InteractionEvent from a DSL interaction draft.
   * All machine fields are runtime-generated (docs §30–§31):
   * interaction_id, option ids, InputSpec kind/max_length.
   */
  private buildRuntimeInteraction(
    draft: DslInteractionDraft,
    turn: number,
  ): InteractionEvent {
    const interactionId = `interaction_${turn}`;
    const base = {
      type: "interaction" as const,
      interaction_id: interactionId,
      prompt: draft.prompt,
    };
    if (draft.mode === "input") {
      const input: InputSpec = {
        kind: "free_text",
        placeholder: draft.inputPlaceholder?.trim() || "输入你的回答……",
        max_length: this.config.interaction.input.max_length,
      };
      return { ...base, mode: "input", input };
    }
    const options = draft.optionTexts.map((text, index) => ({
      id: `${interactionId}_opt_${index}`,
      text,
    }));
    if (draft.mode === "choice") {
      return { ...base, mode: "choice", options };
    }
    const input: InputSpec = {
      kind: "free_text",
      placeholder: draft.inputPlaceholder?.trim() || "输入你的回答……",
      max_length: this.config.interaction.input.max_length,
    };
    return { ...base, mode: "hybrid", options, input };
  }

  /**
   * Prefetch the input bridge as an independent task (docs §32–§34):
   * 1–2 narration lines generated while the player reads/thinks/types.
   * Stored into the bridge buffer keyed by interaction id; the existing
   * confirm flow peeks it. Failure or slow arrival degrades to an empty
   * bridge (player line → NPC response directly).
   */
  private startBridgePrefetch(
    interaction: InputInteraction | HybridInteraction,
    turn: number,
  ): void {
    if (!this.config.prefetch.input_bridge.enabled) return;
    const interactionId = interaction.interaction_id;
    const controller = new AbortController();
    this.bridgeControllers.set(interactionId, controller);

    const bridgeOptions: Parameters<typeof this.generator.generateInputBridge>[4] = {
      tailVisualState: this.tailVisualState,
    };
    const bridgeBrief = this.makeBrief(turn + 1);
    if (bridgeBrief) bridgeOptions.brief = bridgeBrief;

    const promise = this.generator
      .generateInputBridge(turn + 1, this.storyState, interaction, controller.signal, bridgeOptions)
      .then((envelope) => {
        if (controller.signal.aborted) return;
        const groups = envelope.groups ?? [];
        const events: RuntimeNarrationEvent[] = [];
        for (const group of groups) {
          if (group.main.type === "narration") {
            events.push({
              type: "narration",
              text: group.main.text,
              line_id: this.nextLineId(),
            });
          }
        }
        // Bridge contract: 1–2 narration lines (docs §34). Anything else
        // is discarded — the confirm flow must never see a broken bridge.
        if (events.length < 1 || events.length > 2) {
          this.metrics.recordSchemaValidationFailure();
          this.diagnostics.warn(
            "Bridge",
            `输入过渡旁白数量非法（${events.length}），已丢弃`,
          );
          return;
        }
        for (const event of events) this.bridgeLineIds.add(event.line_id);
        this.bridgeBuffer.store(interactionId, events);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.diagnostics.warn("Bridge", `输入过渡旁白生成失败：${message}`);
      })
      .finally(() => {
        this.bridgeControllers.delete(interactionId);
      });
    void promise;
  }

  /** Abort the bridge prefetch task (choice path / input commit). */
  private cancelBridgePrefetch(interactionId: string): void {
    const controller = this.bridgeControllers.get(interactionId);
    if (controller !== undefined) {
      controller.abort();
      this.bridgeControllers.delete(interactionId);
    }
  }

  /**
   * Apply an interaction group's stage cues when the form opens and return
   * the presentation delta (docs §65). Idempotent per interaction id.
   */
  private openInteractionStage(interactionId: string): StagePresentationDelta | undefined {
    const cues = this.pendingInteractionStage.get(interactionId);
    if (cues === undefined || cues.length === 0) return undefined;
    this.pendingInteractionStage.delete(interactionId);
    this.renderedVisualState = this.reduce(this.renderedVisualState, cues);
    return { cues, visualState: this.renderedVisualState };
  }

  /** Apply a playable event's stage cues to the RENDERED state (docs §54–§55). */
  private applyPlayableStage(cues: StageCue[]): StagePresentationDelta | undefined {
    if (cues.length === 0) return undefined;
    this.renderedVisualState = this.reduce(this.renderedVisualState, cues);
    return { cues, visualState: this.renderedVisualState };
  }

  /**
   * Adopt the player-selected branch: take its buffered events (or adopt the
   * live generation task), retry on demand if the prefetch failed, then
   * activate the branch in the media scheduler and formal buffer.
   */
  private async adoptSelectedBranch(
    selected: ChoiceOption,
    choice: ChoiceEvent,
    turn: number,
    branchManager: BranchManager,
    prefetchContext: StoryContextEvent[],
  ): Promise<{ preview: RuntimePlayableEvent[]; liveSelection?: LiveBranchSelection }> {
    this.status.setPhase("切换分支", "取消未选分支，装载已选预取片段");
    const selectStart = this.clock.nowMs();
    let preview: RuntimePlayableEvent[];
    let liveSelection: LiveBranchSelection | undefined;
    // Decide from the BranchCandidate semantic layer (source of truth);
    // status.branches is only a display view of the prefetch group and may
    // disagree with the candidate (e.g. after a live handoff).
    const candidate = branchManager.getCandidate(selected.id);
    const selectedState = candidate?.status;

    try {
      if (selectedState === "ready" || selectedState === "failed" || selectedState === "discarded") {
        // A failed candidate must enter the existing retry path. Only a
        // queued/generating candidate can be adopted as a live active task.
        preview = await branchManager.selectCandidate(selected.id);
      } else {
        const live = branchManager.selectCandidateLive(selected.id);
        preview = [...live.events];
        liveSelection = live;
      }
      this.diagnostics.info(
        "Prefetch",
        `选择"${selected.text}" → 取回 ${preview.length} 条已到达事件，耗时 ${this.clock.nowMs() - selectStart}ms (预取状态=${selectedState})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.setJob("selected-branch-retry", "已选分支重试", "running");
      const retryOptions: Parameters<typeof this.generator.generateBranchPrefetch>[6] = {};
      const retryBrief = this.makeBrief(turn + 1);
      if (retryBrief) retryOptions.brief = retryBrief;

      const retryPromise = this.generator
        .generateBranchPrefetch(turn + 1, this.storyState, prefetchContext, choice, selected, undefined, retryOptions)
        .then((envelope) => {
          const result = this.materializeDslGroups(envelope.groups ?? [], this.tailVisualState, turn);
          this.branchTailStates.set(selected.id, result.tailState);
          return result.events;
        });
      preview = await retryPromise;
      this.media.registerCandidate(selected.id, preview);
      this.status.removeJob("selected-branch-retry");
    }

    // The selected branch's tail visual state becomes the new predictive
    // tail (docs §56): the next generation continues from where the branch
    // actually leaves the stage. For a live-selected branch whose request
    // has not resolved yet, derive the tail from the committed prefix's
    // stage cues.
    const branchTail = this.branchTailStates.get(selected.id);
    if (branchTail !== undefined) {
      this.tailVisualState = branchTail;
    } else {
      const cues: StageCue[] = [];
      for (const event of preview) {
        const stage = (event as { stage?: StageCue[] }).stage;
        if (stage !== undefined) cues.push(...stage);
      }
      if (cues.length > 0) {
        this.tailVisualState = this.reduce(this.tailVisualState, cues);
      }
    }
    this.branchTailStates.clear();

    this.media.activateCandidate(selected.id);
    this.media.registerActive(preview);
    this.registerBuffered(preview);

    return {
      preview,
      ...(liveSelection ? { liveSelection } : {}),
    };
  }

  private async handleChoice(
    choice: ChoiceEvent,
    turn: number,
    branchManager: BranchManager | null,
    prefetchContext: StoryContextEvent[],
    interactionId?: string,
  ): Promise<ChoiceSelection> {
    if (!branchManager) throw new Error("内部错误：choice 缺少分支预取组。 ");

    this.status.setPhase("等待选择", "各分支正在并行预取；可随时选择");
    // Legacy choice events have no interaction_id; DSL-compiled choice
    // interactions carry the runtime-generated id (docs §30).
    const scopeId = interactionId ?? `choice_${turn}`;
    // §10.2 lifecycle: the interaction is the active command scope from
    // `interaction_opened` until it resolves.
    this.activeInteractionId = scopeId;
    const presentation = this.openInteractionStage(scopeId);
    this.emit({
      type: "interaction_opened",
      interactionId: scopeId,
      interaction: choice,
      ...(presentation !== undefined ? { presentation } : {}),
    });
    const command = await this.waitForInteractionCommand(
      scopeId,
      { select_choice: true },
    );
    if (command.type !== "select_choice") throw new RuntimeShutdownError();
    const selected = choice.options.find((option) => option.id === command.optionId);
    if (!selected) throw new Error(`未找到选项：${command.optionId}`);
    // The option exists: the interaction is now resolved and can no longer
    // be submitted; browsers close the form immediately.
    this.resolveInteraction(scopeId, "choice");
    // §10.2 lifecycle: choice accepted → the interaction scope is released.
    this.activeInteractionId = null;
    this.choiceTimestamp = this.clock.nowMs();
    await this.recordPlayerChoice(selected, turn);
    // The checkpoint fires only AFTER the player choice is formally
    // committed: a consolidation triggered here must include the choice
    // event (audit finding 5).
    this.narrativeDirector?.checkpoint("interaction_completed");
    this.diagnostics.info("player", `你选择了：${selected.text}`);

    const { preview, liveSelection } = await this.adoptSelectedBranch(
      selected,
      choice,
      turn,
      branchManager,
      prefetchContext,
    );

    for (const option of choice.options) {
      this.status.removeJob(`branch:${option.id}`);
    }
    this.status.clearBranches();
    return {
      preview,
      ...(liveSelection ? { liveSelection } : {}),
    };
  }

  private async consumePlayableEvents(
    events: RuntimePlayableEvent[],
    turn: number,
    segment?: ActiveSegment
  ): Promise<void> {
    for (const event of events) await this.consumePlayableEvent(event, turn, segment);
  }

  /**
   * Consume a selected branch while retaining its original generation task.
   * Events that arrive after selection are pushed into the formal buffer by
   * this method before they are rendered. The task may fail after producing
   * usable events; in that case the continuation path still takes over.
   */
  private async consumeLiveSelection(
    initialEvents: RuntimePlayableEvent[],
    selection: LiveBranchSelection,
    turn: number,
  ): Promise<void> {
    const handoffIfReady = (): void => {
      // Count all playable lines (dialogue + narration) so a branch that
      // produced mostly narration can still hand over to the continuation
      // request instead of running until the model stops on its own.
      const playableCount = selection.events.filter(
        (event) => event.type === "dialogue" || event.type === "narration",
      ).length;
      if (playableCount >= this.config.prefetch.branch_dialogue_lines) {
        this.diagnostics.info(
          "Prefetch",
          `已选分支达到 ${playableCount} 条可播放行，立即交接正式续写`,
        );
        selection.handoff();
      }
    };

    const failure = await this.consumeLiveStream(
      initialEvents,
      {
        events: selection.events,
        done: selection.done,
        subscribe: selection.subscribe,
      },
      turn,
      handoffIfReady,
      handoffIfReady,
    );

    // The branch request has ended. Its already generated lines remain valid;
    // the caller starts a normal continuation using that committed prefix.
    if (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.status.setPhase("后台续写", `已保留分支前缀，分支流失败：${message}`);
    }
  }

  /**
   * Consume a confirmed input response while its generation task is still
   * running. Arrived events play in the committed order
   * (player → bridge → response); late events are routed into the formal
   * buffer directly (live promotion) and played as they arrive.
   */
  private async consumeLiveInputResponse(
    initialEvents: RuntimePlayableEvent[],
    live: InputResponseSession,
    turn: number,
  ): Promise<void> {
    const failure = await this.consumeLiveStream(
      initialEvents,
      live,
      turn,
      undefined,
      undefined,
      () => this.metrics.recordInputResponseUnderrun(),
    );

    if (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.status.setPhase("后台续写", `已保留输入回应前缀，回应流失败：${message}`);
    }
    this.status.removeJob("input-response");
  }

  /**
   * Shared live-stream consumption: play the committed prefix, subscribe to
   * later events, enqueue them into the formal buffer, and play them until
   * the stream ends. Returns the stream failure, if any.
   *
   * `onEvent` fires for each newly enqueued event; `onSynced` fires once
   * after the initial snapshot so callers can re-check conditions that
   * depend on the full committed prefix. `onFirstWait` fires once when the
   * prefix is exhausted and the next event has not arrived yet (underrun).
   */
  private async consumeLiveStream(
    initialEvents: RuntimePlayableEvent[],
    live: LiveStreamLike,
    turn: number,
    onEvent?: (event: RuntimePlayableEvent) => void,
    onSynced?: () => void,
    onFirstWait?: () => void,
  ): Promise<unknown> {
    const seen = new Set(initialEvents.map((event) => event.line_id));
    const queue = new AsyncEventQueue<RuntimePlayableEvent>();
    let failure: unknown;

    const enqueueIfNew = (event: RuntimePlayableEvent): void => {
      if (seen.has(event.line_id)) return;
      seen.add(event.line_id);
      // Publish late lines immediately. Playback may consume them later, but
      // they must already count toward the formal low-water mark.
      this.playbackBuffer.enqueue(event);
      this.registerBuffered([event]);
      this.media.registerActive([event]);
      queue.push(event);
      onEvent?.(event);
    };
    const unsubscribe = live.subscribe(enqueueIfNew);
    // Catch events emitted between stream creation and subscribe(). JavaScript
    // callbacks cannot interleave this synchronous snapshot, so this closes
    // the only handoff gap without duplicating line IDs.
    for (const event of live.events) enqueueIfNew(event);
    onSynced?.();

    void live.done
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        unsubscribe();
        queue.close();
      });

    await this.consumePlayableEvents(initialEvents, turn);

    // Underrun: the committed prefix (player line + bridge) has been fully
    // presented and the next response line has not arrived yet. The CLI
    // keeps the current screen and waits silently; the metric counts it.
    let recordedUnderrun = false;
    while (true) {
      if (!recordedUnderrun && queue.pendingCount() === 0) {
        recordedUnderrun = true;
        onFirstWait?.();
      }
      const next = await queue.next();
      if (!next.done) {
        const event = next.value;
        await this.consumePlayableEvent(event, turn);
        continue;
      }
      break;
    }

    return failure;
  }

  private advanceBufferedEvent(event: RuntimeBufferEvent): void {
    const bufferedEvent = this.playbackBuffer.advance();
    if (bufferedEvent && bufferedEvent !== event) {
      throw new Error("播放缓冲顺序与生成事件流不一致。");
    }
  }

  private async consumePlayableEvent(
    event: RuntimePlayableEvent,
    turn: number,
    segment?: ActiveSegment
  ): Promise<void> {
    this.advanceBufferedEvent(event);

    if (this.choiceTimestamp !== null) {
      this.metrics.recordChoiceToNextLine(this.clock.nowMs() - this.choiceTimestamp);
      this.choiceTimestamp = null;
    }

    const isModelPlayable =
      event.type === "dialogue" || event.type === "narration";
    // Bridge narration is materialized and played like narration but never
    // recorded into the formal log and never scheduled for media.
    const isBridge = event.type === "narration" && this.bridgeLineIds.has(event.line_id);
    if (isBridge && this.bridgePlayStartedAtMs === null) {
      this.bridgePlayStartedAtMs = this.clock.nowMs();
    }
    if (event.type === "player_dialogue") {
      await this.recordPlayerDialogue(event, turn);
    } else if (isModelPlayable && !isBridge) {
      await this.recordModelEvent(event, turn);
    }
    if (isModelPlayable && !isBridge && !this.media.isReady(event.line_id)) {
      await this.media.waitUntilReady(event.line_id);
    }

    this.buffered.delete(event.line_id);
    this.updateBufferStatus();
    this.media.markPresented(event.line_id);
    if (isBridge) this.bridgeLineIds.delete(event.line_id);
    if (this.responseLineIds.has(event.line_id) && this.bridgePlayStartedAtMs !== null) {
      this.metrics.recordInputBridgeCoverDuration(
        this.clock.nowMs() - this.bridgePlayStartedAtMs,
      );
      this.bridgePlayStartedAtMs = null;
    }

    // DSL mode: the line's stage cues (bg/bgm/ch/… from its group prelude)
    // apply to the RENDERED state exactly when the player sees the line
    // (docs §54–§55, §63).
    const stage = (event as { stage?: StageCue[] }).stage;
    const presentation = stage ? this.applyPlayableStage(stage) : undefined;
    this.emit({
      type: "playback_ready",
      event,
      ...(presentation !== undefined ? { presentation } : {}),
    });
    await this.waitForAdvance(segment);
  }

  private async waitForAdvance(segment?: ActiveSegment): Promise<void> {
    const command = await this.waitForCommand(
      (c) => c.type === "advance",
    );
    if (command.type !== "advance") throw new RuntimeShutdownError();
    // §75：玩家推进后重新评估低水位（任务已结束而玩家仍有余量时，
    // 在"剩 refill 句"处提前启动续写）。当前段已失败时跳过：修复路径即将
    // 接管单槽调度器，杂散续写会让 startActivePath 抛错杀死 run()。
    if (segment?.failed) return;
    this.reconcileTextBuffer(this.activeSegmentTurn + 1);
  }

  /**
   * §75 低水位不变量：未来可播放文本 ≤ refill 阈值 且 无未消费交互 且
   * 无活动路径任务 → 立即启动后台续写（不等玩家读空）。
   * 触发点：路径任务以 buffer 收束、玩家每次 advance、run loop 的 buffer 分支。
   */
  private reconcileTextBuffer(nextTurn: number): void {
    if (this.pendingRefillSegment !== null) return;
    if (this.generationScheduler.hasActivePathTask()) return;
    if (this.playbackBuffer.hasUnconsumedInteraction()) return;
    if (
      this.playbackBuffer.countTextLinesAhead() >
      this.config.text_buffer.refill_threshold_lines
    ) {
      return;
    }
    this.pendingRefillSegment = this.startActiveSegment(
      "continuation",
      nextTurn,
      [...this.events],
      [],
    );
    void this.pendingRefillSegment.done.catch(() => undefined);
  }

  /**
   * §74：播放达到 start_threshold 句才放行首句（防止首句即欠载）。
   * 段结束（含失败）时立即放行。
   */
  private async waitForStartThreshold(segment: ActiveSegment): Promise<void> {
    const threshold = this.config.text_buffer.start_threshold_lines;
    if (threshold <= 1) return;
    // §74：段 done 一旦 settled（无论成败）即放行。失败段 endStatus 恒空
    // （handleSegmentEnd 只在干净 @end 时触发），只等 endStatus 会在
    // “前缀不足 threshold 且已失败”时热旋转（race 立即返回的忙循环）。
    let settled = false;
    void segment.done.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (this.playbackBuffer.countTextLinesAhead() < threshold) {
      if (segment.endStatus !== null || settled) return;
      await Promise.race([
        segment.done.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    }
  }

  private nextLineId(): string {
    return this.ids.nextLineId(this.sessionId);
  }

  private registerBuffered(events: RuntimePlayableEvent[]): void {
    for (const event of events) this.buffered.set(event.line_id, event);
    this.updateBufferStatus();
  }

  private updateBufferStatus(): void {
    const events = [...this.buffered.values()];
    const dialogueLines = events.filter((event) => event.type === "dialogue").length;
    this.status.setBuffer(events.length, dialogueLines);
  }

  private async recordModelEvent(event: RuntimeModelEvent, turn: number): Promise<void> {
    const stored: StoredModelEvent = {
      ...event,
      seq: this.seq,
      turn,
      timestamp: this.clock.nowIso(),
      source: "model"
    };
    this.seq += 1;
    await this.record(stored);
  }

  private createBranchManager(
    choice: ChoiceEvent,
    turn: number,
    prefetchContext: StoryContextEvent[],
    interactionId?: string,
    source: "choice" | "input_preview" = "choice"
  ): BranchManager {
    const manager = new BranchManager(this.metrics);

    for (const option of choice.options) {
      manager.createCandidate(
        option.id,
        interactionId ?? `choice_${turn}`,
        source
      );
    }

    manager.startPrefetch({
      choice,
      concurrency: this.config.prefetch.branch_concurrency,
      status: this.status,
      generate: async (option, signal, onEvent) => {
        const materialized: RuntimePlayableEvent[] = [];
        // DSL mode: branch groups compile against a branch-local visual
        // state seeded from the current tail (docs §56). Unselected
        // branches never execute, so their states stay isolated here.
        let branchState = this.tailVisualState;
        const prefetchBrief = this.makeBrief(turn + 1);
        const envelope = await this.generator.generateBranchPrefetch(
          turn + 1,
          this.storyState,
          prefetchContext,
          choice,
          option,
          signal,
          {
            tailVisualState: this.tailVisualState,
            ...(prefetchBrief ? { brief: prefetchBrief } : {}),
            onGroup: (group) => {
              const { playable, tailState } = this.compileGroup(group, branchState, turn);
              branchState = tailState;
              if (playable !== null) {
                materialized.push(playable);
                onEvent(playable);
              }
            },
          },
        );
        if (materialized.length === 0 && envelope.groups !== undefined && envelope.groups.length > 0) {
          const result = this.materializeDslGroups(envelope.groups, branchState, turn);
          materialized.push(...result.events);
          branchState = result.tailState;
        }
        this.branchTailStates.set(option.id, branchState);
        return materialized;
      },
      onReady: (option, branchEvents) => {
        this.media.registerCandidate(option.id, branchEvents);
      }
    });

    return manager;
  }

  /**
   * Compile DSL groups into materialized playable events, chaining the
   * visual state across groups. Used by branch prefetch and input-response
   * paths (docs §56, §79).
   */
  private materializeDslGroups(
    groups: EventGroupDraft[],
    baseState: VisualState,
    turn: number,
  ): { events: RuntimePlayableEvent[]; tailState: VisualState } {
    let state = baseState;
    const events: RuntimePlayableEvent[] = [];
    for (const draft of groups) {
      const { playable, tailState } = this.compileGroup(draft, state, turn);
      state = tailState;
      if (playable !== null) {
        events.push(playable);
      } else {
        this.diagnostics.warn(
          "DSL",
          `片段跳过不可播放的组：${draft.main.type}`,
        );
      }
    }
    return { events, tailState: state };
  }

  /**
   * Two-phase free-text input commit, driven by commands and a streaming
   * InputResponseSession.
   *
   * - `interaction_opened` (input mode) → await `preview_input`
   * - preview opens and the response generation streams into the session
   * - `input_preview_opened` → await `confirm_input` / `cancel_input`
   * - cancel → `input_preview_canceled`, reopen the same interaction; the
   *   bridge survives for the next preview
   * - confirm → `input_committed`; returns the committed prefix
   *   (player line → bridge → arrived response) plus a live stream when the
   *   response is still generating (promotion, no second request)
   *
   * When `initialText` is provided (e.g. from a hybrid interaction) the
   * editor step is skipped and the flow goes directly to preview.
   */
  private async handleInteractionInput(
    interaction: InputInteraction | HybridInteraction,
    turn: number,
    branchManager: BranchManager | null,
    initialText?: string,
  ): Promise<InputCommitOutcome> {
    branchManager?.discardAll();
    this.status.clearBranches();
    const interactionId = interaction.interaction_id;
    // The bridge is shared across preview cancels; it is consumed only at
    // confirm so a cancelled preview can retry with the same bridge.
    const bridgeEvents = this.bridgeBuffer.peek(interactionId) ?? [];

    while (true) {
      let text: string;
      if (initialText !== undefined && initialText.trim().length > 0) {
        // Text already provided — skip editor, jump to preview
        text = initialText.trim();
        initialText = undefined;
      } else {
        this.status.setPhase("等待输入", "等待玩家自由输入");
        this.status.setBuffer(this.buffered.size, this.countBufferedDialogues());
        // §10.2 lifecycle: (re)opening the interaction re-arms the command
        // scope; the id survives preview cancels.
        this.activeInteractionId = interactionId;
        const presentation = this.openInteractionStage(interactionId);
        this.emit({
          type: "interaction_opened",
          interactionId,
          interaction,
          ...(presentation !== undefined ? { presentation } : {}),
        });
        const command = await this.waitForInteractionCommand(
          interactionId,
          { preview_input: true },
        );
        if (command.type !== "preview_input") throw new RuntimeShutdownError();
        text = command.text.trim().slice(0, interaction.input.max_length);
      }

      // Freeze the text and enter preview.
      const session = this.inputEngine.startEditing(interaction);
      this.inputEngine.updateDraft(session, text);
      this.inputEngine.requestPreview(session);

      const previewId = this.ids.nextPreviewId(interactionId);
      const responseSession = new InputResponseSession({
        previewId,
        interactionId,
        generationId: this.ids.nextGenerationId(`input:${interactionId}`),
        frozenText: text,
        bridgeEvents,
      });

      this.status.setPhase("输入预览", `玩家输入：${text.slice(0, 50)}`);
      const previewStartTime = this.clock.nowMs();
      this.status.setJob(
        "input-response",
        `NPC 回应：${text.slice(0, 30)}`,
        "running"
      );

      // Fire NPC response generation in background; every complete event is
      // staged into the session immediately (never the formal log).
      const { promise: responsePromise, controller: responseController } =
        this.startInputResponseGeneration(interaction, turn, text, responseSession);

      // Don't await — the driver shows the preview while generating.
      void responsePromise.catch(() => undefined);

      // Show preview and await confirmation.
      // §10.2 lifecycle: the preview is the active confirm/cancel scope from
      // `input_preview_opened` until it is cancelled or confirmed.
      this.activePreviewId = previewId;
      this.emit({ type: "input_preview_opened", previewId, text });
      let previewCommand: RuntimeCommand;
      if (this.config.input.require_preview_confirmation) {
        previewCommand = await this.waitForCommand(
          (c) =>
            (c.type === "confirm_input" || c.type === "cancel_input") &&
            c.previewId === previewId,
        );
      } else {
        // Single-Enter flow: the preview is implicit, commit immediately.
        previewCommand = { type: "confirm_input", previewId };
      }
      const previewDwellMs = this.clock.nowMs() - previewStartTime;
      this.metrics.recordInputPreview(previewDwellMs);

      if (previewCommand.type === "cancel_input") {
        // Return to editing — abort the stale response request so its events
        // can never be buffered or rendered for the previous edit session.
        responseController.abort();
        responseSession.cancel();
        this.metrics.recordInputResponseCanceled();
        this.inputEngine.cancel(session);
        this.status.removeJob("input-response");
        this.status.clearBranches();
        // §10.2 lifecycle: cancel releases the preview scope only; the
        // interaction stays open for the next preview.
        this.activePreviewId = null;
        this.emit({ type: "input_preview_canceled", previewId });
        this.media.discardCandidate(previewId);
        if (interaction.mode === "hybrid") {
          // §11.7: a hybrid cancel hands control back to the hybrid loop,
          // which re-arms BOTH submission paths and re-prefetches the
          // option branches (the interaction is still open).
          return { type: "canceled" };
        }
        continue;
      }

      // Confirm — commit the session.
      this.inputEngine.commit(session);
      responseSession.commit();
      // The input is now resolved and can no longer be submitted; browsers
      // close the form. Emitted before input_committed so a reconnect never
      // restores the resolved interaction.
      this.resolveInteraction(interactionId, "input");
      // §10.2 lifecycle: confirm releases both the preview and interaction
      // scope — no further confirm/cancel may touch this preview.
      this.activeInteractionId = null;
      this.activePreviewId = null;
      this.emit({ type: "input_committed", previewId });
      this.bridgeBuffer.take(interactionId);
      // The interaction is resolved: stop the bridge prefetch task so late
      // narration can never be buffered for a dead interaction.
      this.cancelBridgePrefetch(interactionId);

      // Confirm → first response line measurement (E3/G1).
      this.inputConfirmAtMs = this.clock.nowMs();
      if (responseSession.responseEvents.length > 0) {
        this.metrics.recordInputConfirmToFirstResponseLine(0);
        this.inputConfirmAtMs = null;
      }

      const playerDialogue = this.makePlayerDialogue(interactionId, text);

      // Failure with no usable events: one repair attempt, streamed live so
      // the player line + bridge can play first (reading time hides it).
      // `settled` tells whether the generation has ended; the failure is
      // detected via the `failure` field because commit() already moved the
      // session to "committed".
      let liveSession: InputResponseSession | null = null;
      if (
        responseSession.settled &&
        responseSession.failure !== null &&
        responseSession.responseEvents.length === 0
      ) {
        liveSession = new InputResponseSession({
          previewId,
          interactionId,
          generationId: this.ids.nextGenerationId(`input:${interactionId}:repair`),
          frozenText: text,
          bridgeEvents,
        });
        const repair = this.startInputResponseGeneration(interaction, turn, text, liveSession);
        void repair.promise.catch(() => undefined);
        this.status.setJob(
          "input-response",
          `NPC 回应：${text.slice(0, 30)}`,
          "running"
        );
      } else if (!responseSession.settled) {
        // Live promotion: the confirmed stream is still running; its later
        // events enter the formal buffer directly. No abort, no new request.
        liveSession = responseSession;
        this.metrics.recordInputResponsePromotedLive();
      }

      await this.recordPlayerInput(interactionId, text, turn);
      this.status.setPhase(
        "输入已提交",
        `玩家输入：${text.slice(0, 50)}`
      );

      if (!liveSession) {
        // Response finished before/during confirm: commit the staged patch
        // (E3: committed && generation done), then return the fixed prefix.
        await responseSession.done;
        this.applyInputPatch(responseSession);
        if (responseSession.failure) {
          this.diagnostics.warn("input", `NPC 回应生成失败 — ${responseSession.failure.message}`);
        }
        this.media.registerActive(responseSession.responseEvents);
        this.status.removeJob("input-response");
        this.narrativeDirector?.checkpoint("interaction_completed");
        return {
          type: "committed",
          preview: [playerDialogue, ...bridgeEvents, ...responseSession.responseEvents],
        };
      }

      // Live path: the patch is committed when the stream ends; the response
      // prefix already staged plays first, late events flow to the formal
      // buffer via consumeLiveInputResponse.
      void liveSession.done.then(() => {
        this.applyInputPatch(liveSession);
        if (liveSession.failure) {
          this.diagnostics.warn("input", `NPC 回应生成失败 — ${liveSession.failure.message}`);
        }
      });
      this.media.registerActive(liveSession.responseEvents);
      this.narrativeDirector?.checkpoint("interaction_completed");
      return {
        type: "committed",
        preview: [playerDialogue, ...bridgeEvents, ...liveSession.responseEvents],
        liveResponse: liveSession,
      };
    }
  }

  /**
   * Start one input response generation that streams events into the
   * session. Returns the settled promise and the abort controller.
   */
  private startInputResponseGeneration(
    interaction: InputInteraction | HybridInteraction,
    turn: number,
    text: string,
    responseSession: InputResponseSession,
  ): { promise: Promise<void>; controller: AbortController } {
    const controller = new AbortController();
    // DSL mode: response groups compile against a response-local visual
    // state seeded from the current tail (docs §79).
    let responseState = this.tailVisualState;

    const brief = this.makeBrief(turn + 1);
    const promise = this.generator
      .generateInputResponse(
        turn + 1,
        this.storyState,
        [...this.events],
        interaction,
        text,
        controller.signal,
        {
          tailVisualState: this.tailVisualState,
          ...(brief ? { brief } : {}),
          onGroup: (group) => {
            if (controller.signal.aborted) {
              this.metrics.recordStaleInputEventDropped();
              return;
            }
            const { playable, tailState } = this.compileGroup(group, responseState, turn);
            responseState = tailState;
            if (playable !== null) {
              this.stageResponseEvent(responseSession, playable);
            }
          },
        },
      )
      // Single reaction (not .then().catch()): the fulfillment/rejection
      // handler runs in ONE microtask, so by the time the confirm command is
      // processed the session status is already settled — the repair decision
      // at confirm never races the failure reaction.
      .then(
        (envelope) => {
          if (controller.signal.aborted) return;
          // Defer state patch until the player confirms (second Enter).
          responseSession.setPendingPatch(envelope.state_patch);
          // Envelope-format providers do not invoke onGroup; feed their
          // groups through the same staging path.
          if (responseSession.responseEvents.length === 0) {
            if (envelope.groups !== undefined && envelope.groups.length > 0) {
              const result = this.materializeDslGroups(envelope.groups, responseState, turn);
              responseState = result.tailState;
              for (const event of result.events) {
                this.stageResponseEvent(responseSession, event);
              }
            }
          }
          // The confirmed response's tail state becomes the new predictive
          // tail (docs §79): the next generation continues from where the
          // response leaves the stage.
          this.tailVisualState = responseState;
          responseSession.markReady();
          this.status.setJob(
            "input-response",
            `NPC 回应：${text.slice(0, 30)}`,
            "ready"
          );
        },
        (error) => {
          if (controller.signal.aborted) return;
          const err = error instanceof Error ? error : new Error(String(error));
          responseSession.markFailed(err);
          this.status.setJob(
            "input-response",
            `NPC 回应：${text.slice(0, 30)}`,
            "failed",
            err.message
          );
        },
      );

    return { promise, controller };
  }

  /**
   * Stage one response event, measuring the confirm → first-line window.
   */
  private stageResponseEvent(
    responseSession: InputResponseSession,
    event: RuntimePlayableEvent,
  ): void {
    const confirmAt = this.inputConfirmAtMs;
    const firstAfterConfirm =
      confirmAt !== null && responseSession.responseEvents.length === 0;
    responseSession.appendResponseEvent(event);
    this.responseLineIds.add(event.line_id);
    if (firstAfterConfirm) {
      this.metrics.recordInputConfirmToFirstResponseLine(this.clock.nowMs() - confirmAt);
      this.inputConfirmAtMs = null;
    }
  }

  /**
   * Commit a staged state patch. E3 timing rule: only after the session is
   * committed AND the generation has ended (callers await `done` first).
   */
  private applyInputPatch(session: InputResponseSession): void {
    if (session.status !== "committed") return;
    if (session.pendingStatePatch === null) return;
    try {
      this.storyState = applyPatch(this.storyState, session.pendingStatePatch);
    } catch {
      this.metrics.recordStatePatchRejection();
    }
    session.pendingStatePatch = null;
  }

  private makePlayerDialogue(interactionId: string, text: string): PlayerDialogueEvent {
    return {
      type: "player_dialogue",
      interaction_id: interactionId,
      speaker: "你",
      text,
      line_id: this.nextLineId(),
    };
  }

  /**
   * Hybrid interaction: player can select a preset option OR type free text.
   * The interaction scope opens once and accepts `select_choice` /
   * `preview_input` until one path resolves. A preview cancel does NOT
   * resolve it — the loop re-opens the full hybrid (§11.6) with both paths
   * armed again (§11.7: 选项仍可点击) and re-prefetches the option branches
   * so a later choice has live candidates.
   *
   * Choosing a preset option discards the buffered input bridge; choosing
   * free text keeps it for the confirm → bridge → response playback.
   */
  private async handleHybridInteraction(
    interaction: HybridInteraction,
    turn: number,
    branchManager: BranchManager | null,
    prefetchContext: StoryContextEvent[]
  ): Promise<SegmentOutcome> {
    const interactionId = interaction.interaction_id;
    // §10.2 lifecycle: hybrid opens one interaction scope shared by both
    // submission paths; it is released as soon as either path resolves.
    while (true) {
      this.status.setPhase("等待选择", "可选择预设选项，或自由输入");
      this.activeInteractionId = interactionId;
      const presentation = this.openInteractionStage(interactionId);
      this.emit({
        type: "interaction_opened",
        interactionId,
        interaction,
        ...(presentation !== undefined ? { presentation } : {}),
      });
      const command = await this.waitForInteractionCommand(
        interactionId,
        { select_choice: true, preview_input: true },
      );

      if (command.type === "preview_input") {
        branchManager?.discardAll();
        this.status.clearBranches();

        const committed = await this.handleInteractionInput(
          interaction,
          turn,
          null,
          command.text,
        );

        if (committed.type === "canceled") {
          // §11.7: cancel restores the FULL hybrid — options clickable
          // again, input re-editable, bridge preserved. Re-prefetch the
          // option branches so the choice path is live once more.
          branchManager = this.createBranchManagerForTerminal(
            interaction,
            turn,
            prefetchContext,
          );
          continue;
        }

        return {
          type: "choice",
          nextTurn: turn + 1,
          preview: committed.preview,
          ...(committed.liveResponse ? { liveResponse: committed.liveResponse } : {}),
        };
      }

      if (command.type !== "select_choice") throw new RuntimeShutdownError();

      const selected = interaction.options.find(
        (o) => o.id === command.optionId
      );
      if (!selected) {
        throw new Error(`未找到选项：${command.optionId}`);
      }

      // The preset option resolves the interaction through the branch flow;
      // the input bridge belongs to the free-text path and is discarded.
      this.resolveInteraction(interactionId, "choice");
      // §10.2 lifecycle: choice accepted → the interaction scope is released.
      this.activeInteractionId = null;
      this.bridgeBuffer.discard(interactionId);
      // The preset option resolves the interaction: the bridge belongs to
      // the free-text path and is discarded (docs §35).
      this.cancelBridgePrefetch(interactionId);

      await this.recordPlayerChoice(
        { id: selected.id, text: selected.text },
        turn
      );
      // After the choice is formally committed (audit finding 5).
      this.narrativeDirector?.checkpoint("interaction_completed");
      this.choiceTimestamp = this.clock.nowMs();
      this.diagnostics.info("player", `你选择了：${selected.text}`);

      let preview: RuntimePlayableEvent[];
      let liveSelection: LiveBranchSelection | undefined;

      if (branchManager) {
        const syntheticChoice: ChoiceEvent = {
          type: "choice",
          prompt: interaction.prompt,
          options: interaction.options.map((o) => ({
            id: o.id,
            text: o.text,
          })),
        };
        const adopted = await this.adoptSelectedBranch(
          selected,
          syntheticChoice,
          turn,
          branchManager,
          prefetchContext,
        );
        preview = adopted.preview;
        liveSelection = adopted.liveSelection;

        for (const option of interaction.options) {
          this.status.removeJob(`branch:${option.id}`);
        }
        this.status.clearBranches();
      } else {
        this.status.setJob(
          "on-demand-branch",
          `生成分支：${selected.text}`,
          "running"
        );
        const syntheticChoice: ChoiceEvent = {
          type: "choice",
          prompt: interaction.prompt,
          options: interaction.options.map((o) => ({
            id: o.id,
            text: o.text,
          })),
        };
        const onDemandOptions: Parameters<typeof this.generator.generateBranchPrefetch>[6] = {};
        const onDemandBrief = this.makeBrief(turn + 1);
        if (onDemandBrief) onDemandOptions.brief = onDemandBrief;

        const genPromise = this.generator
          .generateBranchPrefetch(
            turn + 1,
            this.storyState,
            prefetchContext,
            syntheticChoice,
            { id: selected.id, text: selected.text },
            undefined,
            onDemandOptions,
          )
          .then((envelope) => {
            const result = this.materializeDslGroups(envelope.groups ?? [], this.tailVisualState, turn);
            return result.events;
          });
        preview = await genPromise;
        this.registerBuffered(preview);
        this.status.removeJob("on-demand-branch");
      }

      return {
        type: "choice",
        nextTurn: turn + 1,
        preview,
        ...(liveSelection ? { liveSelection } : {}),
      };
    }
  }

  private countBufferedDialogues(): number {
    return [...this.buffered.values()].filter(
      (event) => event.type === "dialogue"
    ).length;
  }

  private async recordPlayerChoice(option: ChoiceOption, turn: number): Promise<void> {
    const stored: StoredPlayerChoiceEvent = {
      type: "player_choice",
      choice_id: option.id,
      text: option.text,
      seq: this.seq,
      turn,
      timestamp: this.clock.nowIso(),
      source: "player"
    };
    this.seq += 1;
    await this.record(stored);
  }

  private async recordPlayerInput(
    interactionId: string,
    text: string,
    turn: number
  ): Promise<void> {
    const stored: StoredPlayerInputEvent = {
      type: "player_input",
      interaction_id: interactionId,
      text,
      seq: this.seq,
      turn,
      timestamp: this.clock.nowIso(),
      source: "player"
    };
    this.seq += 1;
    await this.record(stored);
  }

  private async recordPlayerDialogue(
    event: PlayerDialogueEvent,
    turn: number
  ): Promise<void> {
    const stored: StoredPlayerDialogueEvent = {
      ...event,
      seq: this.seq,
      turn,
      timestamp: this.clock.nowIso(),
      source: "player"
    };
    this.seq += 1;
    await this.record(stored);
  }

  private async record(event: StoredEvent): Promise<void> {
    this.events.push(event);
    await this.store.append(event);
    this.narrativeDirector?.observeCommitted([event]);
  }

  private makeBrief(turn: number): NarrativeBrief | undefined {
    if (!this.narrativeDirector) return undefined;
    return this.narrativeDirector.getBrief({
      turn,
      // The last COMMITTED event seq (this.seq is the next slot to
      // allocate) — the brief's currentEventSeq must not lie about the
      // story front (audit finding 9).
      eventSeq: this.seq - 1,
      location: this.storyState.scene.location,
      characters: Object.keys(this.storyState.characters),
    });
  }

  private async saveCurrentStateSnapshot(): Promise<void> {
    await this.store.saveSnapshot({ state: this.storyState });
  }

  /**
   * Check the formal playback watermark.
   */
  private async runTrackedJob<T>(
    id: string,
    label: string,
    task: () => Promise<T>
  ): Promise<T> {
    this.status.setJob(id, label, "running");
    try {
      const result = await task();
      this.status.setJob(id, label, "ready");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.setJob(id, label, "failed", message);
      throw error;
    }
  }
}
