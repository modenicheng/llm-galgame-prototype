import type { AppConfig } from "./config.js";
import { InputEngine } from "./interaction/input-engine.js";
import { AsyncEventQueue } from "./core/runtime/async-event-queue.js";
import { InputBridgeBuffer } from "./core/interaction/input-bridge.js";
import {
  InputResponseSession,
} from "./core/interaction/input-session.js";
import type { RuntimeCommand } from "./core/runtime/runtime-command.js";
import {
  InteractionPolicyViolationError,
  RestartRequestedError,
  RetraceRequestedError,
  RuntimeShutdownError,
} from "./core/runtime/errors.js";
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
import type { RunGraphPort, RunResume } from "./core/ports/run-graph-port.js";
import type { RestorePoint } from "./core/ports/run-graph-port.js";
import { EMPTY_MEMORY_DIGEST } from "./core/graph/memory-digest.js";
import {
  formSnapshotFromInteraction,
  interactionFromFormSnapshot,
} from "./core/graph/form.js";
import type { MemoryDigest } from "./core/graph/types.js";
import type { StoryGeneratorPort } from "./core/ports/story-generator-port.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import type { NarrativeDirectorPort } from "./core/ports/narrative-director-port.js";
import type { MemoryProjection } from "./core/narrative/memory-projection.js";
import { BranchManager } from "./runtime/branch-manager.js";
import { InteractionDriver, type InteractionHost } from "./runtime/interaction-driver.js";
import type {
  ActiveSegment,
  ActiveSegmentKind,
  SegmentOutcome,
  InputCommitOutcome,
  ChoiceOutcome,
  ChoiceSelection,
  LiveStreamLike,
} from "./runtime/segment-types.js";
import type { LiveBranchSelection } from "./runtime/prefetch.js";
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
import {
  EMPTY_CHARACTER_REGISTRY,
  toCharacterRegistry,
} from "./core/assets/catalog.js";
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
import { reconcileStoryState } from "./story/reconcile.js";
import type {
  CharacterRegistry as CoreCharacterRegistry,
  CharacterRuntimeState,
} from "./core/characters/types.js";
import { createCharacterRuntimeState } from "./core/characters/types.js";
import { cloneCharacterRuntimeState } from "./story/event-projection.js";
import {
  legacyGenerationIdentity,
  type GenerationIdentity,
} from "./core/ports/story-generator-port.js";
import { createInitialState } from "./story/state.js";
import type { SceneDirectorPort } from "./application/director/director-service.js";
import { buildActorBriefing } from "./application/director/actor-briefing.js";
import type {
  GeneratedEvent,
  StoryState,
} from "./story/types.js";
import type { RuntimeStatus } from "./runtime/status.js";

// 段生命周期类型已迁至 ./runtime/segment-types.ts（M4.5 交互驱动拆分）。

/**
 * Host-provided ports. The Game receives concrete adapters (Node CLI
 * wires file stores / system clock; tests wire in-memory fakes).
 */
export interface GamePorts {
  /** v2 剧情图运行时（存档读档闭环，执行清单 M1.3）。 */
  graph: RunGraphPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  /** Session id for this game instance (narrative memory binds to it).
   * Omitted → generated from `ids`. */
  sessionId?: string;
  diagnostics?: DiagnosticSink;
  narrativeDirector?: NarrativeDirectorPort;
  /** M4.1 导演服务（SceneDirective 相位门/防守节拍；M4.2 剪报组装输入）。 */
  director?: SceneDirectorPort;
  /**
   * run() 的图入口模式（M1.5）：resume = 有档续档/无档新局（默认）；
   * restart = 宿主 restart_session 重建后——弃局活跃周目并在游标节点
   * 开 retrace 新周目（无档则开新 root 周目）。
   */
  runMode?: "resume" | "restart";
  /**
   * C2 角色注册表（身份投影真源，C5 起经 bootstrap 注入）。缺席 = legacy
   * 兼容会话（窄测试直连 Game）：身份字段走 legacy 视图，历史投影退回
   * 冻结的 legacy 渲染。
   */
  characterRegistry?: CoreCharacterRegistry;
}

/** §8.4: keep only the most recent formally-opened interaction modes. */
const MAX_INTERACTION_MODE_HISTORY = 8;

export class Game implements InteractionHost {
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly events: StoredEvent[] = [];
  /**
   * §81：已提交但尚未 reconcile 的事件（microtask 单飞排空）。
   */
  private pendingReconcile: StoredEvent[] = [];
  private reconcileScheduled = false;
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly buffered = new Map<string, RuntimePlayableEvent>();
  /** @internal 交互驱动接缝（M4.5）。 */
  seq = 1;
  private readonly sessionId: string;
  /** 结算页定位 ending-report 用（M5.4；只读会话 id）。 */
  get currentSessionId(): string {
    return this.sessionId;
  }
  private readonly graph: RunGraphPort;
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly clock: ClockPort;
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly ids: IdGeneratorPort;
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly diagnostics: DiagnosticSink;
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly inputEngine = new InputEngine();
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly bridgeBuffer = new InputBridgeBuffer();
  /** line_ids of bridge narration currently staged for playback. */
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly bridgeLineIds = new Set<string>();
  /** line_ids of staged input response events (for bridge-cover timing). */
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly responseLineIds = new Set<string>();
  private readonly interactionPolicy: InteractionPolicy;
  /** §8.4: modes of formally opened interactions, newest last (cap 8). */
  private readonly recentInteractionModes: InteractionMode[] = [];
  /** Confirm timestamp awaiting the first response line (E3/G1 metric). */
  /** @internal 交互驱动接缝（M4.5）。 */
  inputConfirmAtMs: number | null = null;
  /** Bridge playback start awaiting the first response line play. */
  private bridgePlayStartedAtMs: number | null = null;
  /** @internal 交互驱动接缝（M4.5）。 */
  storyState: StoryState;
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly metrics: Metrics;
  /** @internal 交互驱动接缝（M4.5）。 */
  choiceTimestamp: number | null = null;
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly narrativeDirector: NarrativeDirectorPort | undefined;
  private readonly director: SceneDirectorPort | undefined;
  private lastDirectiveSceneId: string | undefined;
  private readonly runMode: "resume" | "restart";
  readonly playbackBuffer = new PlaybackBuffer();
  private readonly generationScheduler = new GenerationScheduler();
  /**
   * §75：低水位触发时已启动、待 run loop 接管的续写段。
   */
  private pendingRefillSegment: ActiveSegment | null = null;
  /** M5.3：同选项快进的待取恢复点（驱动器提交路径上取走）。 */
  private pendingFastForward: RestorePoint | null = null;
  /** M5.3：宿主回溯预备的恢复点（下一次 run() 直接走恢复路径）。 */
  private pendingRestore: RestorePoint | null = null;

  /** 当前模型场景 id（音频指导桥按它查询导演场景指令；角色音频特征设计 §4.2）。 */
  get currentSceneId(): string {
    return this.storyState.scene.id;
  }

  /**
   * M5.3 回溯入口（宿主调用）：在目标决策节点开启 retrace 新周目（活跃
   * 周目弃局记账、图零删除）。调用前 run 循环已因 RetraceRequestedError
   * 退出；调用后宿主重新 await game.run() 即从目标节点恢复表单。
   */
  async prepareRetrace(decisionId: string): Promise<void> {
    this.pendingRestore = await this.graph.retraceFrom(decisionId);
  }
  /** 当前正在播放的段 turn（reconcileTextBuffer 计算续写 turn 用）。 */
  private activeSegmentTurn = 1;
  private readonly commands = new AsyncEventQueue<RuntimeCommand>();
  /** M4.5：交互驱动（choice/input/hybrid + 两阶段提交 + 分支/桥接预取）。 */
  private readonly interactionDriver: InteractionDriver;
  private readonly deferredCommands: RuntimeCommand[] = [];

  // ------------------------------------------------------------------
  // DSL visual state (docs §52–§56)
  // ------------------------------------------------------------------
  private readonly catalog: AssetCatalog | undefined;
  private readonly registry: CharacterRegistry;
  private readonly defaults: PresentationDefaults;
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly reduce: (state: VisualState, cues: StageCue[]) => VisualState;
  /**
   * Predictive state after everything committed to the buffer — what the
   * next generation must see (docs §54–§55). Updated at group commit.
   */
  /** @internal 交互驱动接缝（M4.5）。 */
  tailVisualState: VisualState = createInitialVisualState();
  /**
   * What the player actually sees. Updated when a group's cues play
   * (docs §54–§55). Never runs ahead of playback.
   */
  private renderedVisualState: VisualState = createInitialVisualState();
  /** Stage cues of interaction groups, applied when the form opens. */
  private readonly pendingInteractionStage = new Map<string, StageCue[]>();
  /** Per-branch tail state (docs §56): keyed by option id. */
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly branchTailStates = new Map<string, VisualState>();
  /**
   * C5 §5.1：每预取分支的名牌状态副本（绑定 registry revision）。预测性
   * 改名只落在副本上；取消、未选、修复失败的分支副本随分支一并丢弃，
   * 绝不回写主状态。回溯（retrace）恢复重放时同理不携带预测副本。
   */
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly branchCharacterStates = new Map<string, CharacterRuntimeState>();
  /**
   * C5 §5.1：本局名牌运行时状态（v1 期间无持久改名来源，保持空——投影
   * 的名牌快照来自事件自身；v2 语义编译接入后由 label 操作更新）。
   */
  private characterState: CharacterRuntimeState = createCharacterRuntimeState();
  /** C2 角色注册表；缺席 = legacy 兼容会话。 */
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly characterRegistry: CoreCharacterRegistry | undefined;
  /** Input-bridge prefetch controllers, keyed by interaction id. */
  /** @internal 交互驱动接缝（M4.5）。 */
  readonly bridgeControllers = new Map<string, AbortController>();
  /**
   * §10.2: interaction currently open for commands, set on
   * `interaction_opened` and cleared when the interaction resolves.
   */
  /** @internal 交互驱动接缝（M4.5）。 */
  activeInteractionId: string | null = null;
  /**
   * §10.2: input preview currently open for confirm/cancel, set on
   * `input_preview_opened` and cleared on cancel/confirm.
   */
  /** @internal 交互驱动接缝（M4.5）。 */
  activePreviewId: string | null = null;
  private readonly listeners = new Set<(output: RuntimeOutput) => void>();

  constructor(
    readonly config: AppConfig,
    readonly generator: StoryGeneratorPort,
    readonly status: RuntimeStatus,
    readonly media: MediaPlannerPort,
    metrics: Metrics | undefined,
    ports: GamePorts,
    catalog?: AssetCatalog,
  ) {
    this.interactionDriver = new InteractionDriver(this);
    this.metrics = metrics ?? new Metrics();
    this.graph = ports.graph;
    this.clock = ports.clock;
    this.ids = ports.ids;
    this.diagnostics = ports.diagnostics ?? silentDiagnosticSink;
    this.narrativeDirector = ports.narrativeDirector;
    this.director = ports.director;
    this.runMode = ports.runMode ?? "resume";
    this.sessionId = ports.sessionId ?? this.ids.nextSessionId();
    this.interactionPolicy = new InteractionPolicy(config.interaction);
    this.storyState = createInitialState();
    this.catalog = catalog;
    // C7：v1 编译边界的展示注册表由 C2 roster 派生（toCharacterRegistry
    // 接收 roster，资产目录 characters 兼容形状已移除）；registry 缺席的
    // 窄测试/legacy 世界走 EMPTY_CHARACTER_REGISTRY。
    this.registry = ports.characterRegistry
      ? toCharacterRegistry(ports.characterRegistry.roster)
      : EMPTY_CHARACTER_REGISTRY;
    this.characterRegistry = ports.characterRegistry;
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
    this.emit({
      type: "session_started",
      sessionId: this.sessionId,
      location: this.graph.location,
    });

    // 「继续游戏」统一入口（M1.4/M1.5）：有游标 → 入口快照重建运行时并
    // 重放表单（restart 模式则先弃局旧周目、开 retrace 新周目）；周目已
    // 完结 → 只补发结局（restart 模式改开新 root 周目）；否则全新开局。
    // M5.3：宿主回溯（prepareRetrace）已备好恢复点 → 直接走恢复路径。
    let resume: RunResume;
    if (this.pendingRestore !== null) {
      resume = { kind: "active", restore: this.pendingRestore };
      this.pendingRestore = null;
    } else {
      resume = await this.graph.restoreOrCreateRun({ restart: this.runMode === "restart" });
    }
    if (resume.kind === "ended") {
      this.status.setPhase("结束", "剧情已经结束");
      this.emit({
        type: "session_ended",
        ending: {
          type: "end",
          ending_id: resume.endingId,
          text: resume.endingText ?? "（故事已落幕。）",
        },
      });
      return;
    }

    let segment: ActiveSegment;
    let outcome: SegmentOutcome;
    if (resume.kind === "active") {
      this.events.length = 0;
      segment = this.startRestoredSegment(resume.restore);
      outcome = await this.resumeRestoredInteraction(segment);
    } else {
      // fresh：seq 从世界最大值播种（M2.1 决议）——同一世界的新 root 周目
      // （结局后再玩）不得与既有周目的边负载 seq 重叠。
      this.seq = resume.nextSeq;
      this.status.setPhase("开场生成", "首条完整事件到达后立即进入播放缓冲");
      segment = this.startActiveSegment("opening", 1, [], []);
      outcome = await this.consumeActiveSegment(segment, 1, []);
    }

    while (outcome.type !== "end") {
      // M5.3 同选项快进：跳过生成，直接恢复既有后继节点的表单（与开机恢复
      // 同一机制；会话内累积历史由恢复点路径重放重建）。
      if (outcome.type === "fast_forward") {
        this.activeInteractionId = null;
        this.activePreviewId = null;
        this.events.length = 0;
        segment = this.startRestoredSegment(outcome.restore);
        outcome = await this.resumeRestoredInteraction(segment);
        continue;
      }
      // DSL mode: the segment ended cleanly with `@end ... buffer`. Its
      // events were already buffered and played while streaming; start a
      // low-water refill continuation from the committed history (docs
      // §74–§76). No new interaction is pending.
      if (outcome.type === "buffer") {
        this.activeInteractionId = null;
        this.activePreviewId = null;
        const historyBefore = [...this.events];
        this.status.setPhase("后台续写", "缓冲段自然收束，启动续写");
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
            undefined,
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
        await this.interactionDriver.consumeLiveSelection(
          currentOutcome.preview,
          currentOutcome.liveSelection,
          currentOutcome.nextTurn,
        );
      } else if (currentOutcome.liveResponse) {
        await this.interactionDriver.consumeLiveInputResponse(
          currentOutcome.preview,
          currentOutcome.liveResponse,
          currentOutcome.nextTurn,
        );
      } else {
        await this.interactionDriver.consumePlayableEvents(currentOutcome.preview, currentOutcome.nextTurn);
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
    }
  }

  /**
   * M1.4（游标恢复）：从决策节点入口快照完整重建运行时。快照是唯一真源
   * （M1.1 决议）：story/visual 两态直接还原；导演记忆先 restoreFromDigest
   * 再全路径重放（observeCommitted 内部按 seq 水位过滤，恰好只入队未整理
   * 窗口）；seq/turn 计数器按恢复点播种（下一个分配槽位），周目内单调。
   */
  private startRestoredSegment(restore: RestorePoint): ActiveSegment {
    const entry = restore.decision.entryState;
    const interaction = interactionFromFormSnapshot(
      restore.decision.form,
      `interaction_${restore.turnFloor}`,
    );
    this.storyState = entry.storyState;
    this.tailVisualState = entry.visualState;
    this.renderedVisualState = entry.visualState;
    this.narrativeDirector?.restoreFromDigest(entry.memoryDigest);
    this.narrativeDirector?.observeCommitted(restore.pathEvents);
    this.events.push(...restore.pathEvents);
    this.seq = restore.nextSeq;
    this.activeSegmentTurn = restore.turnFloor;
    this.status.setPhase("恢复游戏", "已从上次决策点还原，等待你的决定");
    const segment: ActiveSegment = {
      turn: restore.turnFloor,
      taskId: this.ids.nextGenerationId(`resume:${restore.turnFloor}`),
      events: [interaction],
      queue: new AsyncEventQueue<RuntimeModelEvent>(),
      done: Promise.resolve(),
      branchManager: this.interactionDriver.createBranchManagerForTerminal(
        interaction,
        restore.turnFloor,
        [...this.events],
      ),
      terminal: interaction,
      schedulerReleased: true,
      endStatus: null,
      failed: false,
    };
    this.pendingInteractionStage.set(interaction.interaction_id, []);
    return segment;
  }

  /** 恢复表单的决策等待回路：与正常打开完全相同的处理函数，不重复生成。 */
  private async resumeRestoredInteraction(segment: ActiveSegment): Promise<SegmentOutcome> {
    const interaction = segment.terminal;
    if (interaction === null || interaction.type !== "interaction") {
      throw new Error("恢复段缺少交互事件（内部不变量被破坏）");
    }
    const turn = segment.turn;
    const context = [...this.events];
    if (interaction.mode === "choice") {
      const choice: ChoiceEvent = {
        type: "choice",
        prompt: interaction.prompt,
        options: interaction.options.map((option) => ({ id: option.id, text: option.text })),
      };
      const result = await this.interactionDriver.handleChoice(
        choice,
        turn,
        segment.branchManager,
        context,
        interaction.interaction_id,
      );
      // M5.3：恢复表单上再次选择同一选项 → 级联快进（零生成）。
      if (result.fastForward !== undefined) {
        return { type: "fast_forward", restore: result.fastForward, nextTurn: turn + 1 };
      }
      return { type: "choice", nextTurn: turn + 1, ...result };
    }
    if (interaction.mode === "hybrid") {
      const hybridOutcome = await this.interactionDriver.handleHybridInteraction(interaction, turn, segment.branchManager, context);
      // M5.3：hybrid 恢复表单命中快进 → 与 choice 分支对称透传，否则游标
      // 已前移而运行循环仍按空 preview 续跑（陈旧事件滞留 + seq 复用）。
      if (hybridOutcome.type === "choice" && hybridOutcome.fastForward !== undefined) {
        return { type: "fast_forward", restore: hybridOutcome.fastForward, nextTurn: turn + 1 };
      }
      return hybridOutcome;
    }
    const result = await this.interactionDriver.handleInteractionInput(interaction, turn, segment.branchManager);
    if (result.type !== "committed") throw new RuntimeShutdownError();
    if (result.fastForward !== undefined) {
      return { type: "fast_forward", restore: result.fastForward, nextTurn: turn + 1 };
    }
    return {
      type: "choice",
      nextTurn: turn + 1,
      preview: result.preview,
      ...(result.liveResponse ? { liveResponse: result.liveResponse } : {}),
    };
  }

  private async prepareContinuationAfterSelection(
    previousSegment: ActiveSegment,
    outcome: ChoiceOutcome,
    history: StoryContextEvent[],
  ): Promise<ActiveSegment> {
    const live = outcome.liveSelection;
    const liveResponse = outcome.liveResponse;
    // 旧的活动请求在发出 terminal 后可能仍在收尾；等它释放调度器再续写。
    await previousSegment.done.catch(() => undefined);

    if (liveResponse) {
      // The confirmed response stream is still running. Its remaining events
      // join the committed prefix: player line + bridge + full response. No
      // new LLM request is created until the response task completes.
      await liveResponse.done.catch(() => undefined);
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
        undefined,
      );
    }

    if (!live) {
      return this.startActiveSegment(
        "continuation",
        outcome.nextTurn,
        history,
        outcome.preview,
        undefined,
      );
    }

    // The old active request may still be closing after emitting its terminal
    // event. Once it releases the scheduler, promote the existing branch
    // controller. The branch request itself is never restarted.
    this.generationScheduler.adoptCandidateBranch(
      live.taskId,
      live.branchId,
      live.controller,
    );
    void live.done.then(
      () => this.generationScheduler.completeActivePath(live.taskId),
      () => this.generationScheduler.completeActivePath(live.taskId),
    );
    await live.done.catch(() => undefined);
    const selectedEvents = [...live.events];
    return this.startActiveSegment(
      "continuation",
      outcome.nextTurn,
      history,
      selectedEvents,
      undefined,
    );
  }

  /**
   * §8.5/§13.1: enforce InteractionPolicy BEFORE a terminal enters the
   * formal buffer. A rejection throws, which fails the current generation
   * attempt and routes it into the repair loop; nothing (buffer, bridge,
   * BranchManager, interaction_opened) is published for the illegal event.
   */
  assertInteractionPolicy(event: InteractionEvent): void {
    // M4.3 相位门：当前场景 directive.formModes 收窄 allowed_modes。
    const directive = this.director?.getDirective(this.storyState.scene.id);
    const result = this.interactionPolicy.validate(
      event,
      { previousModes: this.recentInteractionModes },
      directive?.formModes,
    );
    if (!result.accepted) {
      throw new InteractionPolicyViolationError(result.reason ?? "策略校验失败。");
    }
  }

  /**
   * §8.4: record the mode of a formally opened interaction (newest last).
   * Only accepted terminals reach this point — unselected candidates,
   * failed-repair interactions, and input-response fragments never record.
   */
  recordInteractionMode(mode: InteractionMode): void {
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
    const brief = this.makeBriefing(turn);
    segment.done = this.runTrackedJob(jobId, label, async () => {
      const genHandle =
        kind === "opening"
          ? this.generator.generateOpening({
              identity: this.generationIdentity(),
              turn,
              state: this.storyState,
              signal: controller.signal,
              ...(brief !== undefined && brief !== "" ? { briefing: brief } : {}),
              tailVisualState: this.tailVisualState,
            })
          : this.generator.generateContinuation({
              identity: this.generationIdentity(),
              turn,
              state: this.storyState,
              history,
              prefetchedEvents,
              signal: controller.signal,
              ...(brief !== undefined && brief !== "" ? { briefing: brief } : {}),
              tailVisualState: this.tailVisualState,
              ...(repairReason !== undefined ? { repairReason } : {}),
            });

      // 泵：把 handle 的事件流喂进段队列（与旧 onGroup 直连语义等价）。
      const pump = (async () => {
        for await (const group of genHandle.events) {
          onGroup(group);
        }
      })();

      try {
        const envelope = await genHandle.done;
        await pump;
        // 段结束状态由 envelope 携带（旧 onSegmentEnd 语义）；envelope.groups
        // 已通过 handle 事件流到达，不再重复喂养（避免双份）。
        if (envelope.segmentEnd !== undefined && segment.endStatus === null) {
          onSegmentEnd(envelope.segmentEnd);
        }
      } catch (error) {
        // 失败段标记必须与任务失败同拍设置：advance-trigger 的低水续写
        // 与修复路径竞争单槽调度器，任何微任务延迟都会让杂散续写先占住
        // startActivePath（修复 startActiveSegment 抛错杀死 run()）。
        segment.failed = true;
        // I1：失败路径也要排空泵。done 拒绝时泵仍在后台排空缓冲组；若某
        // 组让 handleDslGroup 抛错（如 InteractionPolicy 拒绝），泵的拒绝
        // 会成为未处理拒绝（Node unhandledRejection=throw 崩溃进程），且
        // 失败快照读取前段事件未全部落位。带拒绝处理排空后再抛原始错误。
        await pump.catch(() => undefined);
        throw error;
      }
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
    // Fail-fast 修复续写（自 campus 线 6365683 移植）：失败落定（泵排空、
    // events 定型）即并行启动修复段——玩家读完保留前缀时修复段前几行通常
    // 已就绪，消除"读空队列 → 冷启动 TTFT"空窗。守卫见 maybeStartEarlyRepair。
    void this.maybeStartEarlyRepair(segment, priorContext);
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
        // 收养提前启动的修复段时不清播放缓冲：修复段生成期间已把可读行
        // 写进缓冲（这正是 fail-fast 的收益），清掉会把它们连顺序校验一起
        // 破坏。失败段自身的行此刻已被玩家全部消费，缓冲中只剩修复段的行。
        if (segment.earlyRepair === undefined) {
          this.playbackBuffer.clear();
        }
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
          // 收养提前启动的修复段（若有）；提前启动不可用（调度槽被占等）
          // 时回退为现场启动。两者种子一致（fullContext + playable + 失败
          // 原因），消费逻辑完全相同。
          const repaired =
            segment.earlyRepair ??
            this.startActiveSegment(
              "continuation",
              turn,
              fullContext,
              playable,
              failure.message,
            );
          segment.earlyRepair = undefined;
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
        await this.concludeRun(event);
        this.emit({ type: "session_ended", ending: event });
        return { type: "end" };
      }

      this.advanceBufferedEvent(event);
      await this.recordModelEvent(event, turn);
      // 交互正式打开：决策节点 + 入口快照 + 游标推进（前一条边在此收束）。
      await this.graph.openDecision({
        modelSceneId: this.storyState.scene.id,
        form: formSnapshotFromInteraction(event),
        moment: this.currentMoment(),
      });
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
        const preview = await this.interactionDriver.handleChoice(syntheticChoice, turn, segment.branchManager, context, event.interaction_id);
        // M5.3 同选项快进：驱动器命中既有出边 → 零生成，运行循环切恢复表单。
        if (preview.fastForward !== undefined) {
          return { type: "fast_forward", restore: preview.fastForward, nextTurn: turn + 1 };
        }
        return { type: "choice", nextTurn: turn + 1, ...preview };
      }

      if (event.mode === "hybrid") {
        const hybridOutcome = await this.interactionDriver.handleHybridInteraction(event, turn, segment.branchManager, context);
        if (hybridOutcome.type === "choice" && hybridOutcome.fastForward !== undefined) {
          return { type: "fast_forward", restore: hybridOutcome.fastForward, nextTurn: turn + 1 };
        }
        return hybridOutcome;
      }

      const committed = await this.interactionDriver.handleInteractionInput(event, turn, segment.branchManager);
      // A pure input never cancels back out of the commit loop; only the
      // hybrid path returns the canceled sentinel.
      if (committed.type !== "committed") throw new RuntimeShutdownError();
      if (committed.fastForward !== undefined) {
        return { type: "fast_forward", restore: committed.fastForward, nextTurn: turn + 1 };
      }
      return {
        type: "choice",
        nextTurn: turn + 1,
        preview: committed.preview,
        ...(committed.liveResponse ? { liveResponse: committed.liveResponse } : {}),
      };
    }
  }

  /**
   * Fail-fast 修复续写（自 campus 线 6365683 移植）：段失败落定即后台启动
   * 修复段，不等玩家读空队列。守卫：
   * - terminal 已入队（表单打开后断流）不提前修复——孤儿修复段会占住单
   *   调度槽，玩家选择后抛 "current status is streaming" 杀死 run()
   *   （campus 审计 F1 实证复现；此时消费循环的收养路径也不会触发，
   *   因为交互分支先于队列读空返回）；
   * - 无可播放前缀且非策略拒绝：本就 fatal，消费循环负责抛出；
   * - startActiveSegment 抛错（调度槽被杂散续写占住等）：静默回退——
   *   消费循环读空队列时自行启动，行为与移植前一致。
   */
  private async maybeStartEarlyRepair(
    segment: ActiveSegment,
    priorContext: StoryContextEvent[],
  ): Promise<void> {
    if (segment.earlyRepair !== undefined) return;
    const failure = await segment.done.then(
      () => null,
      (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
    );
    if (failure === null) return; // 干净收束（buffer/interaction/ending）——无修复
    if (segment.terminal !== null) return; // F1 守卫
    const playable = segment.events.filter(isPlayableEvent);
    const policyRejected =
      failure instanceof InteractionPolicyViolationError ||
      failure.cause instanceof InteractionPolicyViolationError ||
      failure.message.includes("InteractionPolicy 拒绝");
    if (playable.length === 0 && !policyRejected) return; // fatal 路径，交给消费循环抛出
    const fullContext = [...priorContext, ...segment.events];
    try {
      const repaired = this.startActiveSegment(
        "continuation",
        segment.turn,
        fullContext,
        playable,
        failure.message,
      );
      void repaired.done.catch(() => undefined);
      segment.earlyRepair = repaired;
      this.diagnostics.info(
        "Repair",
        `修复段已提前启动（读空队列前）：保留 ${playable.length} 条事件`,
      );
    } catch {
      // 调度槽被占 → 回退消费循环现场启动（移植前行为）。
    }
  }

  emit(output: RuntimeOutput): void {
    for (const listener of this.listeners) listener(output);
  }

  /**
   * Publish `interaction_resolved` for `interactionId` — the interaction
   * can no longer be submitted from that moment on (§5.4). Callers release
   * the active interaction scope immediately after.
   */
  /**
   * Await the next command matching `predicate`. Commands that do not
   * match are deferred and re-checked by later waiters — except §10.2
   * stale interaction commands, which are dropped so a resolved
   * interaction can never accumulate commands for later waiters.
   */
  async waitForCommand(
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
      if (command.type === "restart_session") throw new RestartRequestedError();
      if (command.type === "retrace") throw new RetraceRequestedError(command.decisionId);
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
  async waitForInteractionCommand(
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
  compileGroup(
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
      const interaction = this.interactionDriver.buildRuntimeInteraction(main.interaction, turn);
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
        this.interactionDriver.startBridgePrefetch(interaction, turn);
      }
      const context = [...history, ...segment.events];
      segment.branchManager = this.interactionDriver.createBranchManagerForTerminal(interaction, turn, context);
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
   * Apply an interaction group's stage cues when the form opens and return
   * the presentation delta (docs §65). Idempotent per interaction id.
   */
  openInteractionStage(interactionId: string): StagePresentationDelta | undefined {
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

  advanceBufferedEvent(event: RuntimeBufferEvent): void {
    const bufferedEvent = this.playbackBuffer.advance();
    if (bufferedEvent && bufferedEvent !== event) {
      throw new Error("播放缓冲顺序与生成事件流不一致。");
    }
  }

  async consumePlayableEvent(
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
      await this.interactionDriver.recordPlayerDialogue(event, turn);
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
    // “前缀不足 threshold 且已失败”时卡死。
    //
    // 等待是事件驱动的：缓冲水位只会在变更时升高，PlaybackBuffer.changed()
    // 在每次入队/推进/清理时唤醒本循环；段结束由 done 的 settled 影子
    // promise 唤醒。无轮询、无忙等。
    let settled = false;
    const settledOrDone = segment.done.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (this.playbackBuffer.countTextLinesAhead() < threshold) {
      if (segment.endStatus !== null || settled) return;
      await Promise.race([settledOrDone, this.playbackBuffer.changed()]);
    }
  }

  nextLineId(): string {
    return this.ids.nextLineId(this.sessionId);
  }

  registerBuffered(events: RuntimePlayableEvent[]): void {
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
  /**
   * Compile DSL groups into materialized playable events, chaining the
   * visual state across groups. Used by branch prefetch and input-response
   * paths (docs §56, §79).
   */
  materializeDslGroups(
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
  /**
   * Start one input response generation that streams events into the
   * session. Returns the settled promise and the abort controller.
   */
  /**
   * Stage one response event, measuring the confirm → first-line window.
   */
  async record(event: StoredEvent): Promise<"recorded" | "fast_forwarded"> {
    this.events.push(event);
    // M5.3 同选项快进：玩家解决事件先与图对账——若与游标节点既有出边
    // 完全一致（kind+text 严格相等、指向决策节点），协调器不开新边而是
    // 直接前移到既有后继；Game 跳过生成，恢复后继表单。
    if (event.type === "player_choice") {
      const result = await this.graph.beginEdge({ kind: "option", text: event.text });
      if (result.kind === "fast_forward") {
        this.seq -= 1; // 归还预分配槽位：选择事件不入新边（历史负载已有）
        this.pendingFastForward = result.restore;
        return "fast_forwarded";
      }
    } else if (event.type === "player_input") {
      const result = await this.graph.beginEdge({ kind: "free_input", text: event.text });
      if (result.kind === "fast_forward") {
        this.seq -= 1;
        this.pendingFastForward = result.restore;
        return "fast_forwarded";
      }
      // M4.3 防守节拍：评估与生成并行（滞后一拍——本段按既有 directive
      // 播出，引回写入下一段 directive），绝不阻塞演出。
      void this.director
        ?.evaluateFreeInput({
          sceneId: this.storyState.scene.id,
          scenePurpose: this.storyState.scene.purpose,
          playerInput: event.text,
          recentSummary: this.storyState.recent_summary,
        })
        .catch((err: unknown) => {
          this.diagnostics.warn("Game", `defense evaluation failed: ${String(err)}`);
        });
    }
    await this.graph.appendEdgeEvents([event]);
    this.narrativeDirector?.observeCommitted([event]);
    this.scheduleReconcile(event);
    return "recorded";
  }

  /** M5.3：驱动器在提交路径上取走快进恢复点（一次）。 */
  takePendingFastForward(): RestorePoint | undefined {
    const restore = this.pendingFastForward;
    this.pendingFastForward = null;
    return restore ?? undefined;
  }

  /**
   * 快照时刻的运行时状态（决策入口/结局末态共用）——记忆真源来自导演
   * 子层摘要（M1.1 决议），visualState 取玩家实际所见。
   */
  private currentMoment() {
    const memoryDigest: MemoryDigest =
      this.narrativeDirector?.getMemoryDigest() ?? EMPTY_MEMORY_DIGEST;
    return {
      storyState: this.storyState,
      visualState: this.renderedVisualState,
      memoryDigest,
      outlineRevision: this.graph.currentOutlineRevision(),
    };
  }

  /** 结局收束：结局节点 + 末态快照内联 + 周目完结 + 游标清除。 */
  private async concludeRun(ending: EndEvent): Promise<void> {
    this.status.setPhase("结束", "剧情已经结束");
    await this.graph.reachEnding({ endingId: ending.ending_id, moment: this.currentMoment() });
  }

  /** 已注册角色 id 集合——reconcile 用它挡住幻影发言者入库（上下文污染）。 */
  private knownCharacterIds(): ReadonlySet<string> | undefined {
    // C7：角色 ID 真源是 C2 registry（roster）；registry 缺席（窄测试/
    // legacy 世界）返回 undefined（调用方语义：不做过滤），不再从资产目录推导。
    return this.characterRegistry !== undefined
      ? new Set(this.characterRegistry.roster.characters.map((definition) => definition.id))
      : undefined;
  }

  /** §81: 事件正式提交后异步 reconcile StoryState（不在玩家等待关键路径）。 */
  private scheduleReconcile(event: StoredEvent): void {
    this.pendingReconcile.push(event);
    if (this.reconcileScheduled) return;
    this.reconcileScheduled = true;
    queueMicrotask(() => {
      this.reconcileScheduled = false;
      if (this.pendingReconcile.length === 0) return;
      const batch = this.pendingReconcile;
      this.pendingReconcile = [];
      this.storyState = reconcileStoryState(this.storyState, batch, {
        knownCharacterIds: this.knownCharacterIds(),
      });
      // M4.1/M4.3 生产接线：场景边界（scene.id 变化）→ 导演后台刷新
      // SceneDirective（fire-and-forget，滞后不影响本段播放）。
      const sceneId = this.storyState.scene.id;
      if (sceneId !== this.lastDirectiveSceneId) {
        this.lastDirectiveSceneId = sceneId;
        this.director?.triggerDirective({
          sceneId,
          scenePurpose: this.storyState.scene.purpose,
          recentSummary: this.storyState.recent_summary,
          // M2 §6.2：显式会话场景名单（roster NPC——含电话/画外角色，不从
          // 立绘推导，也不从累计 state.keys 重建）；voice 键按它严格校验，
          // 音频调色板段同源（角色音频特征设计 V1）。
          cast: this.directorSceneCast(),
        });
      }
    });
  }

  /**
   * M2 §6.2：导演场景名单——显式会话 cast 上下文（与 generationIdentity
   * 的允许说话人同一权威：roster NPC，含电话/画外/无立绘角色；玩家由
   * 运行时代言，不进模型 voice 指导名单）。registry 缺席的 legacy 会话
   * 退 v1 资产注册表 ID（仍不是累计 state.keys 重建）。
   */
  private directorSceneCast(): string[] {
    if (this.characterRegistry !== undefined) {
      return this.characterRegistry.roster.characters
        .filter((definition) => definition.control === "npc")
        .map((definition) => definition.id);
    }
    return this.registry.entries().map((entry) => entry.characterId);
  }

  private makeBrief(turn: number): MemoryProjection | undefined {
    if (!this.narrativeDirector) return undefined;
    return this.narrativeDirector.getMemoryProjection({
      turn,
      // The last COMMITTED event seq (this.seq is the next slot to
      // allocate) — the brief's currentEventSeq must not lie about the
      // story front (audit finding 9).
      eventSeq: this.seq - 1,
      location: this.storyState.scene.location,
      characters: Object.keys(this.storyState.characters),
    });
  }

  /**
   * M4.2 剪报通道：MemoryProjection（记忆投影）+ 导演 SceneDirective 组装成
   * 演员剪报文本。输入类型上不含 outline 全量/结局候选/他周目数据——防火墙
   * 落为参数形状（§5.2）。
   */
  makeBriefing(turn: number): string | undefined {
    const brief = this.makeBrief(turn);
    const directive = this.director?.getDirective(this.storyState.scene.id);
    if (brief === undefined && directive === undefined) return undefined;
    return buildActorBriefing({
      ...(brief !== undefined
        ? { memoryBrief: brief, rawEventCount: this.events.length }
        : {}),
      ...(directive !== undefined ? { directive } : {}),
    });
  }

  /**
   * C5 §5.1：本请求的身份上下文——所有生成请求显式携带
   * {protocolVersion, rosterRevision, cast, characterState}。registry 缺席
   * （legacy 兼容会话/窄测试）走 legacy 视图（revision="legacy"，cast 取
   * v1 素材目录注册表），不静默伪造 roster revision。
   *
   * `branchOptionId` 非空 = 预取分支请求：characterState 取该分支的预测
   * 副本（绑定本局 roster revision；未选/取消/修复失败即丢弃）。
   */
  /** @internal 交互驱动接缝（M4.5）。 */
  generationIdentity(branchOptionId?: string): GenerationIdentity {
    const registry = this.characterRegistry;
    if (registry === undefined) {
      const ids = this.registry.entries().map((entry) => entry.characterId);
      return legacyGenerationIdentity({
        allowedSpeakerIds: ids,
        sceneParticipantIds: ids,
      });
    }
    const npcIds = registry.roster.characters
      .filter((definition) => definition.control === "npc")
      .map((definition) => definition.id);
    const base =
      branchOptionId !== undefined
        ? this.branchCharacterStates.get(branchOptionId)
        : undefined;
    return {
      // 窄测试 config 可缺 dsl 块（zod 缺省 1）；直连构造的对象兜底 1。
      protocolVersion: this.config.dsl?.protocol_version ?? 1,
      rosterRevision: registry.roster.revision,
      // 场景参与者 = 本局 roster 全体（含电话/画外角色；不从立绘推导）。
      // 场景计划接入（后续波次）后改由场景计划给出。
      cast: {
        allowedSpeakerIds: npcIds,
        sceneParticipantIds: registry.roster.characters.map((definition) => definition.id),
      },
      characterState: cloneCharacterRuntimeState(base ?? this.characterState),
    };
  }

  /** 选中分支的预测名牌副本转正（未选/取消分支的副本随 clear 丢弃）。 */
  /** @internal 交互驱动接缝（M4.5）。 */
  promoteBranchCharacterState(optionId: string): void {
    const branchLabels = this.branchCharacterStates.get(optionId);
    if (branchLabels !== undefined) {
      this.characterState = branchLabels;
    }
    this.branchCharacterStates.clear();
  }

  /**
   * 关停清理（audit P1-7）：导演层整理并落盘。v2 图记录随写随落
   * （决策点快照/边负载/游标），无需段间状态快照。
   */
  async flush(): Promise<void> {
    if (this.narrativeDirector !== undefined) {
      await this.narrativeDirector.flush();
    }
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
