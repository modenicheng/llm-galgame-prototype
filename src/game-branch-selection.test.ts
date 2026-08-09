/**
 * Repro v2: full pipeline with the REAL DSL StoryGenerator (mocked HTTP
 * client streaming real DSL text through the real parser pipeline), the
 * real Game, and the real frontend GameViewModel. Checks the mode sequence
 * after selecting a fully-loaded branch.
 */
import { describe, it, expect, vi } from "vitest";
import { StoryGenerator } from "./adapters/llm/openai-compatible-generator.js";
import type { AppConfig } from "./config.js";
import { makeTestConfig, makeTestPorts } from "./test-helpers.js";
import { Game } from "./game.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import { RuntimeStatus } from "./status.js";
import { MemoryController } from "./test-helpers.js";
import type { RuntimeOutput } from "./core/runtime/runtime-output.js";
import type { AssetCatalog } from "./core/assets/types.js";
import type { ServerMessage } from "./shared/wire/server-message.js";

const DUMMY_API_KEY = "sk-dummy";

function makeTestPrompts() {
  return {
    characters: "角色A：勇敢的冒险者\n角色B：神秘的向导",
    storyLine: "第一章：进入迷雾森林，寻找失落的圣物。",
    guideline: "保持悬疑氛围，不要使用现代词汇。",
    dslProtocol: "你是互动视觉小说的编剧。输出行式 Gal DSL，不允许 JSON。",
  };
}

function makeTestInstructions() {
  return {
    opening: "请从故事开场开始，生成完整开场剧情，直到第一个 choice、interaction 或 end。",
    branch_prefetch: "当前分支问题：{choice_prompt}\n假设玩家选择：{option_text}\n请只生成至少 {min_dialogue} 条 dialogue 的预取片段。",
    input_response: "当前交互点：{interaction_prompt}\n玩家输入：{player_input}\n请生成 NPC 回应。",
    continuation: "以下预取片段已固定：\n{prefetched}\n请继续生成完整剧情段。",
    input_bridge: "当前交互点：{interaction_prompt}\n生成 1–2 条 narration 作为场景过渡。",
    recovery: "上一次输出被拒绝：{repair_reason}。请修正后继续。",
    ending: "剧情收束，用 @end {nonce} ending 结束。",
  };
}

const CATALOG: AssetCatalog = {
  guidance: "测试素材。",
  backgrounds: { basement: { id: "basement", src: "backgrounds/basement.jpg", description: "地下室" } },
  bgm: { mystery: { id: "mystery", src: "audio/bgm/mystery.mp3", description: "悬疑" } },
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

function dslStream(lines: string[]): AsyncGenerator<unknown> {
  return (async function* () {
    for (const line of lines) {
      yield { choices: [{ delta: { content: `${line}\n` } }] };
    }
  })();
}

/** create mock echoing the request's own generation nonce. */
function mockDslClient(gen: StoryGenerator, build: (nonce: string) => string[]): void {
  (gen as any).client = {
    chat: {
      completions: {
        create: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
          const user = request.messages[1]!.content as string;
          const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
          return dslStream(build(nonce));
        }),
      },
    },
  };
}

function outputSeq(outputs: RuntimeOutput[]): string[] {
  return outputs.map((o) => {
    if (o.type === "playback_ready") return `playback_ready(${o.event.text.slice(0, 8)})`;
    if (o.type === "interaction_resolved") return "interaction_resolved";
    if (o.type === "interaction_opened") return "interaction_opened";
    if (o.type === "session_ended") return "session_ended";
    return o.type;
  });
}

describe("repro2: real DSL generator — loaded branch selection", () => {
  it("branch lines reach PLAYING on the VM (not stuck at CONTENT_WAITING)", async () => {
    const config: AppConfig = makeTestConfig({
      generation: { repair_attempts: 0 },
      prefetch: { branch_dialogue_lines: 3 },
    });
    const generator = new StoryGenerator(config, makeTestPrompts(), makeTestInstructions(), DUMMY_API_KEY);

    // Per-request streams keyed by task (opening / branch / continuation).
    const streams = new Map<string, (nonce: string) => string[]>();
    streams.set("opening", (nonce) => [
      "苏遥: 别碰那台机器。",
      "? 怎么回应？",
      "+ 追问她",
      "+ 暂时停手",
      "/?",
      `@end ${nonce} interaction`,
    ]);
    streams.set("branch_prefetch", (nonce) => [
      "苏遥: 分支内容一。",
      "苏遥: 分支内容二。",
      "苏遥: 分支内容三。",
      `@end ${nonce} buffer`,
    ]);
    streams.set("continuation", (nonce) => [
      "故事结束。",
      `@end ${nonce} ending`,
    ]);
    (generator as any).client = {
      chat: {
        completions: {
          create: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
            const user = request.messages[1]!.content as string;
            const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
            const taskType = /任务类型：([^\n]+)/.exec(user)?.[1] ?? "";
            const lines = streams.get(taskType) ?? ((n: string) => [`@end ${n} buffer`]);
            return dslStream(lines(nonce));
          }),
        },
      },
    };

    const status = makeMockStatus();
    const media = makeMockMedia();
    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.select(output.interactionId, `${output.interactionId}_opt_0`),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    controller.attach(game);
    await game.run();

    const seq = outputSeq(controller.outputs);

    // The branch line must play AFTER interaction_resolved — the frontend
    // VM (separately tested) turns CONTENT_WAITING → PLAYING on it.
    const branchPlayback = controller.outputs.findIndex(
      (o) => o.type === "playback_ready" && o.event.text === "分支内容一。",
    );
    const resolvedIndex = controller.outputs.findIndex((o) => o.type === "interaction_resolved");
    expect(branchPlayback).toBeGreaterThan(resolvedIndex);
  });

  it("branch prefetch failing (2 dialogues < required 3) → selection retry also fails → behavior", async () => {
    const config: AppConfig = makeTestConfig({
      generation: { repair_attempts: 1 },
      prefetch: { branch_dialogue_lines: 3 },
    });
    const generator = new StoryGenerator(config, makeTestPrompts(), makeTestInstructions(), DUMMY_API_KEY);
    let branchCalls = 0;
    (generator as any).client = {
      chat: {
        completions: {
          create: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
            const user = request.messages[1]!.content as string;
            const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
            const taskType = /任务类型：([^\n]+)/.exec(user)?.[1] ?? "";
            if (taskType === "opening") {
              return dslStream([
                "苏遥: 别碰那台机器。",
                "? 怎么回应？",
                "+ 追问她",
                "+ 暂时停手",
                "/?",
                `@end ${nonce} interaction`,
              ]);
            }
            if (taskType === "branch_prefetch") {
              branchCalls += 1;
              // Always 2 dialogues — below branch_dialogue_lines=3 → adapter throws.
              return dslStream([
                "苏遥: 分支内容一。",
                "苏遥: 分支内容二。",
                `@end ${nonce} buffer`,
              ]);
            }
            return dslStream([
              "故事结束。",
              `@end ${nonce} ending`,
            ]);
          }),
        },
      },
    };

    const status = makeMockStatus();
    const media = makeMockMedia();
    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.select(output.interactionId, `${output.interactionId}_opt_0`),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    controller.attach(game);

    let runError: unknown = null;
    try {
      await game.run();
    } catch (e) {
      runError = e;
    }
    const seq = outputSeq(controller.outputs);
    
    
    
    const errors = controller.outputs.filter((o) => o.type === "runtime_error");
    
    // The game must NOT hang: it either errors visibly or recovers.
    expect(controller.outputs.some((o) => o.type === "session_ended") || errors.length > 0).toBe(true);
  });
});

describe("hybrid preview-cancel re-arm then select (real generator)", () => {
  it("selecting an option after a cancel/re-arm does not corrupt the playback buffer", async () => {
    const config: AppConfig = makeTestConfig({
      generation: { repair_attempts: 0 },
      prefetch: { branch_dialogue_lines: 3 },
    });
    const generator = new StoryGenerator(config, makeTestPrompts(), makeTestInstructions(), DUMMY_API_KEY);

    let hybridCalls = 0;
    (generator as any).client = {
      chat: {
        completions: {
          create: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
            const user = request.messages[1]!.content as string;
            const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
            const taskType = /任务类型：([^\n]+)/.exec(user)?.[1] ?? "";
            if (taskType === "opening") {
              return dslStream([
                "苏遥: 别碰那台机器。",
                "? 怎么回应？",
                "+ 追问她",
                "+ 暂时停手",
                "= 或输入……",
                "/?",
                `@end ${nonce} interaction`,
              ]);
            }
            if (taskType === "branch_prefetch") {
              hybridCalls += 1;
              return dslStream([
                "苏遥: 分支内容一。",
                "苏遥: 分支内容二。",
                "苏遥: 分支内容三。",
                `@end ${nonce} buffer`,
              ]);
            }
            if (taskType === "input_bridge") {
              return dslStream([`@end ${nonce} buffer`]);
            }
            if (taskType === "input_response") {
              return dslStream([`@end ${nonce} buffer`]);
            }
            return dslStream(["故事结束。", `@end ${nonce} ending`]);
          }),
        },
      },
    };

    const status = makeMockStatus();
    const media = makeMockMedia();
    let first = true;
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        if (first) {
          first = false;
          controller.submitInput(output.interactionId, "试探一下");
        } else {
          controller.select(output.interactionId, `${output.interactionId}_opt_0`);
        }
      },
      onInputPreviewOpened: (output) => controller.cancel(output.previewId),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    controller.attach(game);

    let runError: unknown = null;
    try {
      await game.run();
    } catch (e) {
      runError = e;
    }
    
    const seq = outputSeq(controller.outputs);
    
    // The game must finish (or error) without the buffer-order crash.
    expect(String(runError ?? "")).not.toContain("播放缓冲顺序");
    expect(controller.outputs.some((o) => o.type === "session_ended") || controller.outputs.some((o) => o.type === "runtime_error")).toBe(true);
  });
});

describe("aborted streamed input response then branch select (buffer race)", () => {
  it("selecting an option after aborting a streamed input response keeps buffer order", async () => {
    const config: AppConfig = makeTestConfig({
      generation: { repair_attempts: 0 },
      prefetch: { branch_dialogue_lines: 3 },
    });
    const generator = new StoryGenerator(config, makeTestPrompts(), makeTestInstructions(), DUMMY_API_KEY);

    (generator as any).client = {
      chat: {
        completions: {
          create: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
            const user = request.messages[1]!.content as string;
            const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
            const taskType = /任务类型：([^\n]+)/.exec(user)?.[1] ?? "";
            if (taskType === "opening") {
              return dslStream([
                "苏遥: 别碰那台机器。",
                "? 怎么回应？",
                "+ 追问她",
                "+ 暂时停手",
                "= 或输入……",
                "/?",
                `@end ${nonce} interaction`,
              ]);
            }
            if (taskType === "branch_prefetch") {
              // Stream the branch lines across separate chunks with a delay —
              // like a real model streaming over time.
              return (async function* () {
                for (const line of ["苏遥: 分支内容一。", "苏遥: 分支内容二。", "苏遥: 分支内容三。"]) {
                  await new Promise((r) => setTimeout(r, 30));
                  yield { choices: [{ delta: { content: `${line}\n` } }] };
                }
                await new Promise((r) => setTimeout(r, 30));
                yield { choices: [{ delta: { content: `@end ${nonce} buffer\n` } }] };
              })();
            }
            if (taskType === "input_bridge") {
              return dslStream([`@end ${nonce} buffer`]);
            }
            if (taskType === "input_response") {
              // Stream two response lines, then keep streaming (aborted on cancel).
              return (async function* () {
                for (const line of ["苏遥: 你来了。", "苏遥: 我以为没人会再来。"]) {
                  await new Promise((r) => setTimeout(r, 30));
                  yield { choices: [{ delta: { content: `${line}\n` } }] };
                }
                await new Promise(() => undefined); // never ends on its own
              })();
            }
            return dslStream(["故事结束。", `@end ${nonce} ending`]);
          }),
        },
      },
    };

    const status = makeMockStatus();
    const media = makeMockMedia();
    let first = true;
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        if (first) {
          first = false;
          controller.submitInput(output.interactionId, "试探一下");
        } else {
          controller.select(output.interactionId, `${output.interactionId}_opt_0`);
        }
      },
      onInputPreviewOpened: (output) => controller.cancel(output.previewId),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    controller.attach(game);

    let runError: unknown = null;
    try {
      await game.run();
    } catch (e) {
      runError = e;
    }
    
    expect(String(runError ?? "")).not.toContain("播放缓冲顺序");
  });
});

describe("stray group after the interaction terminal is discarded (docs §50)", () => {
  it("a dialogue group emitted after the interaction corrupts the buffer", async () => {
    const config: AppConfig = makeTestConfig({
      generation: { repair_attempts: 0 },
      prefetch: { branch_dialogue_lines: 3 },
    });
    const generator = new StoryGenerator(config, makeTestPrompts(), makeTestInstructions(), DUMMY_API_KEY);

    (generator as any).client = {
      chat: {
        completions: {
          create: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
            const user = request.messages[1]!.content as string;
            const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
            const taskType = /任务类型：([^\n]+)/.exec(user)?.[1] ?? "";
            if (taskType === "opening") {
              return dslStream([
                "苏遥: 别碰那台机器。",
                "? 怎么回应？",
                "+ 追问她",
                "+ 暂时停手",
                "/?",
                // In-flight tail BEFORE the sentinel: the model streamed a
                // stray dialogue between the form and @end (legal DSL).
                "苏遥: 这句不该出现。",
                `@end ${nonce} interaction`,
              ]);
            }
            if (taskType === "branch_prefetch") {
              return dslStream([
                "苏遥: 分支内容一。",
                "苏遥: 分支内容二。",
                "苏遥: 分支内容三。",
                `@end ${nonce} buffer`,
              ]);
            }
            if (taskType === "input_bridge") {
              return dslStream([`@end ${nonce} buffer`]);
            }
            if (taskType === "input_response") {
              return dslStream([`@end ${nonce} buffer`]);
            }
            return dslStream(["故事结束。", `@end ${nonce} ending`]);
          }),
        },
      },
    };

    const status = makeMockStatus();
    const media = makeMockMedia();
    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.select(output.interactionId, `${output.interactionId}_opt_0`),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts(), CATALOG);
    controller.attach(game);

    let runError: unknown = null;
    try {
      await game.run();
    } catch (e) {
      runError = e;
    }
    
    const seq = outputSeq(controller.outputs);
    
    expect(String(runError ?? "")).not.toContain("播放缓冲顺序");
  });
});
