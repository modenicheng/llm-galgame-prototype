/**
 * Event mode 分级收束（L1 wrapup / L2 closing / L3 保险丝）、
 * 长回合护栏与修复链上限的行为测试。
 *
 * 脚手架与 game.test.ts 同族（mock generator + MemoryController 驱动完整
 * run loop），独立成文件以聚焦收束语义；低水位 refill 同样关闭（buffer
 * 段由 run loop 的 buffer 分支直接续写）。
 */

import { describe, it, expect, vi } from "vitest";
import { Game } from "./game.js";
import { DEFAULT_NARRATIVE_CONFIG } from "./config.js";
import { createInitialState } from "./story/state.js";
import { makeTestConfig, makeTestPorts, MemoryController, MemorySessionStore } from "./test-helpers.js";
import type { StoryGeneratorPort } from "./core/ports/story-generator-port.js";
import { createGenerationHandle } from "./core/ports/story-generator-port.js";
import type {
  BranchPrefetchRequest,
  ContinuationRequest,
  GenerationHandle,
  OpeningRequest,
} from "./core/ports/story-generator-port.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import type { RuntimeStatus } from "./status.js";
import type { AppConfig } from "./config.js";
import type {
  EndEvent,
  InteractionEvent,
  StoredEvent,
} from "./schema.js";
import type { GenerationEnvelope } from "./story/types.js";
import type { EventGroupDraft } from "./core/protocol/gal-dsl/types.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

function makeGameConfig(
  narrative: AppConfig["narrative"],
): AppConfig {
  return makeTestConfig({
    text_buffer: { start_threshold_lines: 1, target_lines: 6, refill_threshold_lines: -1 },
    narrative,
  });
}

function makeMockGenerator(): StoryGeneratorPort {
  return {
    generateOpening: vi.fn(),
    generateBranchPrefetch: vi.fn(() =>
      createGenerationHandle("branch", async () => ({ events: [], state_patch: {}, groups: [] })),
    ),
    generateInputResponse: vi.fn(),
    generateContinuation: vi.fn(),
    generateInputBridge: vi.fn(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    ),
  } as unknown as StoryGeneratorPort;
}

function makeMockMedia(): MediaPlannerPort {
  return {
    registerActive: vi.fn(),
    registerCandidate: vi.fn(),
    activateCandidate: vi.fn(),
    discardCandidate: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    markPresented: vi.fn(),
  } as unknown as MediaPlannerPort;
}

function makeMockStatus(): RuntimeStatus {
  return {
    setPhase: vi.fn(),
    setJob: vi.fn(),
    removeJob: vi.fn(),
    setBuffer: vi.fn(),
    setBranch: vi.fn(),
    clearBranches: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => undefined),
    snapshot: vi.fn().mockReturnValue({ branches: {} }),
  } as unknown as RuntimeStatus;
}

type EnvelopeDraft =
  | { type: "narration"; text: string }
  | InteractionEvent
  | EndEvent;

function groupFromEvent(draft: EnvelopeDraft): EventGroupDraft {
  if (draft.type === "narration") {
    return { prelude: [], main: { type: "narration", text: draft.text } };
  }
  if (draft.type === "interaction") {
    return {
      prelude: [],
      main: {
        type: "interaction",
        interaction: {
          prompt: draft.prompt,
          mode: draft.mode,
          optionTexts:
            draft.mode === "input" ? [] : draft.options.map((option) => option.text),
        },
      },
    };
  }
  throw new Error("end 事件不是组：请用段结束哨兵表达结局。");
}

function envelope(drafts: EnvelopeDraft[]): GenerationEnvelope {
  let reason: "buffer" | "interaction" | "ending" = "buffer";
  const groups: EventGroupDraft[] = [];
  for (const draft of drafts) {
    if (draft.type === "end") {
      reason = "ending";
      continue;
    }
    if (draft.type === "interaction") reason = "interaction";
    groups.push(groupFromEvent(draft));
  }
  return {
    events: [],
    state_patch: {},
    groups,
    segmentEnd: { kind: "complete", nonce: "0000", reason },
  };
}

function handleFromDrafts(id: string, drafts: EnvelopeDraft[]): GenerationHandle {
  return createGenerationHandle(id, async (_signal, onGroup) => {
    for (const draft of drafts) {
      // end 不是组：结局经 envelope 的 segmentEnd（reason=ending）表达。
      if (draft.type === "end") continue;
      onGroup(groupFromEvent(draft));
    }
    return envelope(drafts);
  });
}

function narrationEvent(text = "Some narration."): EnvelopeDraft {
  return { type: "narration", text };
}

function endEvent(endingId = "end_1", text = "The end."): EndEvent {
  return { type: "end", ending_id: endingId, text };
}

/** choice 交互（policy：至少 2 个选项）。 */
function interactionDraft(n: number): InteractionEvent {
  return {
    type: "interaction",
    interaction_id: `interaction_${n}`,
    prompt: `问题${n}`,
    mode: "choice",
    options: [
      { id: `interaction_${n}_opt_0`, text: "选项A" },
      { id: `interaction_${n}_opt_1`, text: "选项B" },
    ],
  };
}

function seedState() {
  return createInitialState({
    open_threads: [
      { id: "seed-situation", summary: "本局种子情境", status: "new", last_touched_turn: 0 },
    ],
  });
}

function eventModeConfig(event: Partial<AppConfig["narrative"]["event"]>): AppConfig {
  return makeGameConfig({
    ...DEFAULT_NARRATIVE_CONFIG,
    mode: "event",
    event: {
      wrapup_interactions: 2,
      closing_push_interactions: 3,
      max_interactions: 0,
      max_events_between_interactions: 0,
      ...event,
    },
  });
}

function autoSelectingController(): MemoryController {
  const controller = new MemoryController({
    onInteractionOpened: (output) => {
      const options = (output.interaction as { options?: Array<{ id: string }> })
        .options;
      const first = options?.[0];
      if (first) controller.select(output.interactionId, first.id);
    },
  });
  return controller;
}

/** 脚本化续写：逐请求弹出一组草稿；耗尽后回退到收束结局。 */
function scriptContinuations(
  generator: StoryGeneratorPort,
  scripts: EnvelopeDraft[][],
): { requests: ContinuationRequest[] } {
  const requests: ContinuationRequest[] = [];
  (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
    (request: ContinuationRequest) => {
      requests.push(request);
      const drafts = scripts.shift() ?? [endEvent("end_last", "Fin.")];
      return handleFromDrafts(`cont:${requests.length}`, drafts);
    },
  );
  return { requests };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("Event mode ending pressure", () => {
  it("escalates L1 → L2 via prompt-only hints and marks the seed thread ready", async () => {
    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) => {
        void request;
        return handleFromDrafts("opening", [narrationEvent("开场。"), interactionDraft(1)]);
      },
    );
    const { requests } = scriptContinuations(generator, [
      [narrationEvent("其一。"), interactionDraft(2)],
      [narrationEvent("其二。"), interactionDraft(3)],
      [narrationEvent("其三。"), endEvent("end_1", "Fin.")],
    ]);

    const controller = autoSelectingController();
    const game = new Game(
      eventModeConfig({}),
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts({ initialStoryState: seedState() }),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();
    expect(controller.ended()).toBe(true);

    expect(requests.length).toBe(3);
    // 第 1 次续写（交互 1 后）：无收束加压，进度已注入（count=1）。
    expect(requests[0]!.endingPhase).toBeUndefined();
    expect(requests[0]!.interactionProgress).toEqual({ count: 1, target: 2 });
    // 第 2 次续写（交互 2 后，count=2 ≥ wrapup=2）：L1 软提示 + 进度注入。
    expect(requests[1]!.endingPhase).toBe("wrapup");
    expect(requests[1]!.interactionProgress).toEqual({ count: 2, target: 2 });
    // 第 3 次续写（交互 3 后，count=3 ≥ closing=3）：L2 强提示。
    expect(requests[2]!.endingPhase).toBe("closing");
    // L1 进入时种子线程 new → ready（确定性投影）。
    expect(
      ((game as unknown as { storyState: { open_threads: Array<{ status: string }> } }).storyState
        .open_threads)[0]!.status,
    ).toBe("ready");
    expect((game as unknown as { endingLevel: number }).endingLevel).toBe(2);
    expect((game as unknown as { forceEnding: boolean }).forceEnding).toBe(false);
  });

  it("stops branch prefetch once L2 is active", async () => {
    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), interactionDraft(1)]),
    );
    scriptContinuations(generator, [
      [narrationEvent("其一。"), interactionDraft(2)],
      [narrationEvent("其二。"), interactionDraft(3)],
      [narrationEvent("其三。"), endEvent("end_1", "Fin.")],
    ]);

    const controller = autoSelectingController();
    const game = new Game(
      eventModeConfig({ wrapup_interactions: 1, closing_push_interactions: 2 }),
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();
    expect(controller.ended()).toBe(true);

    // 交互 3 的表单在 L2 已激活后提交 → 不再为它创建 BranchManager；
    // 已有交互 1/2 的预取不受影响（各 2 个选项）。
    const branchCalls = (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>)
      .mock.calls as unknown as Array<[BranchPrefetchRequest]>;
    expect(branchCalls.length).toBe(4);
    for (const [request] of branchCalls) {
      expect(request.option.id.startsWith("interaction_3")).toBe(false);
    }
  });

  it("runs the L3 fuse: forced segment disobeys → runtime synthesizes the ending", async () => {
    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), interactionDraft(1)]),
    );
    // 交互 3 后（max_interactions=3）forceEnding 生效：强制段仍开交互表单，
    // 玩家选择后重试段只给 buffer → 预算耗尽 → 运行时合成结局。
    scriptContinuations(generator, [
      [narrationEvent("其一。"), interactionDraft(2)],
      [narrationEvent("其二。"), interactionDraft(3)],
      [narrationEvent("强制段仍不收束。"), interactionDraft(4)],
      [narrationEvent("重试段只给 buffer。")],
    ]);

    const controller = autoSelectingController();
    const game = new Game(
      eventModeConfig({ wrapup_interactions: 1, closing_push_interactions: 2, max_interactions: 3 }),
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const ended = controller.outputs.find((output) => output.type === "session_ended");
    expect(ended).toBeDefined();
    expect((ended as unknown as { ending: EndEvent }).ending.text).toBe("（故事在此落幕。）");
  });

  it("forced retry carries the nonce-free repair reason and the model ends the session", async () => {
    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), interactionDraft(1)]),
    );
    const { requests } = scriptContinuations(generator, [
      [narrationEvent("其一。"), interactionDraft(2)],
      [narrationEvent("其二。"), interactionDraft(3)],
      // 强制段（endingRequired）以 buffer 收束 → run loop 带修复语义重试。
      [narrationEvent("强制段 buffer。")],
      [narrationEvent("重试段收束。"), endEvent("end_1", "Fin.")],
    ]);

    const controller = autoSelectingController();
    const game = new Game(
      eventModeConfig({ wrapup_interactions: 1, closing_push_interactions: 2, max_interactions: 3 }),
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();
    expect(controller.ended()).toBe(true);

    const forcedRequests = requests.filter((request) => request.endingRequired === true);
    expect(forcedRequests.length).toBeGreaterThanOrEqual(2);
    const repairRequest = forcedRequests.find((request) => request.repairReason !== undefined);
    expect(repairRequest).toBeDefined();
    // A1 回归：修复原因不得包含字面 `{nonce}`（曾导致哨兵校验必然失败）。
    expect(repairRequest!.repairReason).toContain("最大互动次数");
    expect(repairRequest!.repairReason).not.toContain("{nonce}");
  });

  it("long-turn guard hints a continuation to open an interaction soon", async () => {
    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), interactionDraft(1)]),
    );
    const { requests } = scriptContinuations(generator, [
      // 选择后连续输出 4 条文本并以 buffer 收束（无交互点）。
      [
        narrationEvent("其一。"),
        narrationEvent("其二。"),
        narrationEvent("其三。"),
        narrationEvent("其四。"),
      ],
      [narrationEvent("其五。"), endEvent("end_1", "Fin.")],
    ]);

    const controller = autoSelectingController();
    const game = new Game(
      eventModeConfig({
        wrapup_interactions: 0,
        closing_push_interactions: 0,
        max_interactions: 0,
        max_events_between_interactions: 3,
      }),
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();
    expect(controller.ended()).toBe(true);

    expect(requests[0]!.requestInteraction).toBeUndefined();
    // 自上次交互已累计 4 条文本 ≥ 阈值 3：下一段续写附"尽快交互"提示。
    expect(requests[1]!.requestInteraction).toBe(true);
  });

  it("repair-chain cap escalates to L2 then the L3 fuse, and the session still ends", async () => {
    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), interactionDraft(1)]),
    );
    /** 带可播放前缀但无哨兵的失败段（模拟截断）。 */
    const failingHandle = (id: string): GenerationHandle =>
      createGenerationHandle(id, async (_signal, onGroup) => {
        onGroup(groupFromEvent(narrationEvent("截断前的一句。")));
        throw new Error("段结束时没有 @end 哨兵（截断）");
      });
    const requests: ContinuationRequest[] = [];
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) => {
        requests.push(request);
        if (requests.length <= 4) return failingHandle(`fail:${requests.length}`);
        return handleFromDrafts(`cont:${requests.length}`, [
          narrationEvent("重试收束。"),
          endEvent("end_1", "Fin."),
        ]);
      },
    );

    const controller = autoSelectingController();
    const game = new Game(
      eventModeConfig({
        wrapup_interactions: 0,
        closing_push_interactions: 0,
        max_interactions: 0,
      }),
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();
    expect(controller.ended()).toBe(true);

    // 修复 1（chain=1 < 2）：无加压。
    expect(requests[1]!.endingPhase).toBeUndefined();
    expect(requests[1]!.endingRequired).toBeUndefined();
    // 修复 2（chain=2 ≥ 2）：升 L2，强收束提示随下一段请求下发。
    expect(requests[2]!.endingPhase).toBeUndefined();
    expect(requests[3]!.endingPhase).toBe("closing");
    // 修复 3（L2 下仍耗尽）：event 模式启用 L3 保险丝。
    expect(requests[4]!.endingRequired).toBe(true);
    expect((game as unknown as { forceEnding: boolean }).forceEnding).toBe(true);
  });

  it("restore rebuilds the interaction count and ending level from the event log", async () => {
    const generator = makeMockGenerator();
    const { requests } = scriptContinuations(generator, [
      [narrationEvent("恢复后续写。"), endEvent("end_1", "Fin.")],
    ]);

    // 预置历史：2 次交互且均已被玩家回应（无挂起交互）。
    const base = { timestamp: "2026-09-14T00:00:00.000Z" };
    const storeEvents: StoredEvent[] = [
      { type: "narration", text: "历史旁白。", line_id: "l1", seq: 1, turn: 1, source: "model", ...base },
      { ...interactionDraft(1), seq: 2, turn: 1, source: "model", ...base },
      { type: "player_choice", choice_id: "interaction_1_opt_0", text: "选项A", seq: 3, turn: 1, source: "player", ...base },
      { ...interactionDraft(2), seq: 4, turn: 2, source: "model", ...base },
      { type: "player_choice", choice_id: "interaction_2_opt_0", text: "选项A", seq: 5, turn: 2, source: "player", ...base },
    ];
    const store = new MemorySessionStore();
    for (const event of storeEvents) await store.append(event);

    const controller = autoSelectingController();
    const game = new Game(
      eventModeConfig({}),
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts({ store, initialStoryState: seedState() }),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();
    expect(controller.ended()).toBe(true);

    // 恢复即处于 L1（交互 2 ≥ wrapup=2）：首个续写请求带软提示与进度。
    expect(requests[0]!.endingPhase).toBe("wrapup");
    expect(requests[0]!.interactionProgress).toEqual({ count: 2, target: 2 });
    expect(
      ((game as unknown as { storyState: { open_threads: Array<{ status: string }> } }).storyState
        .open_threads)[0]!.status,
    ).toBe("ready");
  });
});
