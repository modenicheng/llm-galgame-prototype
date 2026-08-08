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
import type { StoryGenerator } from "./adapters/llm/openai-compatible-generator.js";
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
    },
  },
};

function makeDslConfig(overrides: Parameters<typeof makeTestConfig>[0] = {}): AppConfig {
  return makeTestConfig({
    generation: { protocol: "dsl" },
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

function makeDslMockGenerator(): StoryGenerator {
  return {
    generateOpening: vi.fn(),
    generateBranchPrefetch: vi.fn(),
    generateInputResponse: vi.fn(),
    generateInputBridge: vi.fn(),
    generateContinuation: vi.fn(),
  } as unknown as StoryGenerator;
}

type StreamOptions = {
  onGroup?: (group: EventGroupDraft) => void;
  onSegmentEnd?: (status: SegmentEndStatus) => void;
};

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
    const config = makeDslConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      async (_turn: number, _state: unknown, _signal: unknown, options?: StreamOptions) => {
        options?.onGroup?.(dslNarration("地下室里只亮着终端的一点蓝光。", [
          { type: "background", assetId: "basement" },
        ]));
        options?.onGroup?.(dslDialogue("苏遥", "你不该来这里。", {
          displayName: "神秘女子",
          variant: "normal",
          position: "left",
        }));
        options?.onSegmentEnd?.(complete("buffer"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
      },
    );
    // Buffer end → refill continuation → ending.
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      async (_turn: number, _state: unknown, history: unknown, prefetched: unknown, _signal: unknown, options?: StreamOptions) => {
        expect(prefetched).toEqual([]);
        expect(history).toHaveLength(2); // the two committed events
        options?.onGroup?.(dslNarration("故事结束。"));
        options?.onSegmentEnd?.(complete("ending"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
      },
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
      async (_t: number, _s: unknown, _sig: unknown, options?: StreamOptions) => {
        options?.onGroup?.(dslDialogue("苏遥", "再见了。"));
        options?.onSegmentEnd?.(complete("ending"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
      },
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
      async (_t: number, _s: unknown, _sig: unknown, options?: StreamOptions) => {
        options?.onGroup?.(dslDialogue("苏遥", "别碰那台机器。"));
        options?.onGroup?.(dslInteraction(
          {
            prompt: "怎么回应？",
            optionTexts: ["追问她", "暂时停手"],
            inputPlaceholder: "或输入自己的回答……",
            mode: "hybrid",
          },
          [{ type: "bgm", assetId: "mystery" }],
        ));
        options?.onSegmentEnd?.(complete("interaction"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("interaction") };
      },
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      events: [],
      state_patch: {},
      groups: [dslDialogue("苏遥", "分支内容。")],
    });
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockResolvedValue({
      events: [],
      state_patch: {},
      groups: [dslNarration("她沉默了一会儿。")],
    });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: number, _s: unknown, _h: unknown, _p: unknown, _sig: unknown, options?: StreamOptions) => {
        options?.onSegmentEnd?.(complete("ending"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
      },
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
      async (_t: number, _s: unknown, _sig: unknown, options?: StreamOptions) => {
        options?.onGroup?.(dslInteraction({
          prompt: "你准备对她说什么？",
          optionTexts: [],
          inputPlaceholder: "输入你的回答……",
          mode: "input",
        }));
        options?.onSegmentEnd?.(complete("interaction"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("interaction") };
      },
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockResolvedValue({
      events: [],
      state_patch: {},
      groups: [dslNarration("房间里安静下来。")],
    });
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue({
      events: [],
      state_patch: {},
      groups: [dslDialogue("苏遥", "你明明知道它还在运行。")],
    });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: number, _s: unknown, _h: unknown, _p: unknown, _sig: unknown, options?: StreamOptions) => {
        options?.onSegmentEnd?.(complete("ending"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
      },
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
      async (_t: number, _s: unknown, _sig: unknown, options?: StreamOptions) => {
        options?.onGroup?.(dslInteraction({
          prompt: "怎么回应？",
          optionTexts: ["追问她", "暂时停手"],
          inputPlaceholder: "或输入……",
          mode: "hybrid",
        }));
        options?.onSegmentEnd?.(complete("interaction"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("interaction") };
      },
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      events: [],
      state_patch: {},
      groups: [dslDialogue("苏遥", "分支内容。")],
    });
    // The cancel flow starts (then aborts) an input response generation.
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue({
      events: [],
      state_patch: {},
      groups: [],
    });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: number, _s: unknown, _h: unknown, _p: unknown, _sig: unknown, options?: StreamOptions) => {
        options?.onSegmentEnd?.(complete("ending"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
      },
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
    const config = makeDslConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();
    const generator = makeDslMockGenerator();

    let openingCalls = 0;
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: number, _s: unknown, _sig: unknown, options?: StreamOptions) => {
        openingCalls += 1;
        options?.onGroup?.(dslNarration("第一句。"));
        // Truncated: a group is committed, then the request dies without a
        // sentinel (the real generator throws for incomplete-with-prefix).
        throw new Error("DSL 流截断：段结束时没有 @end 哨兵");
      },
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: number, _s: unknown, _history: unknown, prefetched: unknown, _sig: unknown, options?: StreamOptions) => {
        // Repair continuation seeded with the preserved prefix.
        expect(prefetched).toHaveLength(1);
        options?.onGroup?.(dslNarration("修复后的续写。"));
        options?.onSegmentEnd?.(complete("ending"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
      },
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
      async (_t: number, _s: unknown, _sig: unknown, options?: StreamOptions) => {
        options?.onGroup?.(dslDialogue("苏遥", "第一句。", { variant: "anxious" }));
        options?.onGroup?.(dslDialogue("苏遥", "第二句。"));
        options?.onSegmentEnd?.(complete("buffer"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("buffer") };
      },
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: number, _s: unknown, _h: unknown, _p: unknown, _sig: unknown, options?: StreamOptions) => {
        options?.onSegmentEnd?.(complete("ending"));
        return { events: [], state_patch: {}, groups: [], segmentEnd: complete("ending") };
      },
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
