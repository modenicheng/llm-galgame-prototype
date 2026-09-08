/**
 * 校园开放叙事会话级集成测试（无外部 API，fake DSL generator 驱动）。
 *
 * 验证 spec §9.7 第一版验收标准的运行时部分：
 * 1. 每局能从一条叙事种子开始（initialStoryState → 开场上下文）；
 * 2. 简单事件可以自然短局结束，复杂事件可以多轮继续（运行时接受两种长度）；
 * 3. 自由输入（input/hybrid）路径可用；
 * 4. 同一种子允许不同的玩家路径（不同选择产生不同续写上下文）；
 * 5. 结局由模型以 @end ending 自然收束，不依赖预设结局枚举。
 */
import { describe, it, expect, vi } from "vitest";
import type { StoryGeneratorPort } from "../core/ports/story-generator-port.js";
import { createGenerationHandle } from "../core/ports/story-generator-port.js";
import type {
  GenerationHandle,
  OpeningRequest,
  ContinuationRequest,
  InputResponseRequest,
} from "../core/ports/story-generator-port.js";
import type { EventGroupDraft, DslInteractionDraft, SegmentEndReason } from "../core/protocol/gal-dsl/types.js";
import { Game } from "../game.js";
import type { MediaPlannerPort } from "../core/ports/media-planner-port.js";
import { RuntimeStatus } from "../status.js";
import {
  makeTestConfig,
  makeTestPorts,
  MemoryController,
} from "../test-helpers.js";
import { createInitialState } from "../story/state.js";
import type { StoryState } from "../story/types.js";
import type { RuntimeOutput } from "../core/runtime/runtime-output.js";
import type { AssetCatalog } from "../core/assets/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG: AssetCatalog = {
  guidance: "校园素材。",
  backgrounds: {
    clubroom_day: { id: "clubroom_day", src: "backgrounds/clubroom_day.jpg", description: "社团活动室" },
  },
  bgm: {},
  soundEffects: {},
  spriteSets: {
    raspberry: {
      id: "raspberry",
      variants: { default: { id: "default", src: "characters/raspberry/placeholder.png" } },
    },
  },
  characters: {
    raspberry: {
      characterId: "raspberry",
      scriptName: "树莓娘",
      displayName: "树莓娘",
      spriteSet: "raspberry",
      defaultVariant: "default",
      defaultPosition: "center",
      allowedSpriteSets: ["raspberry"],
    },
  },
};

/** 种子初始状态（与 src/campus/scenario-seeds.ts 的产物同构）。 */
function seededState(): StoryState {
  return createInitialState({
    scene: {
      id: "old-device-before-opening",
      location: "校园技术社团（网络开拓者协会）",
      purpose: "技术分享会开始前，一台没人记得启动过的旧设备仍在运行。",
    },
    canon: { scenario_seed: "old-device-before-opening" },
    open_threads: [
      { id: "seed-situation", summary: "开场前仍在运行的旧设备", status: "new", last_touched_turn: 0 },
    ],
    recent_summary: "本局从叙事种子开始：开场前仍在运行的旧设备。",
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

function makeMockGenerator(): StoryGeneratorPort {
  return {
    generateOpening: vi.fn(),
    generateBranchPrefetch: vi.fn(),
    generateInputResponse: vi.fn(),
    generateInputBridge: vi.fn(),
    generateContinuation: vi.fn(),
  } as unknown as StoryGeneratorPort;
}

function handle(
  id: string,
  run: (signal: AbortSignal, onGroup: (group: EventGroupDraft) => void) => Promise<unknown>,
): GenerationHandle {
  return createGenerationHandle(id, run as never);
}

function narration(text: string): EventGroupDraft {
  return { prelude: [], main: { type: "narration", text } };
}

function dialogue(text: string): EventGroupDraft {
  return {
    prelude: [],
    main: { type: "dialogue", speaker: "树莓娘", text, visual: { hasVisual: false, resetVisual: false }, name: { hasName: false, resetName: false } },
  };
}

function interaction(draft: DslInteractionDraft): EventGroupDraft {
  return { prelude: [], main: { type: "interaction", interaction: draft } };
}

function endStatus(reason: SegmentEndReason): { kind: "complete"; nonce: string; reason: SegmentEndReason } {
  return { kind: "complete", nonce: "beef", reason };
}

function playbacksOf(outputs: RuntimeOutput[]) {
  return outputs.filter(
    (o): o is RuntimeOutput & { type: "playback_ready" } => o.type === "playback_ready",
  );
}

function interactionsOf(outputs: RuntimeOutput[]) {
  return outputs.filter((o): o is Extract<RuntimeOutput, { type: "interaction_opened" }> => o.type === "interaction_opened");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("campus open-narrative session", () => {
  it("short story: seeded opening → hybrid free-input → natural ending", async () => {
    const config = makeTestConfig();
    const generator = makeMockGenerator();

    generator.generateOpening = vi.fn((request: OpeningRequest) =>
      handle("opening", async (_signal, onGroup) => {
        // 种子状态必须先于开场生成到达（spec §9.7-1）。
        expect(request.state.canon.scenario_seed).toBe("old-device-before-opening");
        onGroup(dialogue("这台设备一直在运行，我也不敢乱动。"));
        onGroup(interaction({
          prompt: "这台旧设备怎么处理？",
          optionTexts: ["先别动，查登记信息", "直接关机"],
          inputPlaceholder: "或者说说你的想法……",
          mode: "hybrid",
        }));
        return { events: [], state_patch: {}, groups: [], segmentEnd: endStatus("interaction") };
      }),
    );
    generator.generateInputBridge = vi.fn(() => handle("bridge", async () => ({
      events: [], state_patch: {}, groups: [],
    })));
    generator.generateInputResponse = vi.fn((_request: InputResponseRequest) =>
      handle("input", async (_signal, onGroup) => {
        onGroup(dialogue("好主意，先查登记再决定。"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: endStatus("buffer") };
      }),
    );
    generator.generateContinuation = vi.fn(() =>
      handle("continuation", async (_signal, onGroup) => {
        onGroup(narration("设备留到了分享会结束，一切正常。"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: endStatus("ending") };
      }),
    );

    const game = new Game(
      config,
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts({ initialStoryState: seededState() }),
      CATALOG,
    );
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.submitInput(output.interactionId, "先查登记信息，别急着关机");
      },
    });
    controller.attach(game);
    await game.run();

    // 自由输入路径 + 自然结局；没有固定轮数协议。
    expect(controller.ended()).toBe(true);
    expect(generator.generateInputResponse).toHaveBeenCalledTimes(1);
    expect(generator.generateContinuation).toHaveBeenCalledTimes(1);
    expect(playbacksOf(controller.outputs).length).toBeGreaterThanOrEqual(3);
  });

  it("multi-round story: the same seed can span several interactions before ending", async () => {
    const config = makeTestConfig();
    const generator = makeMockGenerator();

    let interactionIndex = 0;
    generator.generateOpening = vi.fn(() =>
      handle("opening", async (_signal, onGroup) => {
        onGroup(dialogue("分享会快开始了，投影还是没画面。"));
        onGroup(interaction({
          prompt: "先做什么？",
          optionTexts: ["检查视频线", "换备用设备"],
          mode: "choice",
        }));
        return { events: [], state_patch: {}, groups: [], segmentEnd: endStatus("interaction") };
      }),
    );
    generator.generateBranchPrefetch = vi.fn(() =>
      handle("branch", async (_signal, onGroup) => {
        onGroup(dialogue("按你说的做了。"));
        return { events: [], state_patch: {}, groups: [] };
      }),
    );
    // 每次续写：前两轮继续打开新的交互表单，第三轮自然收束结局。
    generator.generateContinuation = vi.fn(() =>
      handle("continuation", async (_signal, onGroup) => {
        interactionIndex += 1;
        if (interactionIndex < 3) {
          onGroup(dialogue(`又发现了一个新线索（第 ${interactionIndex} 轮）。`));
          onGroup(interaction({
            prompt: `第 ${interactionIndex + 1} 步做什么？`,
            optionTexts: ["继续排查", "先稳住现场"],
            mode: "choice",
          }));
          return { events: [], state_patch: {}, groups: [], segmentEnd: endStatus("interaction") };
        }
        onGroup(narration("问题终于落地，树莓娘记完了值班日志。"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: endStatus("ending") };
      }),
    );

    const game = new Game(
      config,
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts({ initialStoryState: seededState() }),
      CATALOG,
    );
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.select(output.interactionId, `${output.interactionId}_opt_0`);
      },
    });
    controller.attach(game);
    await game.run();

    // 运行时接受多轮展开：3 个交互点后自然结束，无强制轮数。
    expect(controller.ended()).toBe(true);
    expect(interactionsOf(controller.outputs)).toHaveLength(3);
    expect(generator.generateContinuation).toHaveBeenCalledTimes(3);
  });

  it("same seed, different paths: different choices lead to different continuation contexts", async () => {
    const config = makeTestConfig();

    async function runWithChoice(optionIndex: number): Promise<string[]> {
      const generator = makeMockGenerator();
      generator.generateOpening = vi.fn(() =>
        handle("opening", async (_signal, onGroup) => {
          onGroup(dialogue("链接被转发出去了，文件可能不该公开。"));
          onGroup(interaction({
            prompt: "怎么处理？",
            optionTexts: ["先断开共享", "先联系所有者确认"],
            mode: "choice",
          }));
          return { events: [], state_patch: {}, groups: [], segmentEnd: endStatus("interaction") };
        }),
      );
      generator.generateBranchPrefetch = vi.fn(() =>
        handle("branch", async (_signal, onGroup) => {
          onGroup(dialogue("照你说的做了。"));
          return { events: [], state_patch: {}, groups: [] };
        }),
      );
      const continuationHistories: string[][] = [];
      generator.generateContinuation = vi.fn((request: ContinuationRequest) => {
        continuationHistories.push(request.history.map((event) => JSON.stringify(event)));
        return handle("continuation", async (_signal, onGroup) => {
          onGroup(narration("事情告一段落。"));
          return { events: [], state_patch: {}, groups: [], segmentEnd: endStatus("ending") };
        });
      });

      const game = new Game(
        config,
        generator,
        makeMockStatus(),
        makeMockMedia(),
        undefined,
        makeTestPorts({ initialStoryState: seededState() }),
        CATALOG,
      );
      const controller = new MemoryController({
        onInteractionOpened: (output) => {
          controller.select(output.interactionId, `${output.interactionId}_opt_${optionIndex}`);
        },
      });
      controller.attach(game);
      await game.run();
      expect(controller.ended()).toBe(true);
      return continuationHistories.flat();
    }

    const pathA = await runWithChoice(0);
    const pathB = await runWithChoice(1);

    // 同一种子、不同玩家选择 → 续写看到的已确认事实不同。
    expect(pathA).not.toEqual(pathB);
    const joinedA = pathA.join("\n");
    const joinedB = pathB.join("\n");
    expect(joinedA).toContain("先断开共享");
    expect(joinedB).toContain("先联系所有者确认");
  });
});
