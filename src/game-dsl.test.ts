/**
 * DSL-mode Game integration tests — the Gal DSL pipeline end-to-end
 * through the runtime (docs/llm-outputs-refactor.md §36–§39, §49–§51,
 * §76, §105–§106).
 *
 * These tests drive the Game with a mock StoryGenerator that emits DSL
 * EventGroupDrafts via onGroup + onSegmentEnd, exactly like the real
 * generator's dsl protocol branch.
 */
import { describe, it, expect, vi } from "vitest";
import type { StoryGeneratorPort } from "./core/ports/story-generator-port.js";
import { createGenerationHandle } from "./core/ports/story-generator-port.js";
import type {
  GenerationHandle,
  OpeningRequest,
  ContinuationRequest,
  BranchPrefetchRequest,
  InputResponseRequest,
  InputBridgeRequest,
} from "./core/ports/story-generator-port.js";
import type { AppConfig } from "./config.js";
import { Game } from "./game.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import { RuntimeStatus } from "./status.js";
import {
  makeTestConfig,
  makeTestPorts,
  MemoryController,
  type InteractionOpenedOutput,
} from "./test-helpers.js";
import type {
  EventGroupDraft,
  DslInteractionDraft,
  SegmentEndReason,
  SegmentEndStatus,
} from "./core/protocol/gal-dsl/types.js";
import type { GenerationEnvelope } from "./story/types.js";
import type { RuntimeOutput } from "./core/runtime/runtime-output.js";
import type { AssetCatalog } from "./core/assets/types.js";
import type { RuntimePlayableEvent } from "./schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG: AssetCatalog = {
  guidance: "测试素材。",
  backgrounds: {
    basement: { id: "basement", src: "backgrounds/basement.jpg", description: "地下室" },
  },
  bgm: {
    mystery: { id: "mystery", src: "audio/bgm/mystery.mp3", description: "悬疑" },
  },
  soundEffects: {},
  spriteSets: {
    suyao: {
      id: "suyao",
      variants: {
        normal: { id: "normal", src: "characters/suyao/normal.png" },
        anxious: { id: "anxious", src: "characters/suyao/anxious.png" },
      },
    },
  },
  characters: {
    suyao: {
      characterId: "suyao",
      scriptName: "苏遥",
      displayName: "苏遥",
      spriteSet: "suyao",
      defaultVariant: "normal",
      defaultPosition: "left",
      allowedSpriteSets: ["suyao"],
    },
  },
};

function makeDslConfig(overrides: Parameters<typeof makeTestConfig>[0] = {}): AppConfig {
  return makeTestConfig({
    ...overrides,
  });
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

function makeDslMockGenerator(): StoryGeneratorPort {
  return {
    generateOpening: vi.fn(),
    generateBranchPrefetch: vi.fn(),
    generateInputResponse: vi.fn(),
    generateInputBridge: vi.fn(),
    generateContinuation: vi.fn(),
  } as unknown as StoryGeneratorPort;
}

/**
 * Port-shaped DSL handle: the runner's `onGroup` calls stream into
 * `handle.events` and the returned envelope carries the segment-end
 * status — exactly like the real generator's DSL protocol branch.
 */
function dslHandle(
  id: string,
  run: (
    signal: AbortSignal,
    onGroup: (group: EventGroupDraft) => void,
  ) => Promise<GenerationEnvelope>,
): GenerationHandle {
  return createGenerationHandle(id, run);
}

function dslNarration(text: string, cues: EventGroupDraft["prelude"] = []): EventGroupDraft {
  return { prelude: cues, main: { type: "narration", text } };
}

function dslDialogue(
  speaker: string,
  text: string,
  partial: { prelude?: EventGroupDraft["prelude"]; variant?: string; position?: string; displayName?: string } = {},
): EventGroupDraft {
  const visual = partial.variant !== undefined || partial.position !== undefined
    ? {
        hasVisual: true,
        resetVisual: false,
        ...(partial.variant !== undefined ? { variant: partial.variant } : {}),
        ...(partial.position !== undefined ? { position: partial.position as "left" } : {}),
      }
    : { hasVisual: false, resetVisual: false };
  const name = partial.displayName !== undefined
    ? { hasName: true, resetName: false, displayName: partial.displayName }
    : { hasName: false, resetName: false };
  return {
    prelude: partial.prelude ?? [],
    main: { type: "dialogue", speaker, text, visual, name },
  };
}

function dslInteraction(draft: DslInteractionDraft, prelude: EventGroupDraft["prelude"] = []): EventGroupDraft {
  return { prelude, main: { type: "interaction", interaction: draft } };
}

function complete(reason: SegmentEndReason, nonce = "a81f"): SegmentEndStatus {
  return { kind: "complete", nonce, reason };
}

function playbackOf(outputs: RuntimeOutput[]) {
  return outputs.filter(
    (o): o is RuntimeOutput & { type: "playback_ready" } => o.type === "playback_ready",
  );
}

function interactionOpenedOf(outputs: RuntimeOutput[]) {
  return outputs.filter(
    (o): o is InteractionOpenedOutput => o.type === "interaction_opened",
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DSL mode — opening groups", () => {
  it("streams groups into buffered events with characterId + stage presentation", async () => {
    // refill_threshold 0：低水位只在玩家读完（ahead=0）时触发，保证续写
    // 段拿到的 history 是完整的两条已提交事件（§75 提前续写会截断它）。
    const config = makeDslConfig({
      text_buffer: { start_threshold_lines: 2, target_lines: 6, refill_threshold_lines: 0 },
    });
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        dslHandle("opening", async (_signal, onGroup) => {
          onGroup(dslNarration("地下室里只亮着终端的一点蓝光。", [
            { type: "background", assetId: "basement" },
          ]));
          onGroup(dslDialogue("苏遥", "你不该来这里。", {
            displayName: "神秘女子",
            variant: "normal",
            position: "left",
          }));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
        }),
    );
    // Buffer end → refill continuation → ending.
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) =>
        dslHandle("continuation", async (_signal, onGroup) => {
          expect(request.prefetchedEvents).toEqual([]);
          expect(request.history).toHaveLength(2); // the two committed events
          onGroup(dslNarration("故事结束。"));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
        }),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    const controller = new MemoryController();
    controller.attach(game);
    await game.run();

    const playbacks = playbackOf(controller.outputs);
    expect(playbacks).toHaveLength(3); // 2 opening + 1 ending narration
    const first = playbacks[0]!;
    expect(first.presentation?.visualState.background).toBe("basement");
    expect((first.event as { stage?: unknown }).stage).toMatchObject([
      { type: "background", assetId: "basement" },
    ]);

    const second = playbacks[1]!;
    expect(second.event).toMatchObject({
      type: "dialogue",
      characterId: "suyao",
      speaker: "神秘女子",
    });
    expect(second.presentation?.visualState.characters["suyao"]).toMatchObject({
      spriteSet: "suyao",
      variant: "normal",
      position: "left",
      displayName: "神秘女子",
      visible: true,
    });
    expect(controller.ended()).toBe(true);
    // TTS identity: the dialogue event carries the stable characterId.
    expect((second.event as { characterId?: string }).characterId).toBe("suyao");
  });

  it("synthesizes an EndEvent for @end ... ending and ends the session", async () => {
    const config = makeDslConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        dslHandle("opening", async (_signal, onGroup) => {
          onGroup(dslDialogue("苏遥", "再见了。"));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
        }),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    const controller = new MemoryController();
    controller.attach(game);
    await game.run();

    expect(controller.ended()).toBe(true);
    const ended = controller.outputs.find((o) => o.type === "session_ended");
    expect(ended && ended.type === "session_ended" ? ended.ending.ending_id : "").toBeTruthy();
  });
});

describe("DSL mode — interaction compile", () => {
  it("compiles a hybrid form into runtime interaction with generated ids, branch prefetch and bridge prefetch", async () => {
    const config = makeDslConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        dslHandle("opening", async (_signal, onGroup) => {
          onGroup(dslDialogue("苏遥", "别碰那台机器。"));
          onGroup(dslInteraction(
            {
              prompt: "怎么回应？",
              optionTexts: ["追问她", "暂时停手"],
              inputPlaceholder: "或输入自己的回答……",
              mode: "hybrid",
            },
            [{ type: "bgm", assetId: "mystery" }],
          ));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("interaction") };
        }),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        dslHandle("branch", async (_signal, onGroup) => {
          onGroup(dslDialogue("苏遥", "分支内容。"));
          return { events: [], state_patch: {}, groups: [dslDialogue("苏遥", "分支内容。")] };
        }),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        dslHandle("bridge", async (_signal, onGroup) => {
          onGroup(dslNarration("她沉默了一会儿。"));
          return { events: [], state_patch: {}, groups: [dslNarration("她沉默了一会儿。")] };
        }),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) =>
        dslHandle("continuation", async (_signal) => {
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
        }),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.select(output.interactionId, `${output.interactionId}_opt_1`),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    controller.attach(game);
    await game.run();

    const opened = interactionOpenedOf(controller.outputs);
    expect(opened).toHaveLength(1);
    const interaction = opened[0]!.interaction;
    if (interaction.type !== "interaction" || interaction.mode !== "hybrid") {
      throw new Error("expected a hybrid interaction");
    }
    expect(opened[0]!.interactionId).toBe("interaction_1");
    expect(interaction.interaction_id).toBe("interaction_1");
    expect(interaction.options.map((o) => o.text)).toEqual(["追问她", "暂时停手"]);
    expect(interaction.options[0]!.id).toBe("interaction_1_opt_0");
    expect(interaction.input.placeholder).toBe("或输入自己的回答……");
    expect(interaction.input.max_length).toBe(config.interaction.input.max_length);
    // The form opened with the stage cues (bgm mystery).
    expect(opened[0]!.presentation?.visualState.bgm).toBe("mystery");
    // Branch prefetch per option + one bridge prefetch.
    expect(generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2);
    expect(generator.generateInputBridge as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    // The chosen branch's events played (with characterId).
    const branchLine = playbackOf(controller.outputs).find(
      (o) => (o.event as { text?: string }).text === "分支内容。",
    );
    expect(branchLine).toBeDefined();
    expect((branchLine!.event as { characterId?: string }).characterId).toBe("suyao");
  });

  it("plays player line → prefetched bridge → streaming response for free input", async () => {
    const config = makeDslConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        dslHandle("opening", async (_signal, onGroup) => {
          onGroup(dslInteraction({
            prompt: "你准备对她说什么？",
            optionTexts: [],
            inputPlaceholder: "输入你的回答……",
            mode: "input",
          }));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("interaction") };
        }),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        dslHandle("bridge", async (_signal, onGroup) => {
          onGroup(dslNarration("房间里安静下来。"));
          return { events: [], state_patch: {}, groups: [dslNarration("房间里安静下来。")] };
        }),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        dslHandle("input", async (_signal, onGroup) => {
          onGroup(dslDialogue("苏遥", "你明明知道它还在运行。"));
          return { events: [], state_patch: {}, groups: [dslDialogue("苏遥", "你明明知道它还在运行。")] };
        }),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) =>
        dslHandle("continuation", async (_signal) => {
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
        }),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你明明知道它还在运行。"),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    controller.attach(game);
    await game.run();

    // player line → bridge narration → NPC response dialogue
    const lines = playbackOf(controller.outputs).map((o) => o.event);
    const types = lines.map((e) => e.type);
    expect(types).toContain("player_dialogue");
    expect(types).toContain("narration");
    expect(types).toContain("dialogue");
    const playerIdx = lines.findIndex((e) => e.type === "player_dialogue");
    const bridgeIdx = lines.findIndex((e) => e.type === "narration" && e.text === "房间里安静下来。");
    const responseIdx = lines.findIndex((e) => e.type === "dialogue" && e.text === "你明明知道它还在运行。");
    expect(playerIdx).toBeGreaterThanOrEqual(0);
    expect(bridgeIdx).toBeGreaterThan(playerIdx);
    expect(responseIdx).toBeGreaterThan(bridgeIdx);
    expect(controller.ended()).toBe(true);
  });

  it("re-arms a hybrid after preview cancel: options stay clickable and branch prefetch restarts (docs §106)", async () => {
    const config = makeDslConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        dslHandle("opening", async (_signal, onGroup) => {
          onGroup(dslInteraction({
            prompt: "怎么回应？",
            optionTexts: ["追问她", "暂时停手"],
            inputPlaceholder: "或输入……",
            mode: "hybrid",
          }));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("interaction") };
        }),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        dslHandle("branch", async (_signal, onGroup) => {
          onGroup(dslDialogue("苏遥", "分支内容。"));
          return { events: [], state_patch: {}, groups: [dslDialogue("苏遥", "分支内容。")] };
        }),
    );
    // The cancel flow starts (then aborts) an input response generation.
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        dslHandle("input", async () => {
          return { events: [], state_patch: {}, groups: [] };
        }),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) =>
        dslHandle("continuation", async (_signal) => {
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
        }),
    );

    let firstInteraction = true;
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        if (firstInteraction) {
          firstInteraction = false;
          controller.submitInput(output.interactionId, "试探一下");
        } else {
          // After the cancel, the FULL hybrid re-opened — options clickable.
          controller.select(output.interactionId, `${output.interactionId}_opt_0`);
        }
      },
      onInputPreviewOpened: (output) => controller.cancel(output.previewId),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    controller.attach(game);
    await game.run();

    // Hybrid opened twice: once for the input attempt, once after cancel.
    expect(interactionOpenedOf(controller.outputs)).toHaveLength(2);
    // Branch prefetch ran for the re-armed hybrid.
    expect((generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(controller.ended()).toBe(true);
  });
});

describe("DSL mode — truncation recovery", () => {
  it("preserves committed groups and repairs via continuation when the segment is incomplete", async () => {
    // threshold 1：失败段（无 @end、endStatus 恒空）若触发首句门槛会热旋转；
    // 这里聚焦修复路径，门槛设为 1。
    const config = makeDslConfig({
      text_buffer: { start_threshold_lines: 1, target_lines: 6, refill_threshold_lines: 3 },
    });
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();

    let openingCalls = 0;
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) => {
        openingCalls += 1;
        return dslHandle("opening", async (_signal, onGroup) => {
          onGroup(dslNarration("第一句。"));
          // Truncated: a group is committed, then the request dies without a
          // sentinel (the real generator throws for incomplete-with-prefix).
          throw new Error("DSL 流截断：段结束时没有 @end 哨兵");
        });
      },
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) =>
        dslHandle("continuation", async (_signal, onGroup) => {
          // fix(F) 后 advance-trigger 对失败段跳过低水续写：第一次（也是唯一
          // 一次）续写调用就是带保留前缀的修复。prefetched=[] 分支保留为
          // 回归哨兵（若 advance-trigger 对失败段误触发，杂散续写会先占住
          // 单槽调度器，修复路径的 startActivePath 将抛错）。
          if (request.prefetchedEvents.length === 0) {
            return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
          }
          // Repair continuation seeded with the preserved prefix.
          expect(request.prefetchedEvents).toHaveLength(1);
          onGroup(dslNarration("修复后的续写。"));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
        }),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    const controller = new MemoryController();
    controller.attach(game);
    await game.run();

    expect(openingCalls).toBe(1);
    // 第一句（保留前缀）+ 修复续写句。
    expect(playbackOf(controller.outputs)).toHaveLength(2);
    expect(controller.ended()).toBe(true);
  });
});

describe("DSL mode — visual state", () => {
  it("keeps the rendered state stable until a line with cues plays", async () => {
    const config = makeDslConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        dslHandle("opening", async (_signal, onGroup) => {
          onGroup(dslDialogue("苏遥", "第一句。", { variant: "anxious" }));
          onGroup(dslDialogue("苏遥", "第二句。"));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
        }),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) =>
        dslHandle("continuation", async (_signal) => {
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
        }),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    const controller = new MemoryController();
    controller.attach(game);
    await game.run();

    const playbacks = playbackOf(controller.outputs);
    // Line 1 set anxious; line 2 KEEPs it (no stage cues).
    expect(playbacks[0]!.presentation?.visualState.characters["suyao"]?.variant).toBe("anxious");
    expect(playbacks[1]!.event.type).toBe("dialogue");
    expect(playbacks[1]!.presentation).toBeUndefined();
    expect((playbacks[1]!.event as { stage?: unknown }).stage).toBeUndefined();
  });
});

describe("DSL mode — low-water refill (§73–§76)", () => {
  it("starts the refill while the player is still reading the segment tail (not after drain)", async () => {
    const config = makeDslConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();
    const outputs: RuntimeOutput[] = [];
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    game.subscribe((o) => outputs.push(o));

    // 开场段：2 句旁白后 @end buffer。
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        dslHandle("opening", async (_signal, onGroup) => {
          onGroup(dslNarration("地下室里只亮着终端的一点蓝光。"));
          onGroup(dslNarration("键盘上落了一层灰。"));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
        }),
    );
    // 续写段：记录被调用的时刻（玩家是否已读完开场最后一行）。
    // 第 1 次调用 = 低水位提前续写（buffer，继续播放）；第 2 次调用 = 收尾
    // 续写（ending，终止 run loop，避免无限续写）。
    let continuationStartedWhileReadingTail = false;
    let continuationCalls = 0;
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) =>
        dslHandle("continuation", async (_signal, onGroup) => {
          continuationCalls += 1;
          if (continuationCalls === 1) {
            // 若玩家还没推进到最后一行（还有未消费的 playable），说明续写提前启动了。
            const playback = playbackOf(outputs);
            continuationStartedWhileReadingTail = playback.length < 2;
            onGroup(dslNarration("终端屏幕上浮现出一行字。"));
            return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
          }
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
        }),
    );

    const runPromise = game.run();
    const controller = new MemoryController();
    controller.attach(game);
    await controller.advanceUntilInteractionOrEnd();
    await runPromise;

    expect(generator.generateContinuation).toHaveBeenCalledTimes(2);
    expect(continuationStartedWhileReadingTail).toBe(true);
    // 玩家最终看到了全部 3 句。
    expect(playbackOf(outputs).map((o) => o.event.text)).toEqual([
      "地下室里只亮着终端的一点蓝光。",
      "键盘上落了一层灰。",
      "终端屏幕上浮现出一行字。",
    ]);
  });

  it("does NOT refill while the player has more than refill_threshold lines ahead", async () => {
    const config = makeDslConfig({
      text_buffer: { start_threshold_lines: 1, target_lines: 6, refill_threshold_lines: 3 },
    });
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();
    const outputs: RuntimeOutput[] = [];
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    game.subscribe((o) => outputs.push(o));

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        dslHandle("opening", async (_signal, onGroup) => {
          for (let i = 0; i < 5; i++) onGroup(dslNarration(`第 ${i + 1} 句。`));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
        }),
    );
    // 第 1 次 = 低水位续写（buffer）；第 2 次 = 收尾（ending，终止 run loop）。
    let continuationCalls = 0;
    let playedLinesAtContinuationStart = -1;
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) =>
        dslHandle("continuation", async (_signal, onGroup) => {
          continuationCalls += 1;
          if (continuationCalls === 1) {
            // 续写启动时玩家已播放的行数：GREEN=2（还有 3 句 ahead），
            // RED=5（玩家读空后才由 run loop 启动）。
            playedLinesAtContinuationStart = playbackOf(outputs).length;
            onGroup(dslNarration("续写句。"));
            return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
          }
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
        }),
    );

    // 手动推进（onPlaybackReady 不自动 advance）：逐步观察低水位触发时机。
    const runPromise = game.run();
    const controller = new MemoryController({ onPlaybackReady: () => {} });
    controller.attach(game);

    await controller.advanceUntilPlayed(1); // 第 1 句播放
    expect(continuationCalls).toBe(0);      // ahead=4 > 3 → 未触发
    controller.advance();                    // 放行第 1 句 → 第 2 句播放
    await controller.advanceUntilPlayed(2);
    expect(continuationCalls).toBe(0);      // 尚未推进第 2 句 → 仍未触发
    controller.advance();                    // 推进第 2 句 → ahead=3 ≤ 3 → 触发续写
    await controller.advanceUntilPlayed(3); // 第 3 句播放
    expect(continuationCalls).toBe(1);
    expect(playedLinesAtContinuationStart).toBe(2); // 玩家还剩 3 句时续写已启动

    // 收尾：持续推进直到会话结束（0ms 定时器只用于让微任务链排空）。
    while (!controller.ended()) {
      controller.advance();
      await new Promise((r) => setTimeout(r, 0));
    }
    await runPromise;

    expect(playbackOf(outputs).map((o) => o.event.text)).toEqual([
      "第 1 句。",
      "第 2 句。",
      "第 3 句。",
      "第 4 句。",
      "第 5 句。",
      "续写句。",
    ]);
  });

  it("waits for start_threshold_lines before playing the first line", async () => {
    const config = makeDslConfig({
      text_buffer: { start_threshold_lines: 2, target_lines: 6, refill_threshold_lines: 3 },
    });
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();
    const outputs: RuntimeOutput[] = [];
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    game.subscribe((o) => outputs.push(o));

    let resolveFirstLine!: () => void;
    const firstLineGate = new Promise<void>((r) => { resolveFirstLine = r; });
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        dslHandle("opening", async (_signal, onGroup) => {
          onGroup(dslNarration("第一句。"));
          await firstLineGate; // 第二句延迟到达
          onGroup(dslNarration("第二句。"));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
        }),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) =>
        dslHandle("continuation", async (_signal, onGroup) => {
          // 第 1 次 = 低水位续写（buffer）；第 2 次 = 收尾（ending，终止 run loop）。
          const calls = (generator.generateContinuation as ReturnType<typeof vi.fn>).mock.calls.length;
          if (calls === 1) {
            onGroup(dslNarration("续写句。"));
            return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
          }
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
        }),
    );

    const runPromise = game.run();
    const controller = new MemoryController();
    controller.attach(game);
    await new Promise((r) => setTimeout(r, 30));
    // 只有一句就绪 → 不应出现第一句的 playback_ready。
    expect(playbackOf(outputs)).toHaveLength(0);
    resolveFirstLine();
    await controller.advanceUntilInteractionOrEnd();
    await runPromise;

    expect(playbackOf(outputs).map((o) => o.event.text)).toEqual([
      "第一句。",
      "第二句。",
      "续写句。",
    ]);
  });

  it("does not start a low-water refill on a failed segment; the repair owns the scheduler", async () => {
    // 生产默认阈值（start_threshold_lines 2 / refill_threshold_lines 3）。
    // 开场段只产出 1 句就失败（mock 抛错、无 @end）：
    //  - 首句门槛必须放行（段 done 已 settled，不论成败）；
    //  - 玩家推进后不得启动杂散低水续写——修复路径即将接管单槽调度器，
    //    续写会与修复竞争（startActivePath 抛错，run() 死亡）并浪费一次生成。
    const config = makeDslConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();
    const outputs: RuntimeOutput[] = [];
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    game.subscribe((o) => outputs.push(o));

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        dslHandle("opening", async (_signal, onGroup) => {
          onGroup(dslNarration("第一句。"));
          // 截断：产出 1 句后请求失败（无 @end 哨兵），endStatus 恒空。
          throw new Error("DSL 流截断：段结束时没有 @end 哨兵");
        }),
    );
    // 修复前不得出现无 repairReason 的杂散续写：若出现，记录并挂起
    // （模拟真实 LLM 长请求，使修复路径的 startActivePath 必然抛错）。
    let spuriousRefill = false;
    let continuationCalls = 0;
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) =>
        dslHandle("continuation", async (_signal, onGroup) => {
          continuationCalls += 1;
          if (request.repairReason === undefined) {
            if (continuationCalls === 1) {
              spuriousRefill = true;
              await new Promise<never>(() => {}); // 永不 resolve（gated）
            }
            // 修复后的正常低水续写：buffer 段收尾后由 run loop 启动 → ending。
            return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
          }
          // 修复续写：带保留前缀，产出 2 句后 @end buffer（正常段边界）。
          onGroup(dslNarration("修复第一句。"));
          onGroup(dslNarration("修复第二句。"));
          return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
        }),
    );

    const runPromise = game.run();
    const controller = new MemoryController();
    controller.attach(game);
    await controller.advanceUntilInteractionOrEnd();
    await runPromise;

    // 修复前没有杂散续写：第一次续写调用就是带 repairReason 的修复。
    expect(spuriousRefill).toBe(false);
    expect(continuationCalls).toBe(2);
    const firstContinuationCall = (generator.generateContinuation as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((firstContinuationCall[0] as ContinuationRequest).repairReason).toBeDefined();
    // 保留前缀 + 修复续写句全部播放，故事正常结束。
    expect(playbackOf(outputs).map((o) => o.event.text)).toEqual([
      "第一句。",
      "修复第一句。",
      "修复第二句。",
    ]);
    expect(controller.ended()).toBe(true);
  });
});
