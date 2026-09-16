/**
 * InteractionDriver —— 交互驱动（choice/input/hybrid + 两阶段提交 + 分支
 * 预取接线 + 桥接预取），自 game.ts 沿子系统缝移出（执行清单 M4.5）。
 *
 * 驱动通过 `InteractionHost` 最小视图访问宿主（Game）状态与宿主方法；
 * 行为零变化——方法体自 game.ts 原样迁移，仅 `this.` → `this.host.`。
 */
import type { AppConfig } from "../config.js";
import type { ClockPort } from "../core/ports/clock-port.js";
import type { DiagnosticSink } from "../core/ports/diagnostic-sink.js";
import type { IdGeneratorPort } from "../core/ports/id-generator-port.js";
import type { MediaPlannerPort } from "../core/ports/media-planner-port.js";
import type { NarrativeDirectorPort } from "../core/ports/narrative-director-port.js";
import type { StoryGeneratorPort } from "../core/ports/story-generator-port.js";
import type { RuntimeCommand } from "../core/runtime/runtime-command.js";
import { RuntimeShutdownError } from "../core/runtime/errors.js";
import type { RuntimeOutput, StagePresentationDelta } from "../core/runtime/runtime-output.js";
import { InputBridgeBuffer } from "../core/interaction/input-bridge.js";
import { InputEngine } from "../interaction/input-engine.js";
import { BranchManager } from "./branch-manager.js";
import { InputResponseSession } from "../core/interaction/input-session.js";
import type { LiveBranchSelection } from "./prefetch.js";
import { Metrics } from "./metrics.js";
import type { RuntimeStatus } from "./status.js";
import { AsyncEventQueue } from "../core/runtime/async-event-queue.js";
import type { PlaybackBuffer } from "./playback-buffer.js";
import type { LiveStreamLike } from "./segment-types.js";
import type {
  ActiveSegment,
  ChoiceSelection,
  InputCommitOutcome,
  SegmentOutcome,
} from "./segment-types.js";
import type { MemoryProjection } from "../core/narrative/memory-projection.js";
import type {
  ChoiceEvent,
  ChoiceOption,
  InteractionEvent,
  InputInteraction,
  HybridInteraction,
  PlayerDialogueEvent,
  RuntimeDialogueEvent,
  RuntimeNarrationEvent,
  StoredEvent,
  StoredPlayerChoiceEvent,
  StoredPlayerInputEvent,
  StoredPlayerDialogueEvent,
  StoryContextEvent,
  RuntimePlayableEvent,
} from "../schema.js";
import type { DslInteractionDraft, EventGroupDraft } from "../core/protocol/gal-dsl/types.js";
import type {
  StageCue,
  VisualState,
} from "../core/presentation/types.js";
import type { InputSpec, StoryState } from "../story/types.js";

/**
 * InteractionHost —— InteractionDriver 对 Game 宿主成员的最小视图（M4.5）。
 * Game 实现本接口；这些成员即 game.ts 拆分后对交互驱动簇的公开接缝。
 */
export interface InteractionHost {
  status: RuntimeStatus;
  metrics: Metrics;
  diagnostics: DiagnosticSink;
  clock: ClockPort;
  ids: IdGeneratorPort;
  config: AppConfig;
  generator: StoryGeneratorPort;
  media: MediaPlannerPort;
  narrativeDirector: NarrativeDirectorPort | undefined;
  seq: number;
  activeInteractionId: string | null;
  activePreviewId: string | null;
  choiceTimestamp: number | null;
  inputConfirmAtMs: number | null;
  storyState: StoryState;
  tailVisualState: VisualState;
  events: StoredEvent[];
  bridgeBuffer: InputBridgeBuffer;
  inputEngine: InputEngine;
  bridgeControllers: Map<string, AbortController>;
  branchTailStates: Map<string, VisualState>;
  bridgeLineIds: Set<string>;
  responseLineIds: Set<string>;
  buffered: Map<string, RuntimePlayableEvent>;
  playbackBuffer: PlaybackBuffer;
  reduce: (state: VisualState, cues: StageCue[]) => VisualState;

  emit(output: RuntimeOutput): void;
  makeBriefing(turn: number): string | undefined;
  openInteractionStage(interactionId: string): StagePresentationDelta | undefined;
  waitForCommand(predicate: (command: RuntimeCommand) => boolean): Promise<RuntimeCommand>;
  waitForInteractionCommand(
    interactionId: string,
    acceptedTypes: Readonly<Partial<Record<"select_choice" | "preview_input", true>>>,
  ): Promise<Extract<RuntimeCommand, { type: "select_choice" | "preview_input" }>>;
  record(event: StoredEvent): Promise<void>;
  nextLineId(): string;
  materializeDslGroups(
    groups: EventGroupDraft[],
    baseState: VisualState,
    turn: number,
  ): { events: RuntimePlayableEvent[]; tailState: VisualState };
  compileGroup(
    draft: EventGroupDraft,
    baseState: VisualState,
    turn: number,
  ): {
    playable: RuntimeDialogueEvent | RuntimeNarrationEvent | null;
    interaction: InteractionEvent | null;
    cues: StageCue[];
    tailState: VisualState;
  };
  registerBuffered(events: RuntimePlayableEvent[]): void;
  advanceBufferedEvent(event: import("../schema.js").RuntimeBufferEvent): void;
  consumePlayableEvent(
    event: RuntimePlayableEvent,
    turn: number,
    segment?: ActiveSegment,
  ): Promise<void>;
  assertInteractionPolicy(event: InteractionEvent): void;
  recordInteractionMode(mode: "choice" | "input" | "hybrid"): void;
}
export class InteractionDriver {
  constructor(private readonly host: InteractionHost) {}

  resolveInteraction(
    interactionId: string,
    resolution: "choice" | "input",
  ): void {
    this.host.emit({ type: "interaction_resolved", interactionId, resolution });
  }

  
  createBranchManagerForTerminal(
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

    startBridgePrefetch(
    interaction: InputInteraction | HybridInteraction,
    turn: number,
  ): void {
    if (!this.host.config.prefetch.input_bridge.enabled) return;
    const interactionId = interaction.interaction_id;
    const controller = new AbortController();
    this.host.bridgeControllers.set(interactionId, controller);

    const bridgeBrief = this.host.makeBriefing(turn + 1);
    const handle = this.host.generator.generateInputBridge({
      turn: turn + 1,
      state: this.host.storyState,
      interaction,
      signal: controller.signal,
      ...(bridgeBrief !== undefined && bridgeBrief !== "" ? { briefing: bridgeBrief } : {}),
      tailVisualState: this.host.tailVisualState,
    });

    const promise = (async () => {
      try {
        const groups: EventGroupDraft[] = [];
        for await (const group of handle.events) groups.push(group);
        await handle.done;
        if (controller.signal.aborted) return;
        const events: RuntimeNarrationEvent[] = [];
        for (const group of groups) {
          if (group.main.type === "narration") {
            events.push({
              type: "narration",
              text: group.main.text,
              line_id: this.host.nextLineId(),
            });
          }
        }
        // Bridge contract: 1–2 narration lines (docs §34). Anything else
        // is discarded — the confirm flow must never see a broken bridge.
        if (events.length < 1 || events.length > 2) {
          this.host.metrics.recordSchemaValidationFailure();
          this.host.diagnostics.warn(
            "Bridge",
            `输入过渡旁白数量非法（${events.length}），已丢弃`,
          );
          return;
        }
        for (const event of events) this.host.bridgeLineIds.add(event.line_id);
        this.host.bridgeBuffer.store(interactionId, events);
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.host.diagnostics.warn("Bridge", `输入过渡旁白生成失败：${message}`);
      } finally {
        this.host.bridgeControllers.delete(interactionId);
      }
    })();
    void promise;
  }

    cancelBridgePrefetch(interactionId: string): void {
    const controller = this.host.bridgeControllers.get(interactionId);
    if (controller !== undefined) {
      controller.abort();
      this.host.bridgeControllers.delete(interactionId);
    }
  }

    async adoptSelectedBranch(
    selected: ChoiceOption,
    choice: ChoiceEvent,
    turn: number,
    branchManager: BranchManager,
    prefetchContext: StoryContextEvent[],
  ): Promise<{ preview: RuntimePlayableEvent[]; liveSelection?: LiveBranchSelection }> {
    this.host.status.setPhase("切换分支", "取消未选分支，装载已选预取片段");
    const selectStart = this.host.clock.nowMs();
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
      this.host.diagnostics.info(
        "Prefetch",
        `选择"${selected.text}" → 取回 ${preview.length} 条已到达事件，耗时 ${this.host.clock.nowMs() - selectStart}ms (预取状态=${selectedState})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.status.setJob("selected-branch-retry", "已选分支重试", "running");
      const retryBrief = this.host.makeBriefing(turn + 1);
      const handle = this.host.generator.generateBranchPrefetch({
        turn: turn + 1,
        state: this.host.storyState,
        history: prefetchContext,
        choice,
        option: selected,
        ...(retryBrief !== undefined && retryBrief !== "" ? { briefing: retryBrief } : {}),
        tailVisualState: this.host.tailVisualState,
      });
      await handle.done;
      const groups: EventGroupDraft[] = [];
      for await (const group of handle.events) groups.push(group);
      const result = this.host.materializeDslGroups(groups, this.host.tailVisualState, turn);
      this.host.branchTailStates.set(selected.id, result.tailState);
      preview = result.events;
      this.host.media.registerCandidate(selected.id, preview);
      this.host.status.removeJob("selected-branch-retry");
    }

    // The selected branch's tail visual state becomes the new predictive
    // tail (docs §56): the next generation continues from where the branch
    // actually leaves the stage. For a live-selected branch whose request
    // has not resolved yet, derive the tail from the committed prefix's
    // stage cues.
    const branchTail = this.host.branchTailStates.get(selected.id);
    if (branchTail !== undefined) {
      this.host.tailVisualState = branchTail;
    } else {
      const cues: StageCue[] = [];
      for (const event of preview) {
        const stage = (event as { stage?: StageCue[] }).stage;
        if (stage !== undefined) cues.push(...stage);
      }
      if (cues.length > 0) {
        this.host.tailVisualState = this.host.reduce(this.host.tailVisualState, cues);
      }
    }
    this.host.branchTailStates.clear();

    this.host.media.activateCandidate(selected.id);
    this.host.media.registerActive(preview);
    this.host.registerBuffered(preview);

    return {
      preview,
      ...(liveSelection ? { liveSelection } : {}),
    };
  }

  
  async handleChoice(
    choice: ChoiceEvent,
    turn: number,
    branchManager: BranchManager | null,
    prefetchContext: StoryContextEvent[],
    interactionId?: string,
  ): Promise<ChoiceSelection> {
    if (!branchManager) throw new Error("内部错误：choice 缺少分支预取组。 ");

    this.host.status.setPhase("等待选择", "各分支正在并行预取；可随时选择");
    // Legacy choice events have no interaction_id; DSL-compiled choice
    // interactions carry the runtime-generated id (docs §30).
    const scopeId = interactionId ?? `choice_${turn}`;
    // §10.2 lifecycle: the interaction is the active command scope from
    // `interaction_opened` until it resolves.
    this.host.activeInteractionId = scopeId;
    const presentation = this.host.openInteractionStage(scopeId);
    this.host.emit({
      type: "interaction_opened",
      interactionId: scopeId,
      interaction: choice,
      ...(presentation !== undefined ? { presentation } : {}),
    });
    const command = await this.host.waitForInteractionCommand(
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
    this.host.activeInteractionId = null;
    this.host.choiceTimestamp = this.host.clock.nowMs();
    await this.recordPlayerChoice(selected, turn);
    // The checkpoint fires only AFTER the player choice is formally
    // committed: a consolidation triggered here must include the choice
    // event (audit finding 5).
    this.host.narrativeDirector?.checkpoint("interaction_completed");
    this.host.diagnostics.info("player", `你选择了：${selected.text}`);

    const { preview, liveSelection } = await this.adoptSelectedBranch(
      selected,
      choice,
      turn,
      branchManager,
      prefetchContext,
    );

    for (const option of choice.options) {
      this.host.status.removeJob(`branch:${option.id}`);
    }
    this.host.status.clearBranches();
    return {
      preview,
      ...(liveSelection ? { liveSelection } : {}),
    };
  }

  
  createBranchManager(
    choice: ChoiceEvent,
    turn: number,
    prefetchContext: StoryContextEvent[],
    interactionId?: string,
    source: "choice" | "input_preview" = "choice"
  ): BranchManager {
    const manager = new BranchManager(this.host.metrics);

    for (const option of choice.options) {
      manager.createCandidate(
        option.id,
        interactionId ?? `choice_${turn}`,
        source
      );
    }

    manager.startPrefetch({
      choice,
      concurrency: this.host.config.prefetch.branch_concurrency,
      status: this.host.status,
      generate: async (option, signal, onEvent) => {
        const materialized: RuntimePlayableEvent[] = [];
        // DSL mode: branch groups compile against a branch-local visual
        // state seeded from the current tail (docs §56). Unselected
        // branches never execute, so their states stay isolated here.
        let branchState = this.host.tailVisualState;
        const prefetchBrief = this.host.makeBriefing(turn + 1);
        const handle = this.host.generator.generateBranchPrefetch({
          turn: turn + 1,
          state: this.host.storyState,
          history: prefetchContext,
          choice,
          option,
          signal,
          ...(prefetchBrief !== undefined && prefetchBrief !== "" ? { briefing: prefetchBrief } : {}),
          tailVisualState: this.host.tailVisualState,
        });
        // 泵：与旧 onGroup 直连语义等价——组到达即编译并喂给 onEvent
        // （branch-local visual state 逐组折叠）。
        const pump = (async () => {
          for await (const group of handle.events) {
            const { playable, tailState } = this.host.compileGroup(group, branchState, turn);
            branchState = tailState;
            if (playable !== null) {
              materialized.push(playable);
              onEvent(playable);
            }
          }
        })();
        try {
          await handle.done;
        } catch (error) {
          // C5: done 拒绝时泵仍在后台排空缓冲组；若某组让 compileGroup
          // 抛错，泵的拒绝会成为未处理拒绝（Node unhandledRejection=throw
          // 崩溃进程）。带拒绝处理排空后再抛原始错误（与 I1 相同模式）。
          await pump.catch(() => undefined);
          throw error;
        }
        await pump;
        this.host.branchTailStates.set(option.id, branchState);
        return materialized;
      },
      onReady: (option, branchEvents) => {
        this.host.media.registerCandidate(option.id, branchEvents);
      }
    });

    return manager;
  }

    async handleInteractionInput(
    interaction: InputInteraction | HybridInteraction,
    turn: number,
    branchManager: BranchManager | null,
    initialText?: string,
  ): Promise<InputCommitOutcome> {
    branchManager?.discardAll();
    this.host.status.clearBranches();
    const interactionId = interaction.interaction_id;
    // The bridge is shared across preview cancels; it is consumed only at
    // confirm so a cancelled preview can retry with the same bridge.
    let bridgeEvents = this.host.bridgeBuffer.peek(interactionId) ?? [];

    while (true) {
      let text: string;
      if (initialText !== undefined && initialText.trim().length > 0) {
        // Text already provided — skip editor, jump to preview
        text = initialText.trim();
        initialText = undefined;
      } else {
        this.host.status.setPhase("等待输入", "等待玩家自由输入");
        this.host.status.setBuffer(this.host.buffered.size, this.countBufferedDialogues());
        // §10.2 lifecycle: (re)opening the interaction re-arms the command
        // scope; the id survives preview cancels.
        this.host.activeInteractionId = interactionId;
        const presentation = this.host.openInteractionStage(interactionId);
        this.host.emit({
          type: "interaction_opened",
          interactionId,
          interaction,
          ...(presentation !== undefined ? { presentation } : {}),
        });
        const command = await this.host.waitForInteractionCommand(
          interactionId,
          { preview_input: true },
        );
        if (command.type !== "preview_input") throw new RuntimeShutdownError();
        text = command.text.trim().slice(0, interaction.input.max_length);
      }
      // 空白输入不进提交路径：边契约要求 choice.text ≥ 1，空文本会在边收束时
      // （远离错误现场）炸开——这里重开表单等待有效输入，与取消分支同构。
      if (text.length === 0) continue;

      // Freeze the text and enter preview.
      const session = this.host.inputEngine.startEditing(interaction);
      this.host.inputEngine.updateDraft(session, text);
      this.host.inputEngine.requestPreview(session);

      const previewId = this.host.ids.nextPreviewId(interactionId);
      const responseSession = new InputResponseSession({
        previewId,
        interactionId,
        generationId: this.host.ids.nextGenerationId(`input:${interactionId}`),
        frozenText: text,
        bridgeEvents,
      });

      this.host.status.setPhase("输入预览", `玩家输入：${text.slice(0, 50)}`);
      const previewStartTime = this.host.clock.nowMs();
      this.host.status.setJob(
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
      this.host.activePreviewId = previewId;
      this.host.emit({ type: "input_preview_opened", previewId, text });
      let previewCommand: RuntimeCommand;
      if (this.host.config.input.require_preview_confirmation) {
        previewCommand = await this.host.waitForCommand(
          (c) =>
            (c.type === "confirm_input" || c.type === "cancel_input") &&
            c.previewId === previewId,
        );
      } else {
        // Single-Enter flow: the preview is implicit, commit immediately.
        previewCommand = { type: "confirm_input", previewId };
      }
      const previewDwellMs = this.host.clock.nowMs() - previewStartTime;
      this.host.metrics.recordInputPreview(previewDwellMs);

      // The bridge prefetch may still be landing when the interaction opens
      // (its handle stream settles a microtask after the terminal group).
      // Refresh at the commit point so a late but valid bridge is included;
      // the buffer is consumed only at confirm, so this is idempotent.
      bridgeEvents = this.host.bridgeBuffer.peek(interactionId) ?? [];

      if (previewCommand.type === "cancel_input") {
        // Return to editing — abort the stale response request so its events
        // can never be buffered or rendered for the previous edit session.
        responseController.abort();
        responseSession.cancel();
        this.host.metrics.recordInputResponseCanceled();
        this.host.inputEngine.cancel(session);
        this.host.status.removeJob("input-response");
        this.host.status.clearBranches();
        // §10.2 lifecycle: cancel releases the preview scope only; the
        // interaction stays open for the next preview.
        this.host.activePreviewId = null;
        this.host.emit({ type: "input_preview_canceled", previewId });
        this.host.media.discardCandidate(previewId);
        if (interaction.mode === "hybrid") {
          // §11.7: a hybrid cancel hands control back to the hybrid loop,
          // which re-arms BOTH submission paths and re-prefetches the
          // option branches (the interaction is still open).
          return { type: "canceled" };
        }
        continue;
      }

      // Confirm — commit the session.
      this.host.inputEngine.commit(session);
      responseSession.commit();
      // The input is now resolved and can no longer be submitted; browsers
      // close the form. Emitted before input_committed so a reconnect never
      // restores the resolved interaction.
      this.resolveInteraction(interactionId, "input");
      // §10.2 lifecycle: confirm releases both the preview and interaction
      // scope — no further confirm/cancel may touch this preview.
      this.host.activeInteractionId = null;
      this.host.activePreviewId = null;
      this.host.emit({ type: "input_committed", previewId });
      this.host.bridgeBuffer.take(interactionId);
      // The interaction is resolved: stop the bridge prefetch task so late
      // narration can never be buffered for a dead interaction.
      this.cancelBridgePrefetch(interactionId);

      // Confirm → first response line measurement (E3/G1).
      this.host.inputConfirmAtMs = this.host.clock.nowMs();
      if (responseSession.responseEvents.length > 0) {
        this.host.metrics.recordInputConfirmToFirstResponseLine(0);
        this.host.inputConfirmAtMs = null;
      }

      const playerDialogue = this.makePlayerDialogue(interactionId, text);

      // The handle rejection settles two microtask hops behind the runner
      // failure (the port's queue-close finally + propagation). Drain the
      // microtask queue so a failed stream is classified as a repair attempt
      // below, not as a live promotion.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

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
          generationId: this.host.ids.nextGenerationId(`input:${interactionId}:repair`),
          frozenText: text,
          bridgeEvents,
        });
        const repair = this.startInputResponseGeneration(interaction, turn, text, liveSession);
        void repair.promise.catch(() => undefined);
        this.host.status.setJob(
          "input-response",
          `NPC 回应：${text.slice(0, 30)}`,
          "running"
        );
      } else if (!responseSession.settled) {
        // Live promotion: the confirmed stream is still running; its later
        // events enter the formal buffer directly. No abort, no new request.
        liveSession = responseSession;
        this.host.metrics.recordInputResponsePromotedLive();
      }

      await this.recordPlayerInput(interactionId, text, turn);
      this.host.status.setPhase(
        "输入已提交",
        `玩家输入：${text.slice(0, 50)}`
      );

      if (!liveSession) {
        // Response finished before/during confirm: return the fixed prefix.
        await responseSession.done;
        if (responseSession.failure) {
          this.host.diagnostics.warn("input", `NPC 回应生成失败 — ${responseSession.failure.message}`);
        }
        this.host.media.registerActive(responseSession.responseEvents);
        this.host.status.removeJob("input-response");
        this.host.narrativeDirector?.checkpoint("interaction_completed");
        return {
          type: "committed",
          preview: [playerDialogue, ...bridgeEvents, ...responseSession.responseEvents],
        };
      }

      // Live path: the response prefix already staged plays first, late
      // events flow to the formal buffer via consumeLiveInputResponse.
      void liveSession.done.then(() => {
        if (liveSession.failure) {
          this.host.diagnostics.warn("input", `NPC 回应生成失败 — ${liveSession.failure.message}`);
        }
      });
      this.host.media.registerActive(liveSession.responseEvents);
      this.host.narrativeDirector?.checkpoint("interaction_completed");
      return {
        type: "committed",
        preview: [playerDialogue, ...bridgeEvents, ...liveSession.responseEvents],
        liveResponse: liveSession,
      };
    }
  }

    startInputResponseGeneration(
    interaction: InputInteraction | HybridInteraction,
    turn: number,
    text: string,
    responseSession: InputResponseSession,
  ): { promise: Promise<void>; controller: AbortController } {
    const controller = new AbortController();
    // DSL mode: response groups compile against a response-local visual
    // state seeded from the current tail (docs §79).
    let responseState = this.host.tailVisualState;

    const brief = this.host.makeBriefing(turn + 1);
    const handle = this.host.generator.generateInputResponse({
      turn: turn + 1,
      state: this.host.storyState,
      history: [...this.host.events],
      interaction,
      playerInput: text,
      signal: controller.signal,
      ...(brief !== undefined && brief !== "" ? { briefing: brief } : {}),
      tailVisualState: this.host.tailVisualState,
    });

    // 泵：把 handle 的事件流喂进 staging 路径（与旧 onGroup 直连等价）。
    // 中止后的迟到组照旧丢弃并计数。
    const pump = (async () => {
      for await (const group of handle.events) {
        if (controller.signal.aborted) {
          this.host.metrics.recordStaleInputEventDropped();
          continue;
        }
        const { playable, tailState } = this.host.compileGroup(group, responseState, turn);
        responseState = tailState;
        if (playable !== null) {
          this.stageResponseEvent(responseSession, playable);
        }
      }
    })();
    // C5: done 拒绝路径只标记失败、不排空泵；若某组让 compileGroup 抛错，
    // 泵的拒绝会成为未处理拒绝（Node unhandledRejection=throw 崩溃进程）。
    // 创建即挂上永不抛错的拒绝处理器（成功后 await pump 仍能看到拒绝，
    // 由下方 ok 处理器标记失败）。
    void pump.catch(() => undefined);

    // 单一反应（非 .then().catch()）：确认命令处理时会话状态已落定——
    // 修复决策在确认点不会与失败反应竞速。ok 处理器现在先排空泵（I2），
    // 落定多出若干微任务，但确认点的 setTimeout(0) 排空覆盖同一轮
    // macrotask，分类确定性保持不变。
    const promise = handle.done
      .then(
        async () => {
          if (controller.signal.aborted) return;
          // I2：泵可能仍在处理最终一批组（final burst）——先排空泵再读取
          // responseState，保证预测尾部（docs §79）包含全部组的 stage 贡献。
          // 泵拒绝（组编译失败）与 done 拒绝同语义：标记失败，不得让会话
          // 停留在 generating。
          try {
            await pump;
          } catch (error) {
            if (controller.signal.aborted) return;
            const err = error instanceof Error ? error : new Error(String(error));
            responseSession.markFailed(err);
            this.host.status.setJob(
              "input-response",
              `NPC 回应：${text.slice(0, 30)}`,
              "failed",
              err.message
            );
            return;
          }
          // The confirmed response's tail state becomes the new predictive
          // tail (docs §79): the next generation continues from where the
          // response leaves the stage.
          this.host.tailVisualState = responseState;
          responseSession.markReady();
          this.host.status.setJob(
            "input-response",
            `NPC 回应：${text.slice(0, 30)}`,
            "ready"
          );
        },
        (error) => {
          if (controller.signal.aborted) return;
          const err = error instanceof Error ? error : new Error(String(error));
          responseSession.markFailed(err);
          this.host.status.setJob(
            "input-response",
            `NPC 回应：${text.slice(0, 30)}`,
            "failed",
            err.message
          );
        },
      )
      .finally(() => void pump);

    return { promise, controller };
  }

    stageResponseEvent(
    responseSession: InputResponseSession,
    event: RuntimePlayableEvent,
  ): void {
    const confirmAt = this.host.inputConfirmAtMs;
    const firstAfterConfirm =
      confirmAt !== null && responseSession.responseEvents.length === 0;
    responseSession.appendResponseEvent(event);
    this.host.responseLineIds.add(event.line_id);
    if (firstAfterConfirm) {
      this.host.metrics.recordInputConfirmToFirstResponseLine(this.host.clock.nowMs() - confirmAt);
      this.host.inputConfirmAtMs = null;
    }
  }

  
  /**
   * Hybrid interaction: player can select a preset option OR type free text.
   */
  makePlayerDialogue(interactionId: string, text: string): PlayerDialogueEvent {
    return {
      type: "player_dialogue",
      interaction_id: interactionId,
      speaker: "你",
      text,
      line_id: this.host.nextLineId(),
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
  async handleHybridInteraction(
    interaction: HybridInteraction,
    turn: number,
    branchManager: BranchManager | null,
    prefetchContext: StoryContextEvent[]
  ): Promise<SegmentOutcome> {
    const interactionId = interaction.interaction_id;
    // §10.2 lifecycle: hybrid opens one interaction scope shared by both
    // submission paths; it is released as soon as either path resolves.
    while (true) {
      this.host.status.setPhase("等待选择", "可选择预设选项，或自由输入");
      this.host.activeInteractionId = interactionId;
      const presentation = this.host.openInteractionStage(interactionId);
      this.host.emit({
        type: "interaction_opened",
        interactionId,
        interaction,
        ...(presentation !== undefined ? { presentation } : {}),
      });
      const command = await this.host.waitForInteractionCommand(
        interactionId,
        { select_choice: true, preview_input: true },
      );

      if (command.type === "preview_input") {
        branchManager?.discardAll();
        this.host.status.clearBranches();

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
      this.host.activeInteractionId = null;
      this.host.bridgeBuffer.discard(interactionId);
      // The preset option resolves the interaction: the bridge belongs to
      // the free-text path and is discarded (docs §35).
      this.cancelBridgePrefetch(interactionId);

      await this.recordPlayerChoice(
        { id: selected.id, text: selected.text },
        turn
      );
      // After the choice is formally committed (audit finding 5).
      this.host.narrativeDirector?.checkpoint("interaction_completed");
      this.host.choiceTimestamp = this.host.clock.nowMs();
      this.host.diagnostics.info("player", `你选择了：${selected.text}`);

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
          this.host.status.removeJob(`branch:${option.id}`);
        }
        this.host.status.clearBranches();
      } else {
        this.host.status.setJob(
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
        const onDemandBrief = this.host.makeBriefing(turn + 1);
        const handle = this.host.generator.generateBranchPrefetch({
          turn: turn + 1,
          state: this.host.storyState,
          history: prefetchContext,
          choice: syntheticChoice,
          option: { id: selected.id, text: selected.text },
          ...(onDemandBrief !== undefined && onDemandBrief !== "" ? { briefing: onDemandBrief } : {}),
          tailVisualState: this.host.tailVisualState,
        });
        await handle.done;
        const groups: EventGroupDraft[] = [];
        for await (const group of handle.events) groups.push(group);
        const result = this.host.materializeDslGroups(groups, this.host.tailVisualState, turn);
        preview = result.events;
        this.host.registerBuffered(preview);
        this.host.status.removeJob("on-demand-branch");
      }

      return {
        type: "choice",
        nextTurn: turn + 1,
        preview,
        ...(liveSelection ? { liveSelection } : {}),
      };
    }
  }

  
  countBufferedDialogues(): number {
    return [...this.host.buffered.values()].filter(
      (event) => event.type === "dialogue"
    ).length;
  }

  
  async recordPlayerChoice(option: ChoiceOption, turn: number): Promise<void> {
    const stored: StoredPlayerChoiceEvent = {
      type: "player_choice",
      choice_id: option.id,
      text: option.text,
      seq: this.host.seq,
      turn,
      timestamp: this.host.clock.nowIso(),
      source: "player"
    };
    this.host.seq += 1;
    await this.host.record(stored);
  }

  
  async recordPlayerInput(
    interactionId: string,
    text: string,
    turn: number
  ): Promise<void> {
    const stored: StoredPlayerInputEvent = {
      type: "player_input",
      interaction_id: interactionId,
      text,
      seq: this.host.seq,
      turn,
      timestamp: this.host.clock.nowIso(),
      source: "player"
    };
    this.host.seq += 1;
    await this.host.record(stored);
  }

  
  async recordPlayerDialogue(
    event: PlayerDialogueEvent,
    turn: number
  ): Promise<void> {
    const stored: StoredPlayerDialogueEvent = {
      ...event,
      seq: this.host.seq,
      turn,
      timestamp: this.host.clock.nowIso(),
      source: "player"
    };
    this.host.seq += 1;
    await this.host.record(stored);
  }

    buildRuntimeInteraction(
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
        max_length: this.host.config.interaction.input.max_length,
      };
      return { ...base, mode: "input", input };
    }
    const options = draft.optionTexts.map((text: string, index: number) => ({
      id: `${interactionId}_opt_${index}`,
      text,
    }));
    if (draft.mode === "choice") {
      return { ...base, mode: "choice", options };
    }
    const input: InputSpec = {
      kind: "free_text",
      placeholder: draft.inputPlaceholder?.trim() || "输入你的回答……",
      max_length: this.host.config.interaction.input.max_length,
    };
    return { ...base, mode: "hybrid", options, input };
  }

    async consumePlayableEvents(
    events: RuntimePlayableEvent[],
    turn: number,
    segment?: ActiveSegment
  ): Promise<void> {
    for (const event of events) await this.host.consumePlayableEvent(event, turn, segment);
  }

    async consumeLiveSelection(
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
      if (playableCount >= this.host.config.prefetch.branch_dialogue_lines) {
        this.host.diagnostics.info(
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
      this.host.status.setPhase("后台续写", `已保留分支前缀，分支流失败：${message}`);
    }
  }

    async consumeLiveInputResponse(
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
      () => this.host.metrics.recordInputResponseUnderrun(),
    );

    if (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.host.status.setPhase("后台续写", `已保留输入回应前缀，回应流失败：${message}`);
    }
    this.host.status.removeJob("input-response");
  }

    async consumeLiveStream(
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
      this.host.playbackBuffer.enqueue(event);
      this.host.registerBuffered([event]);
      this.host.media.registerActive([event]);
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
        await this.host.consumePlayableEvent(event, turn);
        continue;
      }
      break;
    }

    return failure;
  }
}
