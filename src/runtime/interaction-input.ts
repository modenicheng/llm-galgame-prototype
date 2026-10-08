/**
 * Input 交互路径（自由输入两阶段提交 / 桥接预取 / NPC 回应流 / 玩家输入
 * 记账），自 interaction-driver 二分而来（豁免清偿：M4.5/GH-P4）。
 *
 * 函数均为自由函数、首参 `host: InteractionHost`；对宿主的访问与行为
 * 语义与二分前的 driver 方法逐行一致。
 */
import { RuntimeShutdownError } from "../core/runtime/errors.js";
import { InputResponseSession } from "../core/interaction/input-session.js";
import type { EventGroupDraft } from "../core/protocol/gal-dsl/types.js";
import type { RuntimeCommand } from "../core/runtime/runtime-command.js";
import type {
  HybridInteraction,
  InputInteraction,
  PlayerDialogueEvent,
  RuntimeNarrationEvent,
  RuntimePlayableEvent,
  StoredPlayerDialogueEvent,
  StoredPlayerInputEvent,
} from "../schema.js";
import type { BranchManager } from "./branch-manager.js";
import type { InputCommitOutcome } from "./segment-types.js";
import type { InteractionHost } from "./interaction-driver.js";

export function startBridgePrefetch(
  host: InteractionHost,
  interaction: InputInteraction | HybridInteraction,
  turn: number,
): void {
  if (!host.config.prefetch.input_bridge.enabled) return;
  const interactionId = interaction.interaction_id;
  const controller = new AbortController();
  host.bridgeControllers.set(interactionId, controller);

  const bridgeBrief = host.makeBriefing(turn + 1);
  const handle = host.generator.generateInputBridge({
    turn: turn + 1,
    state: host.storyState,
    interaction,
    signal: controller.signal,
    ...(bridgeBrief !== undefined && bridgeBrief !== "" ? { briefing: bridgeBrief } : {}),
    tailVisualState: host.tailVisualState,
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
            line_id: host.nextLineId(),
          });
        }
      }
      // Bridge contract: 1–2 narration lines (docs §34). Anything else
      // is discarded — the confirm flow must never see a broken bridge.
      if (events.length < 1 || events.length > 2) {
        host.metrics.recordSchemaValidationFailure();
        host.diagnostics.warn(
          "Bridge",
          `输入过渡旁白数量非法（${events.length}），已丢弃`,
        );
        return;
      }
      for (const event of events) host.bridgeLineIds.add(event.line_id);
      host.bridgeBuffer.store(interactionId, events);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      host.diagnostics.warn("Bridge", `输入过渡旁白生成失败：${message}`);
    } finally {
      host.bridgeControllers.delete(interactionId);
    }
  })();
  void promise;
}

export function cancelBridgePrefetch(host: InteractionHost, interactionId: string): void {
  const controller = host.bridgeControllers.get(interactionId);
  if (controller !== undefined) {
    controller.abort();
    host.bridgeControllers.delete(interactionId);
  }
}

export async function handleInteractionInput(
  host: InteractionHost,
  interaction: InputInteraction | HybridInteraction,
  turn: number,
  branchManager: BranchManager | null,
  initialText?: string,
): Promise<InputCommitOutcome> {
  branchManager?.discardAll();
  host.status.clearBranches();
  const interactionId = interaction.interaction_id;
  // The bridge is shared across preview cancels; it is consumed only at
  // confirm so a cancelled preview can retry with the same bridge.
  let bridgeEvents = host.bridgeBuffer.peek(interactionId) ?? [];

  while (true) {
    let text: string;
    if (initialText !== undefined && initialText.trim().length > 0) {
      // Text already provided — skip editor, jump to preview
      text = initialText.trim();
      initialText = undefined;
    } else {
      host.status.setPhase("等待输入", "等待玩家自由输入");
      host.status.setBuffer(host.buffered.size, countBufferedDialogues(host));
      // §10.2 lifecycle: (re)opening the interaction re-arms the command
      // scope; the id survives preview cancels.
      host.activeInteractionId = interactionId;
      const presentation = host.openInteractionStage(interactionId);
      host.emit({
        type: "interaction_opened",
        interactionId,
        interaction,
        ...(presentation !== undefined ? { presentation } : {}),
      });
      const command = await host.waitForInteractionCommand(
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
    const session = host.inputEngine.startEditing(interaction);
    host.inputEngine.updateDraft(session, text);
    host.inputEngine.requestPreview(session);

    const previewId = host.ids.nextPreviewId(interactionId);
    const responseSession = new InputResponseSession({
      previewId,
      interactionId,
      generationId: host.ids.nextGenerationId(`input:${interactionId}`),
      frozenText: text,
      bridgeEvents,
    });

    host.status.setPhase("输入预览", `玩家输入：${text.slice(0, 50)}`);
    const previewStartTime = host.clock.nowMs();
    host.status.setJob(
      "input-response",
      `NPC 回应：${text.slice(0, 30)}`,
      "running"
    );

    // Fire NPC response generation in background; every complete event is
    // staged into the session immediately (never the formal log).
    const { promise: responsePromise, controller: responseController } =
      startInputResponseGeneration(host, interaction, turn, text, responseSession);

    // Don't await — the driver shows the preview while generating.
    void responsePromise.catch(() => undefined);

    // Show preview and await confirmation.
    // §10.2 lifecycle: the preview is the active confirm/cancel scope from
    // `input_preview_opened` until it is cancelled or confirmed.
    host.activePreviewId = previewId;
    host.emit({ type: "input_preview_opened", previewId, text });
    let previewCommand: RuntimeCommand;
    if (host.config.input.require_preview_confirmation) {
      previewCommand = await host.waitForCommand(
        (c) =>
          (c.type === "confirm_input" || c.type === "cancel_input") &&
          c.previewId === previewId,
      );
    } else {
      // Single-Enter flow: the preview is implicit, commit immediately.
      previewCommand = { type: "confirm_input", previewId };
    }
    const previewDwellMs = host.clock.nowMs() - previewStartTime;
    host.metrics.recordInputPreview(previewDwellMs);

    // The bridge prefetch may still be landing when the interaction opens
    // (its handle stream settles a microtask after the terminal group).
    // Refresh at the commit point so a late but valid bridge is included;
    // the buffer is consumed only at confirm, so this is idempotent.
    bridgeEvents = host.bridgeBuffer.peek(interactionId) ?? [];

    if (previewCommand.type === "cancel_input") {
      // Return to editing — abort the stale response request so its events
      // can never be buffered or rendered for the previous edit session.
      responseController.abort();
      responseSession.cancel();
      host.metrics.recordInputResponseCanceled();
      host.inputEngine.cancel(session);
      host.status.removeJob("input-response");
      host.status.clearBranches();
      // §10.2 lifecycle: cancel releases the preview scope only; the
      // interaction stays open for the next preview.
      host.activePreviewId = null;
      host.emit({ type: "input_preview_canceled", previewId });
      host.media.discardCandidate(previewId);
      if (interaction.mode === "hybrid") {
        // §11.7: a hybrid cancel hands control back to the hybrid loop,
        // which re-arms BOTH submission paths and re-prefetches the
        // option branches (the interaction is still open).
        return { type: "canceled" };
      }
      continue;
    }

    // Confirm — commit the session.
    host.inputEngine.commit(session);
    responseSession.commit();
    // The input is now resolved and can no longer be submitted; browsers
    // close the form. Emitted before input_committed so a reconnect never
    // restores the resolved interaction.
    host.emit({ type: "interaction_resolved", interactionId, resolution: "input" });
    // §10.2 lifecycle: confirm releases both the preview and interaction
    // scope — no further confirm/cancel may touch this preview.
    host.activeInteractionId = null;
    host.activePreviewId = null;
    host.emit({ type: "input_committed", previewId });
    host.bridgeBuffer.take(interactionId);
    // The interaction is resolved: stop the bridge prefetch task so late
    // narration can never be buffered for a dead interaction.
    cancelBridgePrefetch(host, interactionId);

    // Confirm → first response line measurement (E3/G1).
    host.inputConfirmAtMs = host.clock.nowMs();
    if (responseSession.responseEvents.length > 0) {
      host.metrics.recordInputConfirmToFirstResponseLine(0);
      host.inputConfirmAtMs = null;
    }

    const playerDialogue = makePlayerDialogue(host, interactionId, text);

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
        generationId: host.ids.nextGenerationId(`input:${interactionId}:repair`),
        frozenText: text,
        bridgeEvents,
      });
      const repair = startInputResponseGeneration(host, interaction, turn, text, liveSession);
      void repair.promise.catch(() => undefined);
      host.status.setJob(
        "input-response",
        `NPC 回应：${text.slice(0, 30)}`,
        "running"
      );
    } else if (!responseSession.settled) {
      // Live promotion: the confirmed stream is still running; its later
      // events enter the formal buffer directly. No abort, no new request.
      liveSession = responseSession;
      host.metrics.recordInputResponsePromotedLive();
    }

    await recordPlayerInput(host, interactionId, text, turn);
    host.status.setPhase(
      "输入已提交",
      `玩家输入：${text.slice(0, 50)}`
    );

    // M5.3 同选项快进（free_input 与既有出边文本严格相等）：命中即零生成。
    const fastForward = host.takePendingFastForward();
    if (fastForward !== undefined) {
      host.status.removeJob("input-response");
      return { type: "committed", preview: [], fastForward };
    }

    if (!liveSession) {
      // Response finished before/during confirm: return the fixed prefix.
      await responseSession.done;
      if (responseSession.failure) {
        host.diagnostics.warn("input", `NPC 回应生成失败 — ${responseSession.failure.message}`);
      }
      host.media.registerActive(responseSession.responseEvents);
      host.status.removeJob("input-response");
      host.narrativeDirector?.checkpoint("interaction_completed");
      return {
        type: "committed",
        preview: [playerDialogue, ...bridgeEvents, ...responseSession.responseEvents],
      };
    }

    // Live path: the response prefix already staged plays first, late
    // events flow to the formal buffer via consumeLiveInputResponse.
    void liveSession.done.then(() => {
      if (liveSession.failure) {
        host.diagnostics.warn("input", `NPC 回应生成失败 — ${liveSession.failure.message}`);
      }
    });
    host.media.registerActive(liveSession.responseEvents);
    host.narrativeDirector?.checkpoint("interaction_completed");
    return {
      type: "committed",
      preview: [playerDialogue, ...bridgeEvents, ...liveSession.responseEvents],
      liveResponse: liveSession,
    };
  }
}

function startInputResponseGeneration(
  host: InteractionHost,
  interaction: InputInteraction | HybridInteraction,
  turn: number,
  text: string,
  responseSession: InputResponseSession,
): { promise: Promise<void>; controller: AbortController } {
  const controller = new AbortController();
  // DSL mode: response groups compile against a response-local visual
  // state seeded from the current tail (docs §79).
  let responseState = host.tailVisualState;

  const brief = host.makeBriefing(turn + 1);
  const handle = host.generator.generateInputResponse({
    turn: turn + 1,
    state: host.storyState,
    history: [...host.events],
    interaction,
    playerInput: text,
    signal: controller.signal,
    ...(brief !== undefined && brief !== "" ? { briefing: brief } : {}),
    tailVisualState: host.tailVisualState,
  });

  // 泵：把 handle 的事件流喂进 staging 路径（与旧 onGroup 直连等价）。
  // 中止后的迟到组照旧丢弃并计数。
  const pump = (async () => {
    for await (const group of handle.events) {
      if (controller.signal.aborted) {
        host.metrics.recordStaleInputEventDropped();
        continue;
      }
      const { playable, tailState } = host.compileGroup(group, responseState, turn);
      responseState = tailState;
      if (playable !== null) {
        stageResponseEvent(host, responseSession, playable);
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
          host.status.setJob(
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
        host.tailVisualState = responseState;
        responseSession.markReady();
        host.status.setJob(
          "input-response",
          `NPC 回应：${text.slice(0, 30)}`,
          "ready"
        );
      },
      (error) => {
        if (controller.signal.aborted) return;
        const err = error instanceof Error ? error : new Error(String(error));
        responseSession.markFailed(err);
        host.status.setJob(
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

function stageResponseEvent(
  host: InteractionHost,
  responseSession: InputResponseSession,
  event: RuntimePlayableEvent,
): void {
  const confirmAt = host.inputConfirmAtMs;
  const firstAfterConfirm =
    confirmAt !== null && responseSession.responseEvents.length === 0;
  responseSession.appendResponseEvent(event);
  host.responseLineIds.add(event.line_id);
  if (firstAfterConfirm) {
    host.metrics.recordInputConfirmToFirstResponseLine(host.clock.nowMs() - confirmAt);
    host.inputConfirmAtMs = null;
  }
}

/** 玩家台词事件（带会话内稳定 line_id）。 */
function makePlayerDialogue(
  host: InteractionHost,
  interactionId: string,
  text: string,
): PlayerDialogueEvent {
  return {
    type: "player_dialogue",
    interaction_id: interactionId,
    speaker: "你",
    text,
    line_id: host.nextLineId(),
  };
}

export async function recordPlayerInput(
  host: InteractionHost,
  interactionId: string,
  text: string,
  turn: number,
): Promise<void> {
  const stored: StoredPlayerInputEvent = {
    type: "player_input",
    interaction_id: interactionId,
    text,
    seq: host.seq,
    turn,
    timestamp: host.clock.nowIso(),
    source: "player"
  };
  host.seq += 1;
  await host.record(stored);
}

export async function recordPlayerDialogue(
  host: InteractionHost,
  event: PlayerDialogueEvent,
  turn: number,
): Promise<void> {
  const stored: StoredPlayerDialogueEvent = {
    ...event,
    seq: host.seq,
    turn,
    timestamp: host.clock.nowIso(),
    source: "player"
  };
  host.seq += 1;
  await host.record(stored);
}

function countBufferedDialogues(host: InteractionHost): number {
  return [...host.buffered.values()].filter(
    (event) => event.type === "dialogue"
  ).length;
}
