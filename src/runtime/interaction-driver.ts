/**
 * InteractionDriver —— 交互驱动门面（choice/input/hybrid + 两阶段提交 +
 * 分支预取接线 + 桥接预取），自 game.ts 沿子系统缝移出（执行清单 M4.5），
 * 后按豁免清偿二分为 interaction-choice.ts / interaction-input.ts：
 * choice/input 路径的自由函数在各自文件，本文件保留宿主契约
 * （InteractionHost）、hybrid 编排与 live 消费簇。
 *
 * 驱动通过 `InteractionHost` 最小视图访问宿主（Game）状态与宿主方法。
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
import { InputResponseSession } from "../core/interaction/input-session.js";
import { AsyncEventQueue } from "../core/runtime/async-event-queue.js";
import { BranchManager } from "./branch-manager.js";
import type { LiveBranchSelection } from "./prefetch.js";
import { Metrics } from "./metrics.js";
import type { RuntimeStatus } from "./status.js";
import type { PlaybackBuffer } from "./playback-buffer.js";
import type { LiveStreamLike } from "./segment-types.js";
import {
  adoptSelectedBranch,
  createBranchManagerForTerminal,
  handleChoice,
  recordPlayerChoice,
} from "./interaction-choice.js";
import {
  cancelBridgePrefetch,
  handleInteractionInput,
  recordPlayerDialogue,
  recordPlayerInput,
  startBridgePrefetch,
} from "./interaction-input.js";
import type { ActiveSegment, SegmentOutcome } from "./segment-types.js";
import type {
  ChoiceEvent,
  InteractionEvent,
  InputInteraction,
  HybridInteraction,
  PlayerDialogueEvent,
  RuntimeDialogueEvent,
  RuntimeNarrationEvent,
  StoredEvent,
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
  record(event: StoredEvent): Promise<"recorded" | "fast_forwarded">;
  /** M5.3：提交路径上取走同选项快进的恢复点（一次）。 */
  takePendingFastForward(): import("../core/ports/run-graph-port.js").RestorePoint | undefined;
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
    return createBranchManagerForTerminal(this.host, terminal, turn, context);
  }

  startBridgePrefetch(
    interaction: InputInteraction | HybridInteraction,
    turn: number,
  ): void {
    startBridgePrefetch(this.host, interaction, turn);
  }

  cancelBridgePrefetch(interactionId: string): void {
    cancelBridgePrefetch(this.host, interactionId);
  }

  async recordPlayerChoice(
    option: { id: string; text: string },
    turn: number,
  ): Promise<"recorded" | "fast_forwarded"> {
    return recordPlayerChoice(this.host, option, turn);
  }

  async recordPlayerInput(
    interactionId: string,
    text: string,
    turn: number,
  ): Promise<void> {
    return recordPlayerInput(this.host, interactionId, text, turn);
  }

  async recordPlayerDialogue(event: PlayerDialogueEvent, turn: number): Promise<void> {
    return recordPlayerDialogue(this.host, event, turn);
  }

  async handleChoice(
    choice: ChoiceEvent,
    turn: number,
    branchManager: BranchManager | null,
    prefetchContext: StoryContextEvent[],
    interactionId?: string,
  ): Promise<ReturnType<typeof handleChoice>> {
    return handleChoice(this.host, choice, turn, branchManager, prefetchContext, interactionId);
  }

  async handleInteractionInput(
    interaction: InputInteraction | HybridInteraction,
    turn: number,
    branchManager: BranchManager | null,
    initialText?: string,
  ): Promise<ReturnType<typeof handleInteractionInput>> {
    return handleInteractionInput(this.host, interaction, turn, branchManager, initialText);
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

        const committed = await handleInteractionInput(
          this.host,
          interaction,
          turn,
          null,
          command.text,
        );

        if (committed.type === "canceled") {
          // §11.7: cancel restores the FULL hybrid — options clickable
          // again, input re-editable, bridge preserved. Re-prefetch the
          // option branches so the choice path is live once more.
          branchManager = createBranchManagerForTerminal(
            this.host,
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
      cancelBridgePrefetch(this.host, interactionId);

      await recordPlayerChoice(
        this.host,
        { id: selected.id, text: selected.text },
        turn
      );
      // After the choice is formally committed (audit finding 5).
      this.host.narrativeDirector?.checkpoint("interaction_completed");
      this.host.choiceTimestamp = this.host.clock.nowMs();
      this.host.diagnostics.info("player", `你选择了：${selected.text}`);

      // M5.3 同选项快进（混合表单的预设选项路径）。
      const hybridFastForward = this.host.takePendingFastForward();
      if (hybridFastForward !== undefined) {
        return { type: "choice", nextTurn: turn + 1, preview: [], fastForward: hybridFastForward };
      }

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
        const adopted = await adoptSelectedBranch(
          this.host,
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
