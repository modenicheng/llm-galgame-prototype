/**
 * Choice 交互路径（handleChoice / 分支预取组 / 已选分支 adoption /
 * 玩家选择记账），自 interaction-driver 二分而来（豁免清偿：M4.5/GH-P4）。
 *
 * 函数均为自由函数、首参 `host: InteractionHost`；对宿主的访问与行为
 * 语义与二分前的 driver 方法逐行一致。
 */
import { RuntimeShutdownError } from "../core/runtime/errors.js";
import type { AnyStreamedGroup } from "../core/protocol/gal-dsl/types.js";
import type {
  ChoiceEvent,
  ChoiceOption,
  InteractionEvent,
  RuntimePlayableEvent,
  StoredPlayerChoiceEvent,
  StoryContextEvent,
} from "../schema.js";
import type { StageCue } from "../core/presentation/types.js";
import type { LiveBranchSelection } from "./prefetch.js";
import { BranchManager } from "./branch-manager.js";
import type { ChoiceSelection } from "./segment-types.js";
import type { InteractionHost } from "./interaction-driver.js";

export function createBranchManagerForTerminal(
  host: InteractionHost,
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
    return createBranchManager(host, choice, turn, context, terminal.interaction_id, "choice");
  }
  return null;
}

export async function handleChoice(
  host: InteractionHost,
  choice: ChoiceEvent,
  turn: number,
  branchManager: BranchManager | null,
  prefetchContext: StoryContextEvent[],
  interactionId?: string,
): Promise<ChoiceSelection> {
  if (!branchManager) throw new Error("内部错误：choice 缺少分支预取组。 ");

  host.status.setPhase("等待选择", "各分支正在并行预取；可随时选择");
  // Legacy choice events have no interaction_id; DSL-compiled choice
  // interactions carry the runtime-generated id (docs §30).
  const scopeId = interactionId ?? `choice_${turn}`;
  // §10.2 lifecycle: the interaction is the active command scope from
  // `interaction_opened` until it resolves.
  host.activeInteractionId = scopeId;
  const presentation = host.openInteractionStage(scopeId);
  host.emit({
    type: "interaction_opened",
    interactionId: scopeId,
    interaction: choice,
    ...(presentation !== undefined ? { presentation } : {}),
  });
  const command = await host.waitForInteractionCommand(
    scopeId,
    { select_choice: true },
  );
  if (command.type !== "select_choice") throw new RuntimeShutdownError();
  const selected = choice.options.find((option) => option.id === command.optionId);
  if (!selected) throw new Error(`未找到选项：${command.optionId}`);
  // The option exists: the interaction is now resolved and can no longer
  // be submitted; browsers close the form immediately.
  host.emit({ type: "interaction_resolved", interactionId: scopeId, resolution: "choice" });
  // §10.2 lifecycle: choice accepted → the interaction scope is released.
  host.activeInteractionId = null;
  host.choiceTimestamp = host.clock.nowMs();
  await recordPlayerChoice(host, selected, turn);
  // The checkpoint fires only AFTER the player choice is formally
  // committed: a consolidation triggered here must include the choice
  // event (audit finding 5).
  host.narrativeDirector?.checkpoint("interaction_completed");
  host.diagnostics.info("player", `你选择了：${selected.text}`);

  // M5.3 同选项快进：命中既有出边 → 零生成，直接把恢复点交给运行循环
  //（运行循环据此切到后继节点的恢复表单）。
  const fastForward = host.takePendingFastForward();
  if (fastForward !== undefined) {
    // 快进跳过了 adoptSelectedBranch（唯一取消未选分支的路径）：预取组
    // 必须整组丢弃，否则孤儿泵持续回写 branchTailStates/名牌表，与
    // 恢复表单重建的同 id 选项竞写同一键。
    branchManager?.discardAll();
    for (const option of choice.options) {
      host.status.removeJob(`branch:${option.id}`);
    }
    host.status.clearBranches();
    return { preview: [], fastForward };
  }

  const { preview, liveSelection } = await adoptSelectedBranch(
    host,
    selected,
    choice,
    turn,
    branchManager,
    prefetchContext,
  );

  for (const option of choice.options) {
    host.status.removeJob(`branch:${option.id}`);
  }
  host.status.clearBranches();
  return {
    preview,
    ...(liveSelection ? { liveSelection } : {}),
  };
}

export async function adoptSelectedBranch(
  host: InteractionHost,
  selected: ChoiceOption,
  choice: ChoiceEvent,
  turn: number,
  branchManager: BranchManager,
  prefetchContext: StoryContextEvent[],
): Promise<{ preview: RuntimePlayableEvent[]; liveSelection?: LiveBranchSelection }> {
  host.status.setPhase("切换分支", "取消未选分支，装载已选预取片段");
  const selectStart = host.clock.nowMs();
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
    host.diagnostics.info(
      "Prefetch",
      `选择"${selected.text}" → 取回 ${preview.length} 条已到达事件，耗时 ${host.clock.nowMs() - selectStart}ms (预取状态=${selectedState})`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.status.setJob("selected-branch-retry", "已选分支重试", "running");
    // 终审（campus 84a68ee finding 6，main 侧同缺陷）：v2fwd 后预取泵
    // 逐组即时落表（branchCharacterStates/branchTailStates），失败分支
    // 的半程预测（改名/舞台折叠）已经写进分支副本。这些事件玩家从未
    // 见过（候选失败，前缀不播出、不 append）——预测副本随失败尝试
    // 一并丢弃（与未选/取消同生命周期），重试从主状态重新播种：既不
    // 让幽灵改名渗进重试请求的 characterState（generationIdentity 读
    // 同表），也不渗进重试组编译的 displayLabel 快照。
    host.branchTailStates.delete(selected.id);
    host.branchCharacterStates.delete(selected.id);
    try {
      const retryBrief = host.makeBriefing(turn + 1);
      const handle = host.generator.generateBranchPrefetch({
        identity: host.generationIdentity(selected.id),
        turn: turn + 1,
        state: host.storyState,
        history: prefetchContext,
        choice,
        option: selected,
        ...(retryBrief !== undefined && retryBrief !== "" ? { briefing: retryBrief } : {}),
        tailVisualState: host.tailVisualState,
      });
      await handle.done;
      const groups: AnyStreamedGroup[] = [];
      for await (const group of handle.events) groups.push(group);
      const result = host.materializeDslGroups(
        groups,
        host.tailVisualState,
        turn,
        // 重试路径（port 自 campus a1b7aac + 84a68ee 修复）：失败尝试的
        // 预测副本已在 catch 顶部丢弃（其事件不播出，预测不转正）——从
        // 主状态重新播种；折叠结果回表，随统一的 promote/clear 生命周期。
        host.characterState,
      );
      host.branchTailStates.set(selected.id, result.tailState);
      host.branchCharacterStates.set(selected.id, result.tailLabels);
      preview = result.events;
      host.media.registerCandidate(selected.id, preview);
    } finally {
      // 重试本身也可能失败（异常上抛）——状态任务必须随之解除（port
      // 自 campus 84a68ee：成功路径之外的 removeJob 会让重试双重失败时
      // 状态视图悬挂 running 任务）。
      host.status.removeJob("selected-branch-retry");
    }
  }

  // The selected branch's tail visual state becomes the new predictive
  // tail (docs §56): the next generation continues from where the branch
  // actually leaves the stage. For a live-selected branch whose request
  // has not resolved yet, derive the tail from the committed prefix's
  // stage cues.
  const branchTail = host.branchTailStates.get(selected.id);
  if (branchTail !== undefined) {
    host.tailVisualState = branchTail;
  }
  // 选中分支的预测名牌副本才转正；其余分支的副本随 clear 一并丢弃。
  host.promoteBranchCharacterState(selected.id);
  if (branchTail === undefined) {
    const cues: StageCue[] = [];
    for (const event of preview) {
      const stage = (event as { stage?: StageCue[] }).stage;
      if (stage !== undefined) cues.push(...stage);
    }
    if (cues.length > 0) {
      host.tailVisualState = host.reduce(host.tailVisualState, cues);
    }
  }
  host.branchTailStates.clear();

  host.media.activateCandidate(selected.id);
  host.media.registerActive(preview);
  host.registerBuffered(preview);

  return {
    preview,
    ...(liveSelection ? { liveSelection } : {}),
  };
}

export function createBranchManager(
  host: InteractionHost,
  choice: ChoiceEvent,
  turn: number,
  prefetchContext: StoryContextEvent[],
  interactionId?: string,
  source: "choice" | "input_preview" = "choice"
): BranchManager {
  const manager = new BranchManager(host.metrics);

  for (const option of choice.options) {
    manager.createCandidate(
      option.id,
      interactionId ?? `choice_${turn}`,
      source
    );
  }

  manager.startPrefetch({
    choice,
    concurrency: host.config.prefetch.branch_concurrency,
    status: host.status,
    generate: async (option, signal, onEvent) => {
      const materialized: RuntimePlayableEvent[] = [];
      // DSL mode: branch groups compile against a branch-local visual
      // state seeded from the current tail (docs §56). Unselected
      // branches never execute, so their states stay isolated here.
      let branchState = host.tailVisualState;
      // C5 §5.1 + C6（C5 评审 minor，port 自 campus 0b8de2e）：名牌状态
      // 按分支持副本（绑定本局 roster revision），身份只克隆一次——预取
      // 请求与分支名牌副本共用同一份 characterState（请求侧只读；v2 的
      // labelOps 折叠在泵内逐组重绑，不污染发出去的那份快照）。未选/
      // 取消/修复失败随分支丢弃。
      const branchIdentity = host.generationIdentity(option.id);
      let branchLabels = branchIdentity.characterState;
      const prefetchBrief = host.makeBriefing(turn + 1);
      const handle = host.generator.generateBranchPrefetch({
        identity: branchIdentity,
        turn: turn + 1,
        state: host.storyState,
        history: prefetchContext,
        choice,
        option,
        signal,
        ...(prefetchBrief !== undefined && prefetchBrief !== "" ? { briefing: prefetchBrief } : {}),
        tailVisualState: host.tailVisualState,
      });
      // 泵：与旧 onGroup 直连语义等价——组到达即编译并喂给 onEvent
      // （branch-local visual state 逐组折叠；v2 的 labelOps 同步折进
      // 分支名牌副本，port 自 campus a1b7aac + cb7804b）。
      const pump = (async () => {
        for await (const group of handle.events) {
          // handoff/取消后的迟到组不再折叠：预测状态必须与玩家可见的
          // 已提交前缀一致（迟到事件被消费侧丢弃，不播放）。
          if (signal.aborted) break;
          const { playable, tailState, nextLabels } = host.compileRoutedGroup(
            group,
            branchState,
            branchLabels,
            turn,
          );
          branchState = tailState;
          // v2：预测名牌操作（@name）折叠进分支副本——未选/取消即丢弃，
          // 选中才随 promote 转正（与 branchTailStates 同一生命周期）。
          branchLabels = nextLabels;
          // 逐组即时落表（v1 仅在收尾落表，最终值相同）：live 选择/handoff
          // 可能在泵收尾前读取预测状态，表内容必须与已到达的组同步。
          host.branchTailStates.set(option.id, branchState);
          host.branchCharacterStates.set(option.id, branchLabels);
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
      return materialized;
    },
    onReady: (option, branchEvents) => {
      host.media.registerCandidate(option.id, branchEvents);
    }
  });

  return manager;
}

export async function recordPlayerChoice(
  host: InteractionHost,
  option: ChoiceOption,
  turn: number,
): Promise<"recorded" | "fast_forwarded"> {
  const stored: StoredPlayerChoiceEvent = {
    type: "player_choice",
    choice_id: option.id,
    text: option.text,
    seq: host.seq,
    turn,
    timestamp: host.clock.nowIso(),
    source: "player"
  };
  host.seq += 1;
  return host.record(stored);
}
