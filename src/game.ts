import path from "node:path";
import type { AppConfig } from "./config.js";
import { InputEngine } from "./interaction/input-engine.js";
import { JsonlSessionStore } from "./jsonl.js";
import type { StoryGenerator } from "./llm.js";
import type { MediaPrefetchScheduler } from "./media.js";
import { BranchManager } from "./runtime/branch-manager.js";
import type { LiveBranchSelection } from "./prefetch.js";
import { GenerationScheduler } from "./runtime/generation-scheduler.js";
import { Metrics } from "./runtime/metrics.js";
import type { MetricsSnapshot } from "./runtime/metrics.js";
import { PlaybackBuffer } from "./runtime/playback-buffer.js";
import type {
  ChoiceEvent,
  ChoiceOption,
  InteractionEvent,
  ModelEvent,
  ModelPlayableEvent,
  RuntimeModelEvent,
  RuntimePlayableEvent,
  StoredEvent,
  StoredModelEvent,
  StoredPlayerChoiceEvent,
  StoredPlayerInputEvent,
  StoryContextEvent
} from "./schema.js";
import { isPlayableEvent } from "./schema.js";
import { applyPatch } from "./story/patch.js";
import { createInitialState, saveStateSnapshot } from "./story/state.js";
import type { GeneratedEvent, StoryState, StoryStatePatch } from "./story/types.js";
import type { RuntimeStatus } from "./status.js";
import type { GameUI, TerminalUI } from "./ui.js";

function createSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

interface PreparedSegment {
  turn: number;
  events: RuntimeModelEvent[];
  branchManager: BranchManager | null;
  prefetchContext: StoryContextEvent[];
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined as T, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as T, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface ActiveSegment {
  turn: number;
  taskId: string;
  events: RuntimeModelEvent[];
  queue: AsyncEventQueue<RuntimeModelEvent>;
  done: Promise<void>;
  branchManager: BranchManager | null;
  terminal: RuntimeModelEvent | null;
  schedulerReleased: boolean;
}

type ActiveSegmentKind = "opening" | "continuation";

interface ChoiceOutcome {
  type: "choice";
  nextTurn: number;
  preview: RuntimePlayableEvent[];
  liveSelection?: LiveBranchSelection;
}

type ChoiceSelection = Pick<ChoiceOutcome, "preview" | "liveSelection">;

interface EndOutcome {
  type: "end";
}

type SegmentOutcome = ChoiceOutcome | EndOutcome;

export class Game {
  private readonly events: StoredEvent[] = [];
  private readonly buffered = new Map<string, RuntimePlayableEvent>();
  private seq = 1;
  private lineSeq = 1;
  private readonly sessionId = createSessionId();
  private readonly store: JsonlSessionStore;
  private readonly inputEngine = new InputEngine();
  private storyState: StoryState;
  private readonly metrics: Metrics;
  private choiceTimestamp: number | null = null;
  private readonly playbackBuffer = new PlaybackBuffer();
  private readonly generationScheduler = new GenerationScheduler();

  constructor(
    private readonly config: AppConfig,
    private readonly generator: StoryGenerator,
    private readonly status: RuntimeStatus,
    private readonly ui: GameUI,
    private readonly media: MediaPrefetchScheduler,
    metrics?: Metrics,
  ) {
    this.metrics = metrics ?? new Metrics();
    this.store = new JsonlSessionStore(config.game.sessions_dir, this.sessionId);
    this.storyState = createInitialState();
  }

  /** Return an immutable snapshot of all collected runtime metrics. */
  getMetrics(): MetricsSnapshot {
    return this.metrics.snapshot();
  }

  async run(): Promise<void> {
    await this.store.initialize();
    this.ui.printSession(this.sessionId, this.store.filePath);

    this.status.setPhase("开场生成", "首条完整事件到达后立即进入播放缓冲");
    let segment = this.startActiveSegment("opening", 1, [], []);
    void segment.done.catch(() => undefined);
    let outcome = await this.consumeActiveSegment(segment, 1, []);

    while (outcome.type !== "end") {
      const currentOutcome = outcome;
      const historyBeforePreview = [...this.events];
      const speculativeContext: StoryContextEvent[] = [
        ...historyBeforePreview,
        ...currentOutcome.preview,
      ];

      // The selected branch is already the next active generation task. Its
      // existing events enter the formal buffer now; later events are routed
      // into the same buffer by the live task subscription. No new LLM
      // request is created until this task naturally completes.
      this.playbackBuffer.enqueueMany(currentOutcome.preview);
      for (const event of currentOutcome.preview) this.registerBuffered([event]);
      this.status.setPhase("后台续写", "已选分支接管正式路径，低水位时持续流式补充");

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
      } else {
        await this.consumePlayableEvents(currentOutcome.preview, currentOutcome.nextTurn);
      }
      segment = await continuationPromise;
      void segment.done.catch(() => undefined);
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
    const waitForPrevious = previousSegment.done.catch(() => undefined);

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

  private startActiveSegment(
    kind: ActiveSegmentKind,
    turn: number,
    history: StoryContextEvent[],
    prefetchedEvents: StoryContextEvent[],
  ): ActiveSegment {
    const queue = new AsyncEventQueue<RuntimeModelEvent>();
    const taskId = `${kind}:${turn}:${Date.now()}`;
    const segment: ActiveSegment = {
      turn,
      taskId,
      events: [],
      queue,
      done: Promise.resolve(),
      branchManager: null,
      terminal: null,
      schedulerReleased: false,
    };

    const controller = this.generationScheduler.startActivePath(taskId);
    const onEvent = (draft: ModelEvent): void => {
      const event = this.materializeEvents([draft])[0]!;
      segment.events.push(event);
      if (isPlayableEvent(event)) {
        this.registerBuffered([event]);
        this.media.appendActive([event]);
      }
      this.playbackBuffer.enqueue(event);
      queue.push(event);

      if (event.type === "choice" || event.type === "interaction" || event.type === "end") {
        segment.terminal = event;
        if (event.type !== "end") {
          const context = [...history, ...segment.events];
          segment.branchManager = this.createBranchManagerForTerminal(event, turn, context);
        }
        this.reconcileTextBuffer();
      }
    };

    const jobId = kind === "opening" ? "opening" : `continuation:${turn}`;
    const label = kind === "opening" ? "初始剧情" : `第 ${turn} 回合后续`;
    segment.done = this.runTrackedJob(jobId, label, () => {
      const request = kind === "opening"
        ? this.generator.generateOpening(turn, this.storyState, controller.signal, { onEvent })
        : this.generator.generateContinuation(
            turn,
            this.storyState,
            history,
            prefetchedEvents,
            controller.signal,
            { onEvent },
          );

      return request.then((envelope) => {
        // Test doubles and envelope-format providers do not invoke onEvent.
        // Preserve the same runtime behavior by feeding their events here.
        if (segment.events.length === 0) {
          for (const draft of envelope.events) onEvent(draft);
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

    return segment;
  }

  private async consumeActiveSegment(
    segment: ActiveSegment,
    turn: number,
    priorContext: StoryContextEvent[],
  ): Promise<SegmentOutcome> {
    while (true) {
      const next = await segment.queue.next();
      if (next.done) {
        await segment.done;
        throw new Error("生成段结束时没有收到 choice、interaction 或 end 事件。");
      }

      const event = next.value;
      if (isPlayableEvent(event)) {
        await this.consumePlayableEvent(event, turn);
        continue;
      }

      if (event.type === "end") {
        this.advanceBufferedEvent(event);
        await this.recordModelEvent(event, turn);
        segment.branchManager?.discardAll();
        this.status.setPhase("结束", "剧情已经结束");
        this.ui.renderEnd(event);
        return { type: "end" };
      }

      this.advanceBufferedEvent(event);
      await this.recordModelEvent(event, turn);
      const context = [...priorContext, ...segment.events];
      if (event.type === "choice") {
        const preview = await this.handleChoice(event, turn, segment.branchManager, context);
        return { type: "choice", nextTurn: turn + 1, ...preview };
      }

      if (event.mode === "choice") {
        const syntheticChoice: ChoiceEvent = {
          type: "choice",
          prompt: event.prompt,
          options: event.options!.map((option) => ({ id: option.id, text: option.text })),
        };
        const preview = await this.handleChoice(syntheticChoice, turn, segment.branchManager, context);
        return { type: "choice", nextTurn: turn + 1, ...preview };
      }

      if (event.mode === "hybrid") {
        if (!event.options || !event.input) {
          throw new Error("hybrid 模式需要同时提供 options 和 input 字段。");
        }
        return this.handleHybridInteraction(
          event as InteractionEvent & {
            options: NonNullable<InteractionEvent["options"]>;
            input: NonNullable<InteractionEvent["input"]>;
          },
          turn,
          segment.branchManager,
          context,
        );
      }

      const preview = await this.handleInteractionInput(event, turn, segment.branchManager);
      return { type: "choice", nextTurn: turn + 1, preview };
    }
  }

  private createBranchManagerForTerminal(
    terminal: ChoiceEvent | InteractionEvent,
    turn: number,
    context: StoryContextEvent[],
  ): BranchManager | null {
    if (terminal.type === "choice") {
      return this.createBranchManager(terminal, turn, context);
    }
    if (terminal.mode === "choice" || terminal.mode === "hybrid") {
      const choice: ChoiceEvent = {
        type: "choice",
        prompt: terminal.prompt,
        options: terminal.options!.map((option) => ({ id: option.id, text: option.text })),
      };
      return this.createBranchManager(choice, turn, context, terminal.interaction_id, "choice");
    }
    return null;
  }

  private prepareTerminalSegment(
    turn: number,
    drafts: ModelEvent[],
    priorContext: StoryContextEvent[]
  ): PreparedSegment {
    const events = this.materializeEvents(drafts);
    const playable = events.filter(isPlayableEvent);
    this.registerBuffered(playable);
    this.media.appendActive(playable);

    const terminal = events[events.length - 1];
    if (
      !terminal ||
      (terminal.type !== "choice" &&
        terminal.type !== "interaction" &&
        terminal.type !== "end")
    ) {
      throw new Error("内部错误：完整剧情段缺少末尾 choice/interaction/end。 ");
    }

    const prefetchContext: StoryContextEvent[] = [...priorContext, ...events];
    let branchManager: BranchManager | null = null;

    if (terminal.type === "choice") {
      branchManager = this.createBranchManager(
        terminal,
        turn,
        prefetchContext
      );
    } else if (
      terminal.type === "interaction" &&
      (terminal.mode === "choice" || terminal.mode === "hybrid")
    ) {
      const syntheticChoice: ChoiceEvent = {
        type: "choice",
        prompt: terminal.prompt,
        options: terminal.options!.map((o) => ({ id: o.id, text: o.text }))
      };
      branchManager = this.createBranchManager(
        syntheticChoice,
        turn,
        prefetchContext,
        terminal.interaction_id,
        "choice"
      );
    }

    this.status.setPhase("剧情播放", "当前文本已就绪；下一分支正在后台预取");
    return { turn, events, branchManager, prefetchContext };
  }

  private async consumePreparedSegment(prepared: PreparedSegment): Promise<SegmentOutcome> {
    for (const event of prepared.events) {
      if (event.type === "narration" || event.type === "dialogue") {
        await this.consumePlayableEvent(event, prepared.turn);
        continue;
      }

      if (event.type === "end") {
        await this.recordModelEvent(event, prepared.turn);
        prepared.branchManager?.discardAll();
        this.status.setPhase("结束", "剧情已经结束");
        this.ui.renderEnd(event);
        return { type: "end" };
      }

      if (event.type === "choice") {
        await this.recordModelEvent(event, prepared.turn);
        const preview = await this.handleChoice(
          event,
          prepared.turn,
          prepared.branchManager,
          prepared.prefetchContext
        );
        return {
          type: "choice",
          nextTurn: prepared.turn + 1,
          ...preview,
        };
      }

      if (event.type === "interaction") {
        await this.recordModelEvent(event, prepared.turn);

        if (event.mode === "choice") {
          const syntheticChoice: ChoiceEvent = {
            type: "choice",
            prompt: event.prompt,
            options: event.options!.map((o) => ({ id: o.id, text: o.text }))
          };
          const preview = await this.handleChoice(
            syntheticChoice,
            prepared.turn,
            prepared.branchManager,
            prepared.prefetchContext
          );
          return {
            type: "choice",
            nextTurn: prepared.turn + 1,
            ...preview,
          };
        }

        if (event.mode === "hybrid") {
          if (!event.options || !event.input) {
            throw new Error("hybrid 模式需要同时提供 options 和 input 字段。");
          }
          return await this.handleHybridInteraction(
            event as InteractionEvent & { options: NonNullable<InteractionEvent["options"]>; input: NonNullable<InteractionEvent["input"]> },
            prepared.turn,
            prepared.branchManager,
            prepared.prefetchContext
          );
        }

        if (event.mode === "input") {
          const preview = await this.handleInteractionInput(
            event,
            prepared.turn,
            prepared.branchManager
          );
          return {
            type: "choice",
            nextTurn: prepared.turn + 1,
            preview
          };
        }

        throw new Error(`不支持的 interaction mode：${(event as InteractionEvent).mode}`);
      }
    }

    throw new Error("内部错误：完整剧情段没有产生 choice/interaction/end。 ");
  }

  private async handleChoice(
    choice: ChoiceEvent,
    turn: number,
    branchManager: BranchManager | null,
    prefetchContext: StoryContextEvent[]
  ): Promise<ChoiceSelection> {
    if (!branchManager) throw new Error("内部错误：choice 缺少分支预取组。 ");

    this.status.setPhase("等待选择", "各分支正在并行预取；可随时选择");
    const selected = await this.ui.choose(choice, this.status);
    this.choiceTimestamp = Date.now();
    await this.recordPlayerChoice(selected, turn);
    console.log(`\n你选择了：${selected.text}`);

    this.status.setPhase("切换分支", "取消未选分支，装载已选预取片段");
    const selectStart = Date.now();
    let preview: RuntimePlayableEvent[];
    let liveSelection: LiveBranchSelection | undefined;
    const selectedState = this.status.snapshot().branches[selected.id]?.state;

    try {
      if (selectedState === "ready" || selectedState === "failed" || selectedState === "cancelled") {
        // A failed candidate must enter the existing retry path. Only a
        // queued/running candidate can be adopted as a live active task.
        preview = await branchManager.selectCandidate(selected.id);
      } else {
        const live = branchManager.selectCandidateLive(selected.id);
        preview = [...live.events];
        liveSelection = live;
      }
      console.log(`\x1b[2m[Prefetch] 选择"${selected.text}" → 取回 ${preview.length} 条已到达事件，耗时 ${Date.now() - selectStart}ms (预取状态=${selectedState})\x1b[0m`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.setJob("selected-branch-retry", "已选分支重试", "running");
      const retryPromise = this.generator
        .generateBranchPrefetch(turn + 1, this.storyState, prefetchContext, choice, selected)
        .then((envelope) => this.materializePlayableEvents(this.filterPlayableEvents(envelope.events)));
      preview = await this.ui.waitForTask(
        retryPromise,
        `分支预取失败，正在重试：${message}`,
        this.status
      );
      this.media.prefetchBranch(selected.id, preview);
      this.status.removeJob("selected-branch-retry");
    }

    this.media.activateBranch(selected.id);
    this.media.appendActive(preview);
    this.registerBuffered(preview);

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
    turn: number
  ): Promise<void> {
    for (const event of events) await this.consumePlayableEvent(event, turn);
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
    const seen = new Set(initialEvents.map((event) => event.line_id));
    const queue = new AsyncEventQueue<RuntimePlayableEvent>();
    let completed = false;
    let failure: unknown;

    const enqueueIfNew = (event: RuntimePlayableEvent): void => {
      if (seen.has(event.line_id)) return;
      seen.add(event.line_id);
      // Publish late branch lines immediately. Playback may consume them
      // later, but they must already count toward the formal low-water mark.
      this.playbackBuffer.enqueue(event);
      this.registerBuffered([event]);
      this.media.appendActive([event]);
      queue.push(event);
    };
    const unsubscribe = selection.subscribe(enqueueIfNew);
    // Catch events emitted between selectLive() and subscribe(). JavaScript
    // callbacks cannot interleave this synchronous snapshot, so this closes
    // the only handoff gap without duplicating line IDs.
    for (const event of selection.events) enqueueIfNew(event);

    void selection.done
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        completed = true;
        unsubscribe();
        queue.close();
      });

    await this.consumePlayableEvents(initialEvents, turn);

    while (true) {
      const next = await queue.next();
      if (!next.done) {
        const event = next.value;
        await this.consumePlayableEvent(event, turn);
        continue;
      }
      break;
    }

    // The branch request has ended. Its already generated lines remain valid;
    // the caller starts a normal continuation using that committed prefix.
    if (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.status.setPhase("后台续写", `已保留分支前缀，分支流失败：${message}`);
    }
  }

  private advanceBufferedEvent(event: RuntimeModelEvent): void {
    const bufferedEvent = this.playbackBuffer.advance();
    if (bufferedEvent && bufferedEvent !== event) {
      throw new Error("播放缓冲顺序与生成事件流不一致。");
    }
  }

  private async consumePlayableEvent(
    event: RuntimePlayableEvent,
    turn: number
  ): Promise<void> {
    this.advanceBufferedEvent(event);

    if (this.choiceTimestamp !== null) {
      this.metrics.recordChoiceToNextLine(Date.now() - this.choiceTimestamp);
      this.choiceTimestamp = null;
    }

    await this.recordModelEvent(event, turn);

    if (!this.media.isReady(event.line_id)) {
      await this.ui.waitForTask(
        this.media.waitUntilReady(event.line_id),
        `等待媒体资源：${event.line_id}`,
        this.status
      );
    }

    this.buffered.delete(event.line_id);
    this.updateBufferStatus();
    this.reconcileTextBuffer();
    this.media.markPresented(event.line_id);

    if (event.type === "narration") {
      await this.ui.renderNarration(event, this.status);
    } else {
      await this.ui.renderDialogue(event, this.status);
    }
  }

  private materializeEvents(drafts: ModelEvent[]): RuntimeModelEvent[] {
    return drafts.map((event) => {
      if (event.type === "dialogue" || event.type === "narration") {
        return { ...event, line_id: this.nextLineId() };
      }
      return event;
    });
  }

  private filterPlayableEvents(events: GeneratedEvent[]): ModelPlayableEvent[] {
    const playable: ModelPlayableEvent[] = [];
    for (const event of events) {
      if (event.type === "dialogue" || event.type === "narration") {
        playable.push(event);
      } else {
        console.warn(`[Game] 过滤非可播放事件: ${event.type}（应由 parser 预先拦截）`);
      }
    }
    return playable;
  }

  private materializePlayableEvents(
    drafts: ModelPlayableEvent[]
  ): RuntimePlayableEvent[] {
    return drafts.map((event) => ({ ...event, line_id: this.nextLineId() }));
  }

  private nextLineId(): string {
    const id = `line_${this.sessionId}_${this.lineSeq.toString().padStart(6, "0")}`;
    this.lineSeq += 1;
    return id;
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
      timestamp: new Date().toISOString(),
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
    source: "choice" | "autocomplete" | "input_preview" = "choice"
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
        const envelope = await this.generator.generateBranchPrefetch(
          turn + 1,
          this.storyState,
          prefetchContext,
          choice,
          option,
          signal,
          {
            onEvent: (draft) => {
              if (draft.type !== "dialogue" && draft.type !== "narration") return;
              const event = this.materializeEvents([draft])[0]!;
              if (!isPlayableEvent(event)) return;
              materialized.push(event);
              onEvent(event);
            },
          },
        );
        if (materialized.length === 0) {
          materialized.push(...this.materializePlayableEvents(this.filterPlayableEvents(envelope.events)));
        }
        return materialized;
      },
      onReady: (option, branchEvents) => {
        this.media.prefetchBranch(option.id, branchEvents);
      }
    });

    return manager;
  }

  /**
   * Two-phase free-text input commit.
   *
   * When `initialText` is provided (e.g. from hybrid interaction),
   * the editor loop is skipped and we go directly to preview.
   */
  private async handleInteractionInput(
    interaction: InteractionEvent,
    turn: number,
    branchManager: BranchManager | null,
    initialText?: string,
  ): Promise<RuntimePlayableEvent[]> {
    branchManager?.discardAll();
    this.status.clearBranches();

    while (true) {
    const session = this.inputEngine.startEditing(interaction);
    let editResult: { action: "confirm" | "cancel"; text: string };

    if (initialText !== undefined && initialText.trim().length > 0) {
      // Text already provided — skip editor, jump to preview
      editResult = { action: "confirm", text: initialText };
    } else {
      // Editor loop — player types and can cancel
      while (true) {
        this.status.setPhase("等待输入", "等待玩家自由输入");
        this.status.setBuffer(this.buffered.size, this.countBufferedDialogues());

        const result = await this.ui.inputEditor(
          interaction,
          session.draft,
          this.status
        );

        if (result.action === "cancel") {
          continue;
        }
        editResult = result;
        break;
      }
    }

    // Text confirmed — freeze and enter preview
    this.inputEngine.updateDraft(session, editResult.text);
    this.inputEngine.requestPreview(session);

    this.status.setPhase("输入预览", `玩家输入：${editResult.text.slice(0, 50)}`);
    const previewStartTime = Date.now();

    // Fire NPC response generation in background
    const responseState = { ready: false, error: null as Error | null };
    let pendingStatePatch: StoryStatePatch | null = null;

    this.status.setJob(
      "input-response",
      `NPC 回应：${editResult.text.slice(0, 30)}`,
      "running"
    );

    const responsePromise: Promise<RuntimePlayableEvent[]> = this.generator
      .generateInputResponse(
        turn + 1,
        this.storyState,
        [...this.events],
        interaction,
        editResult.text
      )
      .then((envelope) => {
        // Defer state patch until player confirms with second Enter
        pendingStatePatch = envelope.state_patch;
        const events = this.filterPlayableEvents(envelope.events);
        const materialized = this.materializePlayableEvents(events);
        this.registerBuffered(materialized);
        this.media.appendActive(materialized);
        this.inputEngine.setResponseEvents(session, materialized);
        this.status.setJob(
          "input-response",
          `NPC 回应：${editResult.text.slice(0, 30)}`,
          "ready"
        );
        return materialized;
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        responseState.error = err;
        this.status.setJob(
          "input-response",
          `NPC 回应：${editResult.text.slice(0, 30)}`,
          "failed",
          err.message
        );
        return [];
      })
      .finally(() => {
        responseState.ready = true;
      });

    // Don't await — we want to show the preview UI while generating
    void responsePromise.catch(() => undefined);

    // Show preview UI
    const previewResult = await this.ui.inputPreview(
      editResult.text,
      interaction,
      this.status,
      !responseState.ready
    );
    const previewDwellMs = Date.now() - previewStartTime;
    this.metrics.recordInputPreview(previewDwellMs);

    if (previewResult.action === "cancel") {
      // Return to editing
      this.inputEngine.cancel(session);
      this.status.removeJob("input-response");
      this.status.clearBranches();
      initialText = undefined;
      continue;
    }

    // Confirm — commit the session
    this.inputEngine.commit(session);

    // Apply deferred state patch now that player has confirmed
    if (pendingStatePatch) {
      try {
        this.storyState = applyPatch(this.storyState, pendingStatePatch);
      } catch {
        this.metrics.recordStatePatchRejection();
      }
      pendingStatePatch = null;
    }

    // Record the player input
    await this.recordPlayerInput(
      interaction.interaction_id,
      editResult.text,
      turn
    );

    this.status.setPhase(
      "输入已提交",
      `玩家输入：${editResult.text.slice(0, 50)}`
    );

    // Wait for response generation to complete
    const responseEvents = await responsePromise;

    if (responseState.error) {
      console.log(`\n\x1b[2m\x1b[33m警告：NPC 回应生成失败 — ${responseState.error.message}\x1b[0m\x1b[0m`);
    }

    this.status.removeJob("input-response");
    return responseEvents;
    }
  }

  /**
   * Hybrid interaction: player can select a preset option OR type free text.
   */
  private async handleHybridInteraction(
    interaction: InteractionEvent & {
      options: NonNullable<InteractionEvent["options"]>;
      input: NonNullable<InteractionEvent["input"]>;
    },
    turn: number,
    branchManager: BranchManager | null,
    prefetchContext: StoryContextEvent[]
  ): Promise<SegmentOutcome> {
    this.status.setPhase("等待选择", "可选择预设选项，或自由输入");

    const result = await this.ui.renderHybridInteraction(
      interaction,
      this.status
    );

    if (result.type === "cancel") {
      return this.handleHybridInteraction(
        interaction,
        turn,
        branchManager,
        prefetchContext
      );
    }

    if (result.type === "choice") {
      const selected = interaction.options.find(
        (o) => o.id === result.optionId
      );
      if (!selected) {
        throw new Error(`未找到选项：${result.optionId}`);
      }

      await this.recordPlayerChoice(
        { id: selected.id, text: selected.text },
        turn
      );
      this.choiceTimestamp = Date.now();
      console.log(`\n你选择了：${selected.text}`);

      let preview: RuntimePlayableEvent[];
      let liveSelection: LiveBranchSelection | undefined;

      if (branchManager) {
        try {
          const branchState = this.status.snapshot().branches[result.optionId]?.state;
          if (branchState === "ready" || branchState === "failed" || branchState === "cancelled") {
            preview = await branchManager.selectCandidate(result.optionId);
          } else {
            const live = branchManager.selectCandidateLive(result.optionId);
            preview = [...live.events];
            liveSelection = live;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.status.setJob(
            "selected-branch-retry",
            "已选分支重试",
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
          const retryPromise = this.generator
            .generateBranchPrefetch(
              turn + 1,
              this.storyState,
              prefetchContext,
              syntheticChoice,
              { id: selected.id, text: selected.text }
            )
            .then((envelope) => this.materializePlayableEvents(this.filterPlayableEvents(envelope.events)));
          preview = await this.ui.waitForTask(
            retryPromise,
            `分支预取失败，正在重试：${message}`,
            this.status
          );
          this.media.prefetchBranch(selected.id, preview);
          this.status.removeJob("selected-branch-retry");
        }

        this.media.activateBranch(selected.id);
        this.media.appendActive(preview);
        this.registerBuffered(preview);

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
        const genPromise = this.generator
          .generateBranchPrefetch(
            turn + 1,
            this.storyState,
            prefetchContext,
            syntheticChoice,
            { id: selected.id, text: selected.text }
          )
          .then((envelope) => this.materializePlayableEvents(this.filterPlayableEvents(envelope.events)));
        preview = await this.ui.waitForTask(
          genPromise,
          `按需生成分支：${selected.text}`,
          this.status
        );
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

    branchManager?.discardAll();
    this.status.clearBranches();

    const preview = await this.handleInteractionInput(
      interaction,
      turn,
      null,
      result.text,
    );

    return {
      type: "choice",
      nextTurn: turn + 1,
      preview,
    };
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
      timestamp: new Date().toISOString(),
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
      timestamp: new Date().toISOString(),
      source: "player"
    };
    this.seq += 1;
    await this.record(stored);
  }

  private async record(event: StoredEvent): Promise<void> {
    this.events.push(event);
    await this.store.append(event);
  }

  private async saveCurrentStateSnapshot(): Promise<void> {
    const dir = path.dirname(this.store.filePath);
    const statePath = path.join(dir, "state.json");
    await saveStateSnapshot(this.storyState, statePath);
  }

  /** Provides readonly context for the autocomplete system. */
  getAutocompleteContext(): { state: StoryState; events: StoryContextEvent[] } {
    return { state: this.storyState, events: [...this.events] };
  }

  /**
   * Check the formal playback watermark. Generation is started by the active
   * segment lifecycle; this method is the invariant check used whenever a
   * line is consumed or appended, so a low buffer can never be mistaken for
   * a normal refill point.
   */
  private reconcileTextBuffer(): void {
    const linesAhead = this.playbackBuffer.countTextLinesAhead();
    const { refill_threshold_lines } = this.config.text_buffer;

    if (this.playbackBuffer.hasUnconsumedInteraction()) return;
    if (linesAhead <= refill_threshold_lines) {
      if (this.generationScheduler.hasActivePathTask()) return;
      console.log(
        `\x1b[2m[Buffer] 文本缓冲低水位: 剩余 ${linesAhead} 句 (阈值 ${refill_threshold_lines})，等待新的正式续写任务\x1b[0m`
      );
    }
  }

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
