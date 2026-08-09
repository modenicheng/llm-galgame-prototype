/**
 * Tests for StoryGenerator prompt construction, response parsing, and
 * GenerationEnvelope validation.
 *
 * These tests verify parsing and prompt-building logic WITHOUT making
 * real API calls. The OpenAI client is constructed but never invoked.
 */

import { describe, it, expect, vi } from "vitest";
import { StoryGenerator, generateNonce } from "./adapters/llm/openai-compatible-generator.js";
import type { AppConfig } from "./config.js";
import type { PromptBundle } from "./prompts.js";
import type { StoryContextEvent, InteractionEvent } from "./schema.js";
import { makeTestConfig } from "./test-helpers.js";
import type { StoryState, GenerationEnvelope } from "./story/types.js";
import { createInitialState } from "./story/state.js";
import {
  buildDslUserPrompt,
  serializeStoryContext,
  serializeVisualContext,
  type DslContextInput,
} from "./story/context-builder.js";
import type { VisualState } from "./core/presentation/types.js";
import type { ModelAssetCatalog } from "./core/assets/types.js";
import { parseDslSegmentText } from "./core/protocol/gal-dsl/text-pipeline.js";
import type {
  EventGroupDraft,
  SegmentEndStatus,
} from "./core/protocol/gal-dsl/types.js";

// ---------------------------------------------------------------------------
// Test helpers — reusable fixtures, no real network calls
// ---------------------------------------------------------------------------

const DUMMY_API_KEY = "sk-test-no-calls";

function makeTestPrompts(): PromptBundle {
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

function makeTestGenerator(
  overrides?: Parameters<typeof makeTestConfig>[0],
): StoryGenerator {
  return new StoryGenerator(
    makeTestConfig(overrides),
    makeTestPrompts(),
    makeTestInstructions(),
    DUMMY_API_KEY,
  );
}

function makeTestState(): StoryState {
  return createInitialState({
    scene: {
      id: "tavern",
      location: "酒馆",
      time: "黄昏",
      purpose: "收集情报",
    },
    canon: { weather: "rainy" },
    characters: {
      hero: { location: "酒馆", emotion: "警惕" },
      innkeeper: { location: "酒馆", emotion: "友善", relationship_to_player: "neutral" },
    },
    recent_summary: "冒险者走进酒馆，雨还在下。",
  });
}

function makeTestHistory(): StoryContextEvent[] {
  return [
    {
      type: "narration",
      text: "冒险者推开酒馆沉重的木门。",
      line_id: "line_1",
      seq: 1,
      turn: 1,
      timestamp: "2024-01-01T00:00:00.000Z",
      source: "model",
    },
    {
      type: "dialogue",
      speaker: "老板",
      text: "欢迎！要喝点什么？",
      portrait: { character: "innkeeper", expression: "neutral", position: "center" },
      line_id: "line_2",
      seq: 2,
      turn: 1,
      timestamp: "2024-01-01T00:00:01.000Z",
      source: "model",
    },
  ];
}

describe("StoryGenerator ContextInput integration", () => {
  it("generator constructor builds systemPrompt with prompts and empty state", () => {
    const gen = makeTestGenerator();
    const systemPrompt = (gen as any).systemPrompt as string;

    expect(systemPrompt).toContain("行式 Gal DSL");
    expect(systemPrompt).toContain("角色设定");
    expect(systemPrompt).toContain("勇敢的冒险者");
    expect(systemPrompt).toContain("故事大纲");
    expect(systemPrompt).toContain("迷雾森林");
    expect(systemPrompt).toContain("写作限制");
    expect(systemPrompt).toContain("悬疑氛围");
  });

  it("all public generation methods build user prompts without throwing (no API call)", () => {
    const gen = makeTestGenerator();
    const state = makeTestState();
    const history = makeTestHistory();

    // generateOpening — these will fail at API call time, but prompt
    // construction happens synchronously before the first await.
    // We can verify they don't throw during construction.
    // (They will throw when trying to call the fake API, but we're not
    //  awaiting them — just verifying instantiation works. We attach
    //  .catch to suppress unhandled rejections.)
    expect(() => {
      gen.generateOpening(1, state).catch(() => {});
    }).not.toThrow();

    expect(() => {
      const interaction: InteractionEvent = {
        type: "interaction",
        interaction_id: "int_1",
        prompt: "你想说什么？",
        mode: "input",
        input: { kind: "free_text", placeholder: "...", max_length: 200 },
      };
      gen.generateInputResponse(2, state, history, interaction, "你好").catch(() => {});
    }).not.toThrow();

    expect(() => {
      const prefetched: StoryContextEvent[] = [
        {
          type: "dialogue",
          speaker: "NPC",
          text: "prefetch text",
          line_id: "pf_1",
          seq: 5,
          turn: 2,
          timestamp: "2024-01-01T00:00:05.000Z",
          source: "model",
        },
      ];
      gen.generateContinuation(3, state, history, prefetched).catch(() => {});
    }).not.toThrow();
  });

  it("generator stores config and prompts correctly", () => {
    const baseConfig = makeTestConfig();
    const config = makeTestConfig({
      game: { ...baseConfig.game, history_events: 120 },
    });
    const prompts = makeTestPrompts();
    const instructions = makeTestInstructions();
    const gen = new StoryGenerator(config, prompts, instructions, DUMMY_API_KEY);

    // Access private fields for verification
    expect((gen as any).config.game.history_events).toBe(120);
    expect((gen as any).prompts.characters).toBe(prompts.characters);
  });
});

// ---------------------------------------------------------------------------
// DSL mode — serializers, prompt builder, nonce, whole-text pipeline
// ---------------------------------------------------------------------------

describe("DSL serializers and prompt builder", () => {
  function makeVisualState(): VisualState {
    return {
      background: "basement",
      bgm: "mystery",
      characters: {
        suyao: {
          spriteSet: "suyao",
          variant: "anxious",
          position: "left",
          displayName: "神秘女子",
          visible: true,
        },
      },
    };
  }

  it("serializeStoryContext emits plain text without runtime metadata", () => {
    const events: StoryContextEvent[] = [
      {
        type: "narration",
        text: "终端重新亮起。",
        line_id: "l1",
        seq: 1,
        turn: 2,
        timestamp: "2024-01-01T00:00:00.000Z",
        source: "model",
      },
      {
        type: "dialogue",
        speaker: "苏遥",
        text: "你最好别再问。",
        portrait: { character: "suyao", expression: "anxious", position: "left" },
        line_id: "l2",
        seq: 2,
        turn: 2,
        timestamp: "2024-01-01T00:00:01.000Z",
        source: "model",
      },
      {
        type: "player_choice",
        choice_id: "c1",
        text: "继续追问",
        seq: 3,
        turn: 2,
        timestamp: "2024-01-01T00:00:02.000Z",
        source: "player",
      },
      {
        type: "player_input",
        interaction_id: "i1",
        text: "你明明知道它还在运行。",
        seq: 4,
        turn: 2,
        timestamp: "2024-01-01T00:00:03.000Z",
        source: "player",
      },
      {
        type: "player_dialogue",
        interaction_id: "i1",
        speaker: "你",
        text: "说吧。",
        line_id: "l3",
        seq: 5,
        turn: 2,
        timestamp: "2024-01-01T00:00:04.000Z",
        source: "player",
      },
      {
        type: "interaction",
        interaction_id: "i2",
        prompt: "怎么回应？",
        mode: "choice",
        options: [
          { id: "a", text: "好" },
          { id: "b", text: "不" },
        ],
      },
    ];

    const out = serializeStoryContext(events);
    expect(out).toBe(
      [
        "终端重新亮起。",
        "苏遥: 你最好别再问。",
        "[玩家] 选择：继续追问",
        "[玩家] 输入：你明明知道它还在运行。",
        "[玩家] 说吧。",
      ].join("\n"),
    );
    expect(out).not.toContain("line_id");
    expect(out).not.toContain("seq");
    expect(out).not.toContain("interaction");
  });

  it("serializeVisualContext formats sections and omits absent ones", () => {
    const state: VisualState = {
      ...makeVisualState(),
      characters: {
        suyao: {
          spriteSet: "suyao",
          variant: "anxious",
          position: "left",
          displayName: "神秘女子",
          visible: true,
        },
        yuki: {
          spriteSet: "yuki",
          variant: "normal",
          position: "right",
          displayName: "由纪",
          visible: false,
        },
      },
    };
    expect(serializeVisualContext(state)).toBe(
      [
        "背景：basement",
        "BGM：mystery",
        "角色：",
        "- suyao（显示名：神秘女子）：立绘 suyao/anxious，位置 left，可见",
        "- yuki（显示名：由纪）：立绘 yuki/normal，位置 right，隐藏",
      ].join("\n"),
    );

    // No background / bgm / characters → empty string.
    expect(serializeVisualContext({ characters: {} })).toBe("");
    // BGM omitted when undefined.
    expect(serializeVisualContext({ background: "basement", characters: {} })).toBe(
      "背景：basement",
    );
  });

  it("buildDslUserPrompt includes task header, nonce, visual state and asset catalog", () => {
    const catalog: ModelAssetCatalog = {
      guidance: "当前素材主要覆盖校园、住宅和地下设施。",
      backgrounds: { basement: { description: "昏暗地下设备间，主要用于旧终端剧情。" } },
      bgm: { mystery: { description: "轻度悬疑和未知感。" } },
      soundEffects: { terminal_beep: { description: "旧终端发出的短促电子提示音。" } },
      spriteSets: {
        suyao: {
          description: "苏遥正式立绘。",
          variants: {
            normal: { description: "默认冷静状态。" },
            anxious: { description: "明显紧张、不安时使用。" },
          },
        },
      },
      characters: {
        suyao: {
          scriptName: "苏遥",
          displayName: "苏遥",
          spriteSet: "suyao",
          defaultVariant: "normal",
          defaultPosition: "left",
          allowedSpriteSets: ["suyao"],
        },
      },
    };
    const ctx: DslContextInput = {
      prompts: makeTestPrompts(),
      state: createInitialState(),
      recentEvents: [],
      taskType: "continuation",
      generationNonce: "a81f",
      targetLines: 6,
      tailVisualState: makeVisualState(),
      modelAssetCatalog: catalog,
    };

    const prompt = buildDslUserPrompt(3, ctx, "请继续推进剧情。");
    expect(prompt).toContain("任务类型：continuation");
    expect(prompt).toContain("生成段 nonce：a81f");
    expect(prompt).toContain("本次续写目标行数：6");
    expect(prompt).toContain("当前回合：3");
    expect(prompt).toContain("===== 当前舞台状态 =====");
    expect(prompt).toContain("背景：basement");
    expect(prompt).toContain("- suyao（显示名：神秘女子）");
    expect(prompt).toContain("===== 可用素材 =====");
    expect(prompt).toContain("立绘组 suyao：苏遥正式立绘。");
    expect(prompt).toContain("- suyao（脚本名：苏遥，默认显示名：苏遥");
    expect(prompt).toContain("请继续推进剧情。");
  });
});

const DSL_ACCEPTANCE_TEXT = [
  "bg basement",
  "",
  "地下室里只亮着终端的一点蓝光。",
  "",
  "苏遥[normal|left](神秘女子): 你不该来这里。",
  "",
  "苏遥[anxious]: 别碰那台机器。",
  "",
  "? 怎么回应？",
  "+ 追问她为什么知道机器仍能运行",
  "+ 暂时停手",
  "= 或说出自己的回答……",
  "/?",
  "",
  "@end a81f interaction",
].join("\n");

describe("DSL whole-text pipeline", () => {
  it("parses the §110 acceptance scenario end-to-end", () => {
    const result = parseDslSegmentText(DSL_ACCEPTANCE_TEXT, {
      expectedNonce: "a81f",
      allowedReasons: ["buffer", "interaction", "ending"],
    });

    expect(result.status).toEqual({
      kind: "complete",
      nonce: "a81f",
      reason: "interaction",
    });
    expect(result.groups).toHaveLength(4);
    expect(result.groups[0]!.prelude).toEqual([
      { type: "background", assetId: "basement" },
    ]);
    expect(result.groups[3]!.main).toEqual({
      type: "interaction",
      interaction: {
        prompt: "怎么回应？",
        optionTexts: ["追问她为什么知道机器仍能运行", "暂时停手"],
        inputPlaceholder: "或说出自己的回答……",
        mode: "hybrid",
      },
    });
  });
});

describe("generateNonce", () => {
  it("returns a 4-hex-char lowercase string", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateNonce()).toMatch(/^[0-9a-f]{4}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// DSL mode generation — streaming requestDslEnvelope path
// ---------------------------------------------------------------------------

describe("DSL mode generation", () => {
  function makeDslGenerator(
    overrides?: Parameters<typeof makeTestConfig>[0],
  ): StoryGenerator {
    const config = makeTestConfig({
      ...overrides,
      generation: {
        temperature: 1.0,
        max_tokens: 500,
        repair_attempts: 0,
        ...overrides?.generation,
      },
    });
    return new StoryGenerator(
      config,
      makeTestPrompts(),
      makeTestInstructions(),
      DUMMY_API_KEY,
    );
  }

  function dslStream(lines: string[]): AsyncGenerator<unknown> {
    return (async function* () {
      for (const line of lines) {
        yield { choices: [{ delta: { content: `${line}\n` } }] };
      }
    })();
  }

  /** create mock that echoes the request's own generation nonce. */
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

  it("streams groups, forwards onGroup/onSegmentEnd, and resolves groups + segmentEnd", async () => {
    const gen = makeDslGenerator();
    mockDslClient(gen, (nonce) => [
      "bg basement",
      "地下室里只亮着终端的一点蓝光。",
      "苏遥[normal|left](神秘女子): 你不该来这里。",
      `@end ${nonce} interaction`,
    ]);

    const received: EventGroupDraft[] = [];
    const ends: SegmentEndStatus[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
      onSegmentEnd: (status: SegmentEndStatus) => ends.push(status),
    });

    expect(received).toHaveLength(2);
    expect(received[0]!.prelude).toEqual([{ type: "background", assetId: "basement" }]);
    expect(received[1]!.main).toMatchObject({ type: "dialogue", speaker: "苏遥" });
    expect(ends).toEqual([
      { kind: "complete", nonce: expect.any(String), reason: "interaction" },
    ]);
    expect(envelope.events).toEqual([]);
    expect(envelope.state_patch).toEqual({});
    expect(envelope.groups).toHaveLength(2);
    expect(envelope.segmentEnd).toEqual({
      kind: "complete",
      nonce: expect.any(String),
      reason: "interaction",
    });
  });

  it("retries with a repair instruction when a bad line precedes any forwarded group", async () => {
    const gen = makeDslGenerator({ generation: { repair_attempts: 1 } });
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) return ["@end bbbb buffer"]; // wrong nonce → DslProtocolError
      return ["地下室里只亮着终端的一点蓝光。", `@end ${nonce} buffer`];
    });

    const envelope = await (gen as any).generateOpening(1, createInitialState());
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    const retryUser = create.mock.calls[1]![0].messages[1].content as string;
    expect(retryUser).toContain("DSL 校验失败");
    expect(envelope.groups).toHaveLength(1);
    expect(envelope.segmentEnd).toEqual({
      kind: "complete",
      nonce: expect.any(String),
      reason: "buffer",
    });
  });

  it("fails with the line framing and cause when a bad line follows forwarded groups", async () => {
    const gen = makeDslGenerator();
    mockDslClient(gen, () => [
      "地下室里只亮着终端的一点蓝光。",
      "@end a81f buffer", // nonce never matches the random request nonce
    ]);

    const received: EventGroupDraft[] = [];
    const promise = (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });

    await expect(promise).rejects.toMatchObject({
      message: expect.stringMatching(/^DSL 流在第 2 行校验失败：Sentinel nonce/),
      cause: expect.objectContaining({ name: "DslProtocolError" }),
    });
    expect(received).toHaveLength(1);
  });

  it("fails preserving the prefix when a truncated segment has forwarded groups", async () => {
    const gen = makeDslGenerator();
    mockDslClient(gen, () => ["地下室里只亮着终端的一点蓝光。"]); // no sentinel

    const received: EventGroupDraft[] = [];
    const promise = (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });

    await expect(promise).rejects.toThrow(/没有 @end 哨兵/);
    expect(received).toHaveLength(1);
  });

  it("generateInputBridge issues a DSL request (input bridge is a prefetch task)", async () => {
    const gen = makeTestGenerator();
    const interaction: InteractionEvent = {
      type: "interaction",
      interaction_id: "int_1",
      prompt: "你想说什么？",
      mode: "input",
      input: { kind: "free_text", placeholder: "...", max_length: 200 },
    };
    // Mock the chat completion stream: the bridge request must reach the
    // provider and parse a narration group + sentinel (nonce from the prompt).
    mockDslClient(gen, (nonce) => [
      "她静静地看着你。",
      `@end ${nonce} buffer`,
    ]);
    const envelope = await gen.generateInputBridge(1, createInitialState(), interaction);
    expect(envelope.groups?.length).toBe(1);
    expect(envelope.groups![0]!.main.type).toBe("narration");
    expect(envelope.segmentEnd).toEqual({
      kind: "complete",
      nonce: expect.any(String),
      reason: "buffer",
    });
  });
});
