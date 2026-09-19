/**
 * C5 §5.1 快照测试（main 线）：每一种生成任务变体的请求都显式携带
 * {protocolVersion, rosterRevision, cast, characterState}——不只主 writer。
 *
 * 变体覆盖：opening / continuation（低水续写）/ input_response /
 * input_bridge / branch prefetch / fixed-prefix（修复续写的保留前缀）/
 * recovery（修复续写 repairReason）。图回溯（retrace）不携带预取分支的
 * 预测副本——分支隔离断言在 prefetch 用例内钉死。
 *
 * 断言只钉「请求快照形状」：身份四件套来自会话 config 与 Game 注入的
 * C2 registry（roster revision / cast / 名牌状态副本）；不驱动真实 LLM。
 */
import { describe, it, expect, vi } from "vitest";
import { Game } from "./game.js";
import type { GamePorts } from "./game.js";
import { RuntimeStatus } from "./runtime/status.js";
import { createGenerationHandle } from "./core/ports/story-generator-port.js";
import type { GenerationEnvelope } from "./story/types.js";
import type {
  BranchPrefetchRequest,
  ContinuationRequest,
  GenerationHandle,
  GenerationIdentity,
  InputBridgeRequest,
  InputResponseRequest,
  OpeningRequest,
  StoryGeneratorPort,
} from "./core/ports/story-generator-port.js";
import type { EventGroupDraft } from "./core/protocol/gal-dsl/types.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import { makeTestConfig, makeTestPorts, MemoryController } from "./test-helpers.js";
import {
  buildCharacterRoster,
  createCharacterRegistry,
} from "./core/characters/registry.js";
import type { CharacterRegistry } from "./core/characters/types.js";
import type { AssetCatalog } from "./core/assets/types.js";
import type { AppConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSETS: AssetCatalog = {
  guidance: "",
  backgrounds: {},
  bgm: {},
  soundEffects: {},
  spriteSets: {},
};

function snapshotRegistry(): CharacterRegistry {
  return createCharacterRegistry(
    buildCharacterRoster({
      schemaVersion: 2,
      scopeId: "c5-snapshot-main",
      playerId: "player_one",
      characters: [
        { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
        { id: "suyao", name: "苏遥", control: "npc", initialLabel: "苏遥", persona: "同班同学。" },
        { id: "linche", name: "林澈", control: "npc", initialLabel: "林澈", persona: "同屋。" },
      ],
    }),
    ASSETS,
  );
}

function makeGameConfig(overrides?: Parameters<typeof makeTestConfig>[0]): AppConfig {
  return makeTestConfig({
    // 低水位续写在本测试显式启用（refill 高阈值 → buffer 收束即续写）。
    text_buffer: { start_threshold_lines: 1, target_lines: 6, refill_threshold_lines: 99 },
    ...overrides,
  });
}

type EnvelopeDraft =
  | { type: "narration"; text: string }
  | {
      type: "interaction";
      interaction_id: string;
      prompt: string;
      mode: "choice" | "input";
    };

function groupFromEvent(draft: EnvelopeDraft): EventGroupDraft {
  if (draft.type === "narration") {
    return { prelude: [], main: { type: "narration", text: draft.text } };
  }
  if (draft.mode === "choice") {
    // 组主事件用 DSL 交互草稿形状（optionTexts；运行时再生成选项 id）。
    return {
      prelude: [],
      main: {
        type: "interaction",
        interaction: { mode: "choice", prompt: draft.prompt, optionTexts: ["选项A", "选项B"] },
      },
    };
  }
  return {
    prelude: [],
    main: {
      type: "interaction",
      interaction: { mode: "input", prompt: draft.prompt, optionTexts: [], inputPlaceholder: "" },
    },
  };
}

function envelopeFor(
  drafts: readonly EnvelopeDraft[],
  reason: "buffer" | "ending" | "interaction",
): GenerationEnvelope {
  return {
    events: [],
    groups: [],
    segmentEnd: { kind: "complete", nonce: "0000", reason },
  };
}

function handleFromDrafts(
  id: string,
  drafts: readonly EnvelopeDraft[],
  reason: "buffer" | "ending" | "interaction",
): GenerationHandle {
  return createGenerationHandle(id, async (_signal, onGroup) => {
    for (const draft of drafts) {
      if (draft.type === "interaction") continue;
      onGroup(groupFromEvent(draft));
    }
    return envelopeFor(drafts, reason);
  });
}

/** 失败段：先流出 narration 组，然后 done 拒绝（触发修复续写）。 */
function failingHandle(id: string, narrationCount: number): GenerationHandle {
  return createGenerationHandle(id, async (_signal, onGroup) => {
    for (let i = 0; i < narrationCount; i += 1) {
      onGroup(groupFromEvent({ type: "narration", text: `第${i + 1}句旁白。` }));
    }
    throw new Error("DSL 流在结尾处断裂（输出被截断）。");
  });
}

interface CapturedRequest<K extends string, T> {
  kind: K;
  request: T;
}

function makeCapturingGenerator(): {
  port: StoryGeneratorPort;
  openings: CapturedRequest<"opening", OpeningRequest>[];
  continuations: CapturedRequest<"continuation", ContinuationRequest>[];
  prefetches: CapturedRequest<"prefetch", BranchPrefetchRequest>[];
  inputResponses: CapturedRequest<"input_response", InputResponseRequest>[];
  inputBridges: CapturedRequest<"input_bridge", InputBridgeRequest>[];
} {
  const openings: CapturedRequest<"opening", OpeningRequest>[] = [];
  const continuations: CapturedRequest<"continuation", ContinuationRequest>[] = [];
  const prefetches: CapturedRequest<"prefetch", BranchPrefetchRequest>[] = [];
  const inputResponses: CapturedRequest<"input_response", InputResponseRequest>[] = [];
  const inputBridges: CapturedRequest<"input_bridge", InputBridgeRequest>[] = [];

  const port: StoryGeneratorPort = {
    generateOpening(request) {
      openings.push({ kind: "opening", request });
      return handleFromDrafts("opening", [{ type: "narration", text: "开场旁白。" }], "buffer");
    },
    generateContinuation(request) {
      continuations.push({ kind: "continuation", request });
      return handleFromDrafts(`continuation:${request.turn}`, [{ type: "narration", text: "续写旁白。" }], "ending");
    },
    generateBranchPrefetch(request) {
      prefetches.push({ kind: "prefetch", request });
      return handleFromDrafts(`branch:${request.option.id}`, [{ type: "narration", text: "分支旁白。" }], "ending");
    },
    generateInputResponse(request) {
      inputResponses.push({ kind: "input_response", request });
      return handleFromDrafts(`input:${request.interaction.interaction_id}`, [{ type: "narration", text: "回应旁白。" }], "ending");
    },
    generateInputBridge(request) {
      inputBridges.push({ kind: "input_bridge", request });
      return handleFromDrafts(`bridge:${request.interaction.interaction_id}`, [{ type: "narration", text: "过渡旁白。" }], "buffer");
    },
  };
  return { port, openings, continuations, prefetches, inputResponses, inputBridges };
}

const mockMedia: MediaPlannerPort = {
  registerActive: vi.fn(),
  registerCandidate: vi.fn(),
  activateCandidate: vi.fn(),
  discardCandidate: vi.fn(),
  isReady: vi.fn().mockReturnValue(true),
  waitUntilReady: vi.fn().mockResolvedValue(undefined),
  markPresented: vi.fn(),
} as unknown as MediaPlannerPort;

function makeGame(
  port: StoryGeneratorPort,
  ports: Partial<GamePorts> = {},
  config = makeGameConfig(),
): Game {
  const fullPorts: GamePorts = { ...makeTestPorts(), ...ports };
  return new Game(config, port, new RuntimeStatus(), mockMedia, undefined, fullPorts);
}

/** 身份四件套断言（§5.1：所有生成请求显式携带）。 */
function expectIdentityShape(
  identity: GenerationIdentity,
  registry: CharacterRegistry,
): void {
  expect(identity.protocolVersion).toBe(1); // 直连构造缺 dsl 块 → Game 兜底 v1（zod 缺省已是 2，Ruling 15）
  expect(identity.rosterRevision).toBe(registry.roster.revision);
  expect(identity.cast.allowedSpeakerIds).toEqual(["suyao", "linche"]); // 玩家不可由模型代言
  expect(identity.cast.sceneParticipantIds).toContain("player_one");
  expect(identity.characterState).toBeDefined();
  expect(identity.characterState.labels).toBeDefined();
}

// ---------------------------------------------------------------------------
// 每任务变体的请求快照
// ---------------------------------------------------------------------------

describe("C5 generation identity — per-task-variant request snapshots (main)", () => {
  it("opening 与低水续写 continuation 都显式携带身份四件套", async () => {
    const registry = snapshotRegistry();
    const gen = makeCapturingGenerator();
    // opening 以 buffer 收束 + refill 高阈值 → run loop 立即启动续写；
    // 续写以 ending 收束 → run 结束。
    const game = makeGame(gen.port, { characterRegistry: registry });
    const controller = new MemoryController({});
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(gen.openings).toHaveLength(1);
    expectIdentityShape(gen.openings[0]!.request.identity, registry);
    expect(gen.continuations.length).toBeGreaterThanOrEqual(1);
    for (const captured of gen.continuations) {
      expectIdentityShape(captured.request.identity, registry);
    }
  });

  it("branch prefetch：每个分支独立身份（characterState 为副本，不是共享引用）", async () => {
    const registry = snapshotRegistry();
    const gen = makeCapturingGenerator();
    const port: StoryGeneratorPort = {
      ...gen.port,
      generateOpening(request) {
        gen.openings.push({ kind: "opening", request });
        return createGenerationHandle("opening", async (_signal, onGroup) => {
          onGroup(
            groupFromEvent({
              type: "interaction",
              interaction_id: "itx_choice",
              prompt: "怎么走？",
              mode: "choice",
            }),
          );
          return envelopeFor([], "interaction");
        });
      },
    };
    const game = makeGame(port, { characterRegistry: registry });
    const controller = new MemoryController({
      onInteractionOpened: (output, ctrl) => {
        // choice 终端的 interaction 是运行时 ChoiceEvent（无 mode 字段，
        // 有 options）；input 终端才是 InteractionEvent。
        const interaction = output.interaction as { options?: Array<{ id: string }> };
        const option = interaction.options?.[0];
        if (option !== undefined) {
          ctrl.dispatch({
            type: "select_choice",
            interactionId: output.interactionId,
            optionId: option.id,
          });
        }
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(gen.prefetches.length).toBeGreaterThanOrEqual(1);
    const seenStates: object[] = [];
    for (const captured of gen.prefetches) {
      expectIdentityShape(captured.request.identity, registry);
      seenStates.push(captured.request.identity.characterState);
    }
    // 预取分支之间的名牌状态是各自的副本（§5.1：绑定 registry revision
    // 的分支副本；取消/未选/回溯即丢弃，不共享可变引用）。
    for (let i = 1; i < seenStates.length; i += 1) {
      expect(seenStates[i]).not.toBe(seenStates[0]);
    }
  });

  it("input_bridge 与 input_response 请求快照（自由输入两段式）", async () => {
    const registry = snapshotRegistry();
    const gen = makeCapturingGenerator();
    const port: StoryGeneratorPort = {
      ...gen.port,
      generateOpening(request) {
        gen.openings.push({ kind: "opening", request });
        return createGenerationHandle("opening", async (_signal, onGroup) => {
          onGroup(
            groupFromEvent({
              type: "interaction",
              interaction_id: "itx_input",
              prompt: "你想说什么？",
              mode: "input",
            }),
          );
          return envelopeFor([], "interaction");
        });
      },
    };
    const game = makeGame(port, { characterRegistry: registry });
    const controller = new MemoryController({
      onInteractionOpened: (output, ctrl) => {
        const interaction = output.interaction as { mode?: string };
        if (interaction.mode === "input") {
          ctrl.submitInput(output.interactionId, "我推开门。");
        }
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(gen.inputBridges.length).toBeGreaterThanOrEqual(1);
    for (const captured of gen.inputBridges) {
      expectIdentityShape(captured.request.identity, registry);
    }
    expect(gen.inputResponses.length).toBeGreaterThanOrEqual(1);
    for (const captured of gen.inputResponses) {
      expectIdentityShape(captured.request.identity, registry);
    }
  });

  it("recovery（修复续写）与 fixed-prefix：保留前缀随修复请求下发", async () => {
    const registry = snapshotRegistry();
    const gen = makeCapturingGenerator();
    const port: StoryGeneratorPort = {
      ...gen.port,
      generateOpening(request) {
        gen.openings.push({ kind: "opening", request });
        // 3 句旁白后断裂（有可播前缀 → 修复续写而非致命失败）。
        return failingHandle("opening", 3);
      },
    };
    const game = makeGame(port, { characterRegistry: registry });
    const controller = new MemoryController({});
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const repair = gen.continuations.find(
      (captured) => captured.request.repairReason !== undefined,
    );
    expect(repair).toBeDefined();
    if (repair === undefined) return;
    expectIdentityShape(repair.request.identity, registry);
    // 固定前缀：失败段的保留事件作为 prefetchedEvents 随修复续写下发。
    expect(repair.request.prefetchedEvents.length).toBeGreaterThan(0);
  });
});
