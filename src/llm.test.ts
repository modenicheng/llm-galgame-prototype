/**
 * Tests for StoryGenerator prompt construction, response parsing, and
 * GenerationEnvelope validation.
 *
 * These tests verify parsing and prompt-building logic WITHOUT making
 * real API calls. The OpenAI client is constructed but never invoked.
 */

import { describe, it, expect, vi } from "vitest";
import {
  StoryGenerator,
  GeneratorPortFacade,
  generateNonce,
} from "./adapters/llm/openai-compatible-generator.js";
import type { AppConfig } from "./config.js";
import type { PromptBundle } from "./prompts.js";
import type { StoryContextEvent, InteractionEvent } from "./schema.js";
import { makeTestConfig } from "./test-helpers.js";
import {
  buildCharacterRoster,
  createCharacterRegistry,
} from "./core/characters/registry.js";
import { createCharacterRuntimeState } from "./core/characters/types.js";
import type { CharacterRegistry as RosterRegistry } from "./core/characters/types.js";
import type { AssetCatalog } from "./core/assets/types.js";
import type { StoryState, GenerationEnvelope } from "./story/types.js";
import { createInitialState } from "./story/state.js";
import {
  buildDslUserPrompt,
  serializeStoryContext,
  serializeStoryContextLegacy,
  serializeVisualContext,
  type DslContextInput,
} from "./story/context-builder.js";
import type { VisualState } from "./core/presentation/types.js";
import type { ModelAssetCatalog } from "./core/assets/types.js";
import { parseDslSegmentText } from "./core/protocol/gal-dsl/text-pipeline.js";
import type {
  AnyStreamedGroup,
  EventGroupDraft,
  SegmentEndStatus,
} from "./core/protocol/gal-dsl/types.js";
import type { GenerationIdentity } from "./core/ports/story-generator-port.js";

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
    characters: {
      hero: { location: "酒馆" },
      innkeeper: { location: "酒馆" },
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
      game: { ...baseConfig.game, sessions_dir: "alt_sessions" },
    });
    const prompts = makeTestPrompts();
    const instructions = makeTestInstructions();
    const gen = new StoryGenerator(config, prompts, instructions, DUMMY_API_KEY);

    // Access private fields for verification
    expect((gen as any).config.game.sessions_dir).toBe("alt_sessions");
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

  /** C2 roster registry（C5 身份稳定投影用）。 */
  function rosterRegistry(): RosterRegistry {
    const assets: AssetCatalog = {
      guidance: "",
      backgrounds: {},
      bgm: {},
      soundEffects: {},
      spriteSets: {},
    };
    return createCharacterRegistry(
      buildCharacterRoster({
        schemaVersion: 2,
        scopeId: "llm-test",
        playerId: "player_one",
        characters: [
          { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
          { id: "suyao", name: "苏遥", control: "npc", initialLabel: "苏遥", persona: "同班同学。" },
        ],
      }),
      assets,
    );
  }

  it("serializeStoryContext emits identity-stable JSONL (characterId + label snapshot)", () => {
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

    const out = serializeStoryContext(events, rosterRegistry());
    const lines = out.split("\n");
    expect(lines).toHaveLength(5); // player 双视图合并为一条；interaction 保留（未提交 attempt 引用）
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // 稳定 characterId 随行携带；名牌是发射时刻快照。
    const dialogue = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(dialogue["characterId"]).toBe("suyao");
    expect(dialogue["displayLabel"]).toBe("苏遥");
    expect(dialogue["eventRef"]).toBe("event:2");
    // 玩家双视图合并：一条 player_dialogue，链接输入视图，控制角色 ID。
    const player = JSON.parse(lines[3]!) as Record<string, unknown>;
    expect(player["type"]).toBe("player_dialogue");
    expect(player["characterId"]).toBe("player_one");
    expect(player["interactionId"]).toBe("i1");
    expect(player["linkedEventRef"]).toBe("event:4");
    // 未提交 interaction：attempt 引用（无 seq），已提交/未提交分开标记。
    const interaction = JSON.parse(lines[4]!) as Record<string, unknown>;
    expect(interaction["type"]).toBe("interaction");
    expect(interaction["eventRef"]).toBe("attempt:i2:0");
    expect(interaction["seq"]).toBeUndefined();
    // 运行时元数据不外泄（docs §69）。
    expect(out).not.toContain("line_id");
    expect(out).not.toContain("turn");
    expect(out).not.toContain("timestamp");
    // 可误解析的冒号行头格式不出现（R01）。
    expect(out).not.toMatch(/苏遥[:：]/);
  });

  it("serializeVisualContext states every dimension explicitly, including empty ones", () => {
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
        "以下舞台画面已生效，本段从这一画面继续。只输出发生变化的指令，状态不变时不要重复输出 @bg / @bgm / @ch 或台词头括号。",
        "背景：basement",
        "BGM：mystery（正在播放）",
        "角色：",
        "- suyao（显示名：神秘女子）：立绘 suyao/anxious，位置 left，可见",
        "- yuki（显示名：由纪）：立绘 yuki/normal，位置 right，隐藏（说话不会自动显示，需 @ch yuki show 恢复）",
      ].join("\n"),
    );

    // Nothing on stage yet (opening request) — still explicit, so the model
    // knows it must set the scene up instead of guessing it continues one.
    expect(serializeVisualContext({ characters: {} })).toBe(
      [
        "以下舞台画面已生效，本段从这一画面继续。只输出发生变化的指令，状态不变时不要重复输出 @bg / @bgm / @ch 或台词头括号。",
        "背景：无（尚未设置）",
        "BGM：无（当前没有音乐播放，不要再输出 @bgm stop）",
        "角色：台上无人",
      ].join("\n"),
    );
  });

  it("serializeVisualContext lists registered characters that are off stage", () => {
    // C7：不在场名单从 roster 派生（initialLabel），不再走模型目录 characters。
    const roster = buildCharacterRoster({
      schemaVersion: 2,
      scopeId: "visual-context-test",
      playerId: "player_one",
      characters: [
        { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
        {
          id: "suyao",
          name: "苏遥",
          control: "npc",
          initialLabel: "苏遥",
          persona: "同班同学。",
          presentation: {
            defaultLook: "normal",
            defaultPosition: "left",
            looks: { normal: { spriteSet: "suyao", variant: "normal" } },
          },
        },
        {
          id: "yuki",
          name: "由纪",
          control: "npc",
          initialLabel: "由纪",
          persona: "同级生。",
          presentation: {
            defaultLook: "normal",
            defaultPosition: "right",
            looks: { normal: { spriteSet: "yuki", variant: "normal" } },
          },
        },
        {
          id: "kaito",
          name: "海斗",
          control: "npc",
          initialLabel: "海斗",
          persona: "同级生。",
          presentation: {
            defaultLook: "base",
            defaultPosition: "far_left",
            looks: { base: { spriteSet: "male_A", variant: "base" } },
          },
        },
      ],
    });
    const state: VisualState = {
      background: "basement",
      characters: {
        suyao: {
          spriteSet: "suyao",
          variant: "normal",
          position: "left",
          displayName: "苏遥",
          visible: true,
        },
      },
    };
    const out = serializeVisualContext(state, roster);
    expect(out).toContain("不在场：由纪、海斗");
    expect(out).not.toContain("苏遥、由纪");

    // Everyone on stage → no off-stage line.
    const allOn: VisualState = {
      ...state,
      characters: {
        suyao: state.characters.suyao!,
        yuki: {
          spriteSet: "yuki",
          variant: "normal",
          position: "right",
          displayName: "由纪",
          visible: true,
        },
        kaito: {
          spriteSet: "male_A",
          variant: "base",
          position: "far_left",
          displayName: "海斗",
          visible: true,
        },
      },
    };
    expect(serializeVisualContext(allOn, roster)).not.toContain("不在场");
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
    // C7：模型目录不再携带 characters 段（身份随 roster 渲染）。
    expect(prompt).not.toContain("脚本名：苏遥");
    expect(prompt).toContain("请继续推进剧情。");
  });
});

const DSL_ACCEPTANCE_TEXT = [
  "@bg basement",
  "",
  "地下室里只亮着终端的一点蓝光。",
  "",
  "苏遥[normal|left](神秘女子): 你不该来这里。",
  "",
  "苏遥[anxious]: 别碰那台机器。",
  "",
  "@? 怎么回应？",
  "@+ 追问她为什么知道机器仍能运行",
  "@+ 暂时停手",
  "@= 或说出自己的回答……",
  "@/?",
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
      "@bg basement",
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
    expect(envelope.groups).toHaveLength(2);
    expect(envelope.segmentEnd).toEqual({
      kind: "complete",
      nonce: expect.any(String),
      reason: "interaction",
    });
  });

  it("repairs a missing end keyword and closes a complete interaction form", async () => {
    const gen = makeDslGenerator();
    mockDslClient(gen, (nonce) => [
      "@? 你要怎么接话？",
      "@+ 凑过去看那张纸片，先别撕",
      "@+ 问这挂件是在哪儿捡到的",
      "@= 你想说点什么",
      `@ ${nonce} interaction`, // missing "end" keyword → closing-repair
    ]);

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.main).toMatchObject({
      type: "interaction",
      interaction: { mode: "hybrid", prompt: "你要怎么接话？" },
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
  });

  it("repairs an empty @? into the form end while a form is open", async () => {
    const gen = makeDslGenerator();
    mockDslClient(gen, (nonce) => [
      "@? 你要怎么接话？",
      "@+ 凑过去看那张纸片",
      "@?", // empty prompt with the form open → botched @/?
      `@end ${nonce} interaction`,
    ]);

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.main).toMatchObject({
      type: "interaction",
      interaction: { mode: "choice", prompt: "你要怎么接话？" },
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
  });

  it("does not repair a loose terminal with the wrong nonce", async () => {
    const gen = makeDslGenerator();
    // Continuation replays the same broken content: the budget runs out and
    // the attempt fails — but no end_keyword repair may ever fire for a
    // nonce that cannot match.
    mockDslClient(gen, () => ["@? 怎么回应？", "@+ 先看看", "@ dead interaction"]);

    await expect(
      (gen as any).generateOpening(1, createInitialState()),
    ).rejects.toThrow(/连续校验失败|EMPTY_FORM_PROMPT|UNKNOWN_COMMAND/);
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
    // Byte-exact: this string rides into the model's repair instruction —
    // FastAPI-style detail block (code + offending line + expected format).
    expect(retryUser).toContain(
      "第 1 行 DSL 错误 [SENTINEL_NONCE_MISMATCH]：哨兵 nonce bbbb 与本次任务要求的",
    );
    expect(retryUser).toContain("期望格式：@end");
    expect(retryUser).toContain("修正：把 nonce 改为");
    expect(envelope.groups).toHaveLength(1);
    expect(envelope.segmentEnd).toEqual({
      kind: "complete",
      nonce: expect.any(String),
      reason: "buffer",
    });
  });

  it("fails preserving the prefix when a non-@ line is structurally invalid", async () => {
    // INVALID_VISUAL_BRACKET is not @-anchored → not strip-continuable → the
    // existing fail path keeps the forwarded prefix for the runtime repair.
    const gen = makeDslGenerator();
    mockDslClient(gen, () => [
      "地下室里只亮着终端的一点蓝光。",
      "苏遥[|]: 空段。",
    ]);

    const received: EventGroupDraft[] = [];
    const promise = (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });

    await expect(promise).rejects.toMatchObject({
      message: expect.stringMatching(
        /^DSL 流校验失败，已保留前面可播放的内容。第 2 行 DSL 错误 \[INVALID_VISUAL_BRACKET\]/,
      ),
      cause: expect.objectContaining({ name: "DslProtocolError" }),
    });
    expect(received).toHaveLength(1);
  });

  it("merges a split form prompt (bare @? followed by narration) deterministically", async () => {
    // Observed on deepseek 2026-09-17: the model writes the form prompt on
    // the NEXT line after a bare `@?`. The lookahead merge folds it into the
    // same line without any extra LLM round trip.
    const gen = makeDslGenerator();
    mockDslClient(gen, (nonce) => [
      "苏遥正等你接话，气氛一时凝住。",
      "@?",
      "你打算怎么办？",
      "@+ 坐到她旁边",
      "@+ 直接问她",
      `@end ${nonce} interaction`,
    ]);

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;

    // No continuation request: the merge is purely deterministic.
    expect(create).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(2);
    expect(received[0]!.main).toEqual({ type: "narration", text: "苏遥正等你接话，气氛一时凝住。" });
    expect(received[1]!.main).toMatchObject({
      type: "interaction",
      interaction: { mode: "choice", prompt: "你打算怎么办？" },
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
  });

  it("strip-continues when the model stops right after a bare @?", async () => {
    const gen = makeDslGenerator();
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) return ["地下室里只亮着终端的一点蓝光。", "@?"];
      return [
        "@? 怎么回应？",
        "@+ 暂时停手",
        "@+ 追问她的来历",
        `@end ${nonce} interaction`,
      ];
    });

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;

    expect(create).toHaveBeenCalledTimes(2);
    // The continuation replays the good lines as an assistant prefix — the
    // stripped `@?` must NOT be part of it.
    const assistant = create.mock.calls[1]![0].messages[2] as { role: string; content: string };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toContain("地下室里只亮着终端的一点蓝光。");
    expect(assistant.content).not.toContain("@?");
    // The user turn carries the repair instruction.
    const repairTurn = create.mock.calls[1]![0].messages[3] as { role: string; content: string };
    expect(repairTurn.role).toBe("user");
    expect(repairTurn.content).toContain("交互表单的提示语不能为空");
    expect(repairTurn.content).toContain("从删除位置直接续写");

    expect(received).toHaveLength(2);
    expect(received[0]!.main).toEqual({ type: "narration", text: "地下室里只亮着终端的一点蓝光。" });
    expect(received[1]!.main).toMatchObject({
      type: "interaction",
      interaction: { prompt: "怎么回应？" },
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
  });

  it("strip-continues past an unrelated bad line without leaving a stale deferred @? behind", async () => {
    // 2026-09-17 独立审计 S1：旁白 → 裸 @? → 坏指令行。剔除坏行时必须连带
    // 剔除未合并的 @?，否则续写里模型写出正确的 `@? 提示` 会撞上 stale
    // deferred 被强制空提示，预算已耗 → fail（模型修对了仍失败）。
    const gen = makeDslGenerator();
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) {
        return ["走廊尽头的灯闪了一下。", "@?", "@badcmd 乱写"];
      }
      return [
        "@? 要不要上前查看？",
        "@+ 上前查看",
        "@+ 先退回来",
        `@end ${nonce} interaction`,
      ];
    });

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    const assistant = create.mock.calls[1]![0].messages[2] as { role: string; content: string };
    expect(assistant.content).toContain("走廊尽头的灯闪了一下。");
    expect(assistant.content).not.toContain("@?");
    expect(assistant.content).not.toContain("@badcmd");
    expect(received).toHaveLength(2);
    expect(received[1]!.main).toMatchObject({
      type: "interaction",
      interaction: { prompt: "要不要上前查看？" },
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
  });

  it("deduplicates two consecutive bare @? rows instead of poisoning the prefix", async () => {
    // 2026-09-17 独立审计 S2：双裸 @?。第二个顶替第一个成为延迟行，第一
    // 个从 rawLines 删除——否则它留在 prefix 尾部成为 stale deferred 陷阱。
    const gen = makeDslGenerator();
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) {
        return ["夜色压了下来。", "@?", "@?", `@end ${nonce} interaction`];
      }
      return [
        "@? 接下来去哪？",
        "@+ 天台",
        "@+ 机房",
        `@end ${nonce} interaction`,
      ];
    });

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    const assistant = create.mock.calls[1]![0].messages[2] as { role: string; content: string };
    expect(assistant.content).not.toContain("@?");
    expect(received).toHaveLength(2);
    expect(received[1]!.main).toMatchObject({
      type: "interaction",
      interaction: { prompt: "接下来去哪？" },
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
  });

  it("strip-continues a retired bare alias into its @ form", async () => {
    // 白名单码（RETIRED_ALIAS）：裸 bg 行剔除后续写改写成 @bg 形式。
    const gen = makeDslGenerator();
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) {
        return ["教室里粉笔灰缓缓落下。", "bg classroom_day", `@end ${nonce} buffer`];
      }
      return ["@bg classroom_day", `@end ${nonce} buffer`];
    });

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    // 尾部 cue 无主事件跟随即丢弃（docs §50 既有语义）：旁白 1 组 + buffer 收束。
    expect(received).toHaveLength(1);
    expect(received[0]!.main).toEqual({ type: "narration", text: "教室里粉笔灰缓缓落下。" });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "buffer" });
  });

  it("retries the whole attempt (no assistant prefix) when a bare @? is the first line", async () => {
    // 首行即坏：无前缀可续 → 剔除回退 → 无已提交组 → 整段 retry，
    // 第二次请求保持 [system, user] 两消息形状。
    const gen = makeDslGenerator({ generation: { repair_attempts: 1 } });
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) return ["@?", `@end ${nonce} interaction`];
      return ["@? 怎么回应？", "@+ 先看看", `@end ${nonce} interaction`];
    });

    const envelope = await (gen as any).generateOpening(1, createInitialState());
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    const retryMessages = create.mock.calls[1]![0].messages as Array<{ role: string }>;
    expect(retryMessages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
  });

  it("strip-continues when an empty form is force-closed by a stray bare @? (N1)", async () => {
    // 2026-09-17 独立复核 N1：`@? 提示`（零选项）后又一个裸 @? 触发
    // FORM_ALREADY_OPEN 修复，修复内 closeOpenInteraction 对空表单抛
    // EMPTY_FORM——在 catch 处理器内若不接住会穿透修复信封裸拒绝。
    const gen = makeDslGenerator();
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) {
        return ["台灯在桌角投下光圈。", "@? 你要不要看看？", "@?", `@end ${nonce} interaction`];
      }
      return [
        "@+ 打开看看",
        "@+ 先放着不动",
        "@/?",
        `@end ${nonce} interaction`,
      ];
    });

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    // 续写从空表单的 @? 提示行之前继续（提示保留、补选项后收尾）。
    const assistant = create.mock.calls[1]![0].messages[2] as { role: string; content: string };
    expect(assistant.content).toContain("台灯在桌角投下光圈。");
    expect(received.at(-1)!.main).toMatchObject({
      type: "interaction",
      interaction: expect.objectContaining({ prompt: "你要不要看看？" }),
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
  });

  it("strip-continues a bare @? followed directly by an option row", async () => {
    // 另一真实形状：裸 @? 的下一行是 @+ 选项——提示缺失但选项已经在写。
    const gen = makeDslGenerator();
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) {
        return ["走廊尽头的灯闪了一下。", "@?", "@+ 上前查看", `@end ${nonce} interaction`];
      }
      return [
        "@? 要不要上前查看？",
        "@+ 上前查看",
        "@+ 先退回来",
        `@end ${nonce} interaction`,
      ];
    });

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });
    expect(received).toHaveLength(2);
    expect(received[1]!.main).toMatchObject({
      type: "interaction",
      interaction: { prompt: "要不要上前查看？" },
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
  });

  it("strip-continues past a mismatched sentinel and completes with the corrected one", async () => {
    const gen = makeDslGenerator();
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) {
        return ["地下室里只亮着终端的一点蓝光。", "@end a81f buffer"]; // stale nonce
      }
      return ["苏遥抬起头。", `@end ${nonce} buffer`];
    });

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;

    expect(create).toHaveBeenCalledTimes(2);
    const assistant = create.mock.calls[1]![0].messages[2] as { role: string; content: string };
    expect(assistant.content).toBe("地下室里只亮着终端的一点蓝光。\n");
    expect(received).toHaveLength(2);
    expect(envelope.segmentEnd).toEqual({
      kind: "complete",
      nonce: expect.any(String),
      reason: "buffer",
    });
  });

  it("strip-continue falls back to the fail path once the budget is spent", async () => {
    const gen = makeDslGenerator();
    // Same broken sentinel on every stream: strip once, then the second
    // mismatch hits the exhausted budget → forwarded prefix + fail.
    mockDslClient(gen, () => [
      "地下室里只亮着终端的一点蓝光。",
      "@end a81f buffer",
    ]);

    const received: EventGroupDraft[] = [];
    const promise = (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });
    await expect(promise).rejects.toThrow(/DSL 流校验失败|SENTINEL_NONCE_MISMATCH/);
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    // The continuation's group also arrived before the fail.
    expect(received).toHaveLength(2);
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

  it("protocolCardText 无 identity 兼容回退与显式 Game 等价 identity 产出同一张卡（C6-port minor 等价测试）", async () => {
    // 生产路径恒传 identity（Game.generationIdentity）；无 identity 的直连
    // 调用（窄测试）从 roster 派生「全体 NPC 可发声 + 全体在场」的兼容
    // cast。断言该回退与显式传入 Game 同源推导的 cast + protocolVersion 1
    // 得到的任务协议卡逐字节一致——两条派生路径不许各自漂移。
    const assets: AssetCatalog = {
      guidance: "",
      backgrounds: {},
      bgm: {},
      soundEffects: {},
      spriteSets: {},
    };
    const registry = createCharacterRegistry(
      buildCharacterRoster({
        schemaVersion: 2,
        scopeId: "llm-card-equiv",
        playerId: "player_one",
        characters: [
          {
            id: "player_one",
            name: "玩家",
            control: "player",
            initialLabel: "你",
            persona: "玩家本人（卡等价向量）。",
          },
          {
            id: "npc_a",
            name: "角色甲",
            control: "npc",
            initialLabel: "角色甲",
            persona: "契约向量角色。",
          },
        ],
      }),
      assets,
    );
    const openingTemplate = makeTestInstructions().opening;

    const runOnce = async (identity?: unknown): Promise<string> => {
      const gen = new StoryGenerator(
        makeTestConfig(),
        makeTestPrompts(),
        makeTestInstructions(),
        DUMMY_API_KEY,
        undefined,
        undefined,
        undefined,
        registry,
      );
      let user = "";
      (gen as any).client = {
        chat: {
          completions: {
            create: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
              user = request.messages[1]!.content as string;
              const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
              return dslStream(["开场旁白。", `@end ${nonce} buffer`]);
            }),
          },
        },
      };
      await (gen as any).generateOpening(1, createInitialState(), undefined, identity);
      // 卡区 = 【任务协议卡：… 至任务模板之前；nonce 逐次不同，归一后再比。
      const start = user.indexOf("【任务协议卡：");
      const end = user.indexOf(openingTemplate);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "";
      return user
        .slice(start, end)
        .split(nonce)
        .join("<nonce>");
    };

    const fallbackCard = await runOnce();
    // 显式 identity = Game.generationIdentity 的 roster 路径同款推导
    //（game.ts：NPC 过滤 + 全体参与者 + config 缺省协议版本 1）。
    const gameEquivalentIdentity = {
      protocolVersion: 1,
      rosterRevision: registry.roster.revision,
      cast: {
        allowedSpeakerIds: registry.roster.characters
          .filter((definition) => definition.control === "npc")
          .map((definition) => definition.id),
        sceneParticipantIds: registry.roster.characters.map((definition) => definition.id),
      },
      characterState: createCharacterRuntimeState(),
    };
    const explicitCard = await runOnce(gameEquivalentIdentity);
    expect(fallbackCard).toBe(explicitCard);
    // 回退不是空卡：示例说话人来自兼容 cast 的首个 NPC（v1 表面用注册名）。
    expect(fallbackCard).toContain("角色甲");
  });
});

// ---------------------------------------------------------------------------
// DSL v2 mode generation — 版本路由的流式解码 + createV2SegmentGate 逐组
// 语义门（main-v2-adapter：dsl.protocol_version=2 的运行时接线；Ruling 16
// per-group gated forwarding + 一次尾部修复）。port 自 campus
// a1b7aac/c41582e/cb7804b 的 llm.test.ts「DSL v2 mode generation」——
// main 无 DslStreamObserver（campus 专属监控缝），观察者断言改为按调用
// 形状（调用次数 / assistant 前缀 / 指令内容）断言，语义不变。
// ---------------------------------------------------------------------------

describe("DSL v2 mode generation", () => {
  const V2_TEST_ASSETS: AssetCatalog = {
    guidance: "",
    backgrounds: { corridor: { id: "corridor", src: "c.jpg", description: "走廊" } },
    bgm: {},
    soundEffects: {},
    spriteSets: {
      female_A: {
        id: "female_A",
        variants: {
          base: { id: "base", src: "a.png", description: "" },
          smile: { id: "smile", src: "a2.png", description: "" },
        },
      },
    },
  };

  /** v2 roster：带 presentation（looks），供 @ch/@name 语义编译。 */
  function v2RosterRegistry(): RosterRegistry {
    return createCharacterRegistry(
      buildCharacterRoster({
        schemaVersion: 2,
        scopeId: "llm-v2-test",
        playerId: "player_one",
        characters: [
          { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
          {
            id: "female_A",
            name: "许晚晴",
            control: "npc",
            initialLabel: "神秘女子",
            persona: "温柔学姐。",
            presentation: {
              defaultLook: "base",
              defaultPosition: "right",
              looks: {
                base: { spriteSet: "female_A", variant: "base" },
                smile: { spriteSet: "female_A", variant: "smile" },
              },
            },
          },
        ],
      }),
      V2_TEST_ASSETS,
    );
  }

  function makeV2Generator(): StoryGenerator {
    const config = makeTestConfig({
      generation: { temperature: 1.0, max_tokens: 500, repair_attempts: 0 },
    });
    return new StoryGenerator(
      config,
      makeTestPrompts(),
      makeTestInstructions(),
      DUMMY_API_KEY,
      undefined,
      undefined,
      V2_TEST_ASSETS,
      v2RosterRegistry(),
    );
  }

  function v2Identity(): GenerationIdentity {
    return {
      protocolVersion: 2,
      rosterRevision: "test-revision",
      cast: {
        allowedSpeakerIds: ["female_A"],
        sceneParticipantIds: ["player_one", "female_A"],
      },
      characterState: { labels: Object.create(null) },
    };
  }

  interface MockTurn {
    stream?: boolean;
    messages: Array<{ role: string; content: string }>;
  }

  /** mock client：流式吐行；stream:false（尾部修复）返回 repairText。 */
  function mockV2Client(
    gen: StoryGenerator,
    lines: (nonce: string) => string[],
    repairText: (nonce: string) => string,
  ): ReturnType<typeof vi.fn> {
    const streamOf = (ls: string[]): AsyncGenerator<unknown> =>
      (async function* () {
        for (const line of ls) {
          yield { choices: [{ delta: { content: `${line}\n` } }] };
        }
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      })();
    const create = vi.fn(async (request: MockTurn) => {
      const user = request.messages.filter((m) => m.role === "user")[0]!.content;
      const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
      if (request.stream === false) {
        return {
          choices: [{ message: { content: repairText(nonce) } }],
        };
      }
      return streamOf(lines(nonce));
    });
    (gen as any).client = { chat: { completions: { create } } };
    return create;
  }

  // -------------------------------------------------------------------------
  // Ruling 16：per-group gated forwarding——组在它自己通过校验的瞬间转发，
  // 不再等整段语义门收尾。消费侧用 GenerationHandle.events（与 Game 泵同
  // 通道）断言「组 1 在段结束前已到达」。
  // -------------------------------------------------------------------------

  it("forwards group 1 while group 2's lines are still arriving (stream-as-you-play parity)", async () => {
    const gen = makeV2Generator();
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let paused = false;
    const create = vi.fn(async (request: MockTurn) => {
      const user = request.messages.filter((m) => m.role === "user")[0]!.content;
      const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
      if (request.stream === false) {
        return { choices: [{ message: { content: "" } }] };
      }
      return (async function* () {
        // 组 1：主事件行到达即闭合（narration）。
        yield { choices: [{ delta: { content: "@n 走廊的灯亮着。\n" } }] };
        // 组 2 的前奏行已到达但组未闭合——流在此暂停。
        yield { choices: [{ delta: { content: "@bg corridor\n" } }] };
        paused = true;
        await streamGate;
        paused = false;
        yield { choices: [{ delta: { content: "@say female_A 你来了。\n" } }] };
        yield { choices: [{ delta: { content: `@end ${nonce} ending\n` } }] };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      })();
    });
    (gen as any).client = { chat: { completions: { create } } };

    const facade = new GeneratorPortFacade(gen);
    const handle = facade.generateOpening({
      turn: 1,
      state: createInitialState(),
      identity: v2Identity(),
    });
    const arrived: AnyStreamedGroup[] = [];
    const consumer = (async () => {
      for await (const group of handle.events) arrived.push(group);
    })();

    // 组 1 在流仍暂停（组 2 未闭合、哨兵未到、段未结束）时已到达消费者。
    // Deadline：逐组转发若被回归破坏，这里按断言失败退出，不无限自旋
    // 挂死整个测试运行（fail by assertion, not hang；campus 9de9bc4）。
    const spinDeadline = Date.now() + 5_000;
    while (arrived.length < 1 && Date.now() < spinDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (arrived.length < 1) {
      // 放行暂停的流并限时收尾（失败路径不再等它推进），随后断言失败。
      releaseStream();
      await Promise.race([
        Promise.all([handle.done, consumer]),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      expect(
        arrived.length,
        "stream-as-you-play parity regression: group 1 never arrived while the stream was paused (5s deadline)",
      ).toBeGreaterThanOrEqual(1);
      return;
    }
    expect(paused).toBe(true);
    expect(arrived).toHaveLength(1);
    expect(arrived[0]!.main).toEqual({ type: "narration", text: "走廊的灯亮着。" });

    releaseStream();
    const envelope = await handle.done;
    await consumer;
    expect(arrived).toHaveLength(2);
    expect(arrived[1]!.main).toMatchObject({ type: "dialogue", characterId: "female_A" });
    expect((arrived[1] as { prelude: Array<Record<string, unknown>> }).prelude).toEqual([
      { type: "background", assetId: "corridor" },
    ]);
    expect(envelope.groups).toHaveLength(2);
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "ending" });
  });

  it("mid-stream semantic failure in group 3: groups 1-2 stay played, repair rewrites the tail only", async () => {
    const gen = makeV2Generator();
    const order: string[] = [];
    const create = vi.fn(async (request: MockTurn) => {
      const user = request.messages.filter((m) => m.role === "user")[0]!.content;
      const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
      if (request.stream === false) {
        order.push("repair-call");
        return {
          choices: [
            {
              message: {
                // 只重写未提交尾部（第 3 行起）：坏 look 组 + 哨兵。
                content: [
                  "@ch female_A show look=smile position=left",
                  "@say female_A 第三句（修复）。",
                  `@end ${nonce} ending`,
                ].join("\n"),
              },
            },
          ],
        };
      }
      return (async function* () {
        for (const line of [
          "@n 走廊的灯亮着。", // 组 1：立即提交转发。
          "@say female_A 第二句。", // 组 2：立即提交转发。
          "@ch female_A show look=bad_look position=left",
          "@say female_A 第三句。", // 组 3 闭合 → UNKNOWN_LOOK → 停流。
          `@end ${nonce} ending`, // 不再消费。
        ]) {
          yield { choices: [{ delta: { content: `${line}\n` } }] };
        }
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      })();
    });
    (gen as any).client = { chat: { completions: { create } } };

    const groups: Array<Record<string, unknown>> = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      identity: v2Identity(),
      onGroup: (group: Record<string, unknown>) => {
        order.push(`group:${(group.main as { type: string }).type}`);
        groups.push(group);
      },
    });

    // 组 1-2 在修复调用之前已转发（边流边播）；修复轮只产出第三个组。
    expect(order).toEqual([
      "group:narration",
      "group:dialogue",
      "repair-call",
      "group:dialogue",
    ]);
    // 恰好一次修复：原流 + 修复，共 2 次 LLM 调用。
    expect(create).toHaveBeenCalledTimes(2);
    const repairRequest = create.mock.calls[1]![0] as MockTurn;
    // 修复调用：assistant 前缀 = 已提交（已播出）的 1-2 行；重写点从第 3 行起。
    const assistant = repairRequest.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("@n 走廊的灯亮着。\n@say female_A 第二句。\n");
    expect(repairRequest.messages.at(-1)!.content).toContain("UNKNOWN_LOOK");
    // 组 1-2 原样保留（未被重写），修复轮补齐第三个组。
    expect(groups).toHaveLength(3);
    expect(groups[0]!.main).toEqual({ type: "narration", text: "走廊的灯亮着。" });
    expect(groups[1]!.main).toMatchObject({ type: "dialogue", text: "第二句。" });
    expect(groups[2]).toMatchObject({
      main: { type: "dialogue", characterId: "female_A", text: "第三句（修复）。" },
    });
    expect(
      (groups[2]!.prelude as Array<{ type: string; variant?: { value: string } }>)[0],
    ).toMatchObject({ type: "character_patch", variant: { op: "set", value: "smile" } });
    expect(envelope.groups).toHaveLength(3);
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "ending" });
  });

  it("structural failure at line 1: nothing forwarded, whole-text repair without assistant prefix", async () => {
    const gen = makeV2Generator();
    const create = mockV2Client(
      gen,
      (nonce) => [
        // v1 台词头：v2 会话下第 1 行即结构错误（UNKNOWN_COMMAND）。
        "许晚晴: 你不该来这里。",
        "@say female_A 你来了。",
        `@end ${nonce} ending`,
      ],
      // 边界为 0：整段都是尾部，修复输出必须自带完整段（含哨兵）。
      (nonce) => ["@say female_A 你来了。", `@end ${nonce} ending`].join("\n"),
    );

    const groups: Array<Record<string, unknown>> = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      identity: v2Identity(),
      onGroup: (group: Record<string, unknown>) => groups.push(group),
    });

    expect(create).toHaveBeenCalledTimes(2);
    const repairRequest = create.mock.calls[1]![0] as MockTurn;
    expect(repairRequest.stream).toBe(false);
    // 无已提交组 → 无 assistant 前缀（campus c41582e 语义在逐组粒度下保持）。
    expect(repairRequest.messages.some((m) => m.role === "assistant")).toBe(false);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.main).toMatchObject({
      type: "dialogue",
      characterId: "female_A",
      text: "你来了。",
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "ending" });
  });

  it("outer user-cancel declines the one tail repair (fail path preserves the played prefix)", async () => {
    const gen = makeV2Generator();
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const create = vi.fn(async (request: MockTurn) => {
      const user = request.messages.filter((m) => m.role === "user")[0]!.content;
      const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
      if (request.stream === false) {
        throw new Error("尾部修复调用不应发生（外层取消必须让修复方返回 null）。");
      }
      return (async function* () {
        yield { choices: [{ delta: { content: "@n 走廊的灯亮着。\n" } }] };
        // 组 1 已提交转发；流在此暂停——取消在此之后、坏行之前落地。
        await streamGate;
        yield { choices: [{ delta: { content: "许晚晴: 你不该来这里。\n" } }] };
        yield { choices: [{ delta: { content: `@end ${nonce} ending\n` } }] };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      })();
    });
    (gen as any).client = { chat: { completions: { create } } };

    const controller = new AbortController();
    const groups: Array<Record<string, unknown>> = [];
    const promise = (gen as any).generateOpening(
      1,
      createInitialState(),
      controller.signal,
      {
        identity: v2Identity(),
        onGroup: (group: Record<string, unknown>) => groups.push(group),
      },
    );

    // 等组 1 到达（确认已提交转发），再取消外层信号并放行坏行。
    while (groups.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();
    releaseStream();

    // 坏行仍触发停流，但修复方守卫看到已取消的外层信号 → 拒绝修复：
    // 走既有失败路径（已转发的组 1 保留），且绝不发起第二次 LLM 调用。
    await expect(promise).rejects.toThrow(/UNKNOWN_COMMAND/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(groups).toHaveLength(1);
  });

  it("routes v2 requests through the v2 sink + compiler (labelOps + displayLabel)", async () => {
    const gen = makeV2Generator();
    mockV2Client(
      gen,
      (nonce) => [
        "@bg corridor",
        "@say female_A 你来了。",
        "@name female_A set 神秘学姐",
        "@say female_A 跟我来。",
        `@end ${nonce} ending`,
      ],
      () => "",
    );

    const groups: Array<Record<string, unknown>> = [];
    const ends: SegmentEndStatus[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      identity: v2Identity(),
      onGroup: (group: Record<string, unknown>) => groups.push(group),
      onSegmentEnd: (status: SegmentEndStatus) => ends.push(status),
    });

    // 分组（§36–§39）：@bg 累积进下一个主事件的组（@say）→ 2 组。
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      prelude: [{ type: "background", assetId: "corridor" }],
      labelOps: [],
      main: { type: "dialogue", characterId: "female_A", displayLabel: "神秘女子" },
    });
    expect(groups[1]).toMatchObject({
      labelOps: [{ characterId: "female_A", label: "神秘学姐" }],
      main: { type: "dialogue", displayLabel: "神秘学姐", text: "跟我来。" },
    });
    expect(ends).toEqual([{ kind: "complete", nonce: expect.any(String), reason: "ending" }]);
    expect(envelope.groups).toHaveLength(2);
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "ending" });
  });

  it("rejects v1 syntax on a v2 request (no silent downgrade to the legacy parser)", async () => {
    const gen = makeV2Generator();
    mockV2Client(gen, () => ["许晚晴: 你不该来这里。", "@end aaaa buffer"], () => "");

    await expect(
      (gen as any).generateOpening(1, createInitialState(), undefined, {
        identity: v2Identity(),
      }),
    ).rejects.toThrow(/UNKNOWN_COMMAND/);
  });

  it("deterministically closes an open v2 form before the interaction sentinel (materialized @/?)", async () => {
    const gen = makeV2Generator();
    // 表单缺 @/?：本地补齐物化进规范文本（语义门重解析看到闭合表单）。
    const create = mockV2Client(
      gen,
      (nonce) => [
        "@? 接下来怎么做？",
        "@+ 跟着她走",
        "@+ 转身离开",
        `@end ${nonce} interaction`,
      ],
      () => "",
    );

    const groups: Array<Record<string, unknown>> = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      identity: v2Identity(),
      onGroup: (group: Record<string, unknown>) => groups.push(group),
    });

    // 确定性补齐不烧 LLM 修复轮：只有一次流式调用。
    expect(create).toHaveBeenCalledTimes(1);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.main).toMatchObject({
      type: "interaction",
      interaction: { mode: "choice", prompt: "接下来怎么做？" },
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
  });

  it("runs exactly one tail repair on a v2 protocol error and adopts the fixed tail", async () => {
    const gen = makeV2Generator();
    const create = mockV2Client(
      gen,
      (nonce) => [
        "@n 走廊的灯亮着。",
        "@ch female_A show look=bad_look position=left",
        "@say female_A 你来了。",
        `@end ${nonce} ending`,
      ],
      (nonce) =>
        [
          "@ch female_A show look=smile position=left",
          "@say female_A 你来了。",
          `@end ${nonce} ending`,
        ].join("\n"),
    );

    const groups: Array<Record<string, unknown>> = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      identity: v2Identity(),
      onGroup: (group: Record<string, unknown>) => groups.push(group),
    });

    // 恰好一次尾部修复：原流 + 修复调用，共 2 次 LLM 请求。
    expect(create).toHaveBeenCalledTimes(2);
    const repairRequest = create.mock.calls[1]![0] as MockTurn;
    expect(repairRequest.stream).toBe(false);
    // 修复调用：assistant = 已提交前缀（第一行旁白），user = 修复指令。
    const assistant = repairRequest.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("@n 走廊的灯亮着。\n");
    const instruction = repairRequest.messages.at(-1)!;
    expect(instruction.content).toContain("UNKNOWN_LOOK");
    // 原子性：坏组（@ch + @say）整体不落地，修复后重写尾部的组被采纳。
    expect(groups).toHaveLength(2);
    expect(groups[0]!.main).toMatchObject({ type: "narration", text: "走廊的灯亮着。" });
    expect(groups[1]).toMatchObject({
      labelOps: [],
      main: { type: "dialogue", characterId: "female_A", displayLabel: "神秘女子", text: "你来了。" },
    });
    expect((groups[1]!.prelude as Array<{ type: string; variant?: { value: string } }>)[0]).toMatchObject({
      type: "character_patch",
      variant: { op: "set", value: "smile" },
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "ending" });
  });

  it("repairs a structural (v1-syntax) line once in a v2 session and adopts the corrected output", async () => {
    const gen = makeV2Generator();
    const create = mockV2Client(
      gen,
      (nonce) => [
        "@n 走廊的灯亮着。",
        // v1 台词头语法：v2 请求下是结构错误（UNKNOWN_COMMAND），中段触发。
        "许晚晴: 你不该来这里。",
        "@say female_A 你来了。",
        `@end ${nonce} ending`,
      ],
      // 修复输出：只重写未提交尾部（第 2 行起）——Ruling 16 逐组转发下，
      // 第 1 行的旁白组已在结构错误前提交转发，不可（也不必）重写。
      // 适配记录：原断言「结构错误重置提交边界为 0、修复不带 assistant
      // 前缀」随批式门（解析在全段分组之前）一并退役；行 1 结构错误仍
      // 边界为 0（见「structural failure at line 1」测试钉住）。
      (nonce) => ["@say female_A 你来了。", `@end ${nonce} ending`].join("\n"),
    );

    const groups: Array<Record<string, unknown>> = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      identity: v2Identity(),
      onGroup: (group: Record<string, unknown>) => groups.push(group),
    });

    // 结构失败同样获得恰好一次尾部修复（campus v2decode review Important）：
    // 原流 + 修复共 2 次调用——停流用的 abort 不泄漏进修复阶段。
    expect(create).toHaveBeenCalledTimes(2);
    const repairRequest = create.mock.calls[1]![0] as MockTurn;
    expect(repairRequest.stream).toBe(false);
    // 提交边界 = 已转发的第 1 行（旁白组）：修复调用带该 assistant 前缀，
    // 只重写其后的坏行尾部。
    const assistant = repairRequest.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("@n 走廊的灯亮着。\n");
    // 已提交的旁白组原样保留；修复轮补写对白（displayLabel = initialLabel）。
    expect(groups).toHaveLength(2);
    expect(groups[0]!.main).toMatchObject({ type: "narration", text: "走廊的灯亮着。" });
    expect(groups[1]!.main).toMatchObject({
      type: "dialogue",
      characterId: "female_A",
      displayLabel: "神秘女子",
      text: "你来了。",
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "ending" });
  });

  it("fails through the existing failure path when the repaired tail is still invalid", async () => {
    const gen = makeV2Generator();
    const create = mockV2Client(
      gen,
      (nonce) => [
        "@n 走廊的灯亮着。",
        "@ch female_A show look=bad_look position=left",
        "@say female_A 你来了。",
        `@end ${nonce} ending`,
      ],
      (nonce) =>
        [
          "@ch female_A show look=still_bad position=left",
          "@say female_A 你来了。",
          `@end ${nonce} ending`,
        ].join("\n"),
    );

    const groups: Array<Record<string, unknown>> = [];
    await expect(
      (gen as any).generateOpening(1, createInitialState(), undefined, {
        identity: v2Identity(),
        onGroup: (group: Record<string, unknown>) => groups.push(group),
      }),
    ).rejects.toThrow(/UNKNOWN_LOOK/);

    // 双败：修复只试一次（共 2 次调用），已提交前缀照旧转发。
    expect(create).toHaveBeenCalledTimes(2);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.main).toMatchObject({ type: "narration", text: "走廊的灯亮着。" });
  });

  it("autocloses a naturally-stopped single-reason v2 stream that omitted the sentinel", async () => {
    const gen = makeV2Generator();
    const create = mockV2Client(
      gen,
      // input_bridge 是单理由任务（buffer）；自然结束但漏哨兵 → 本地补齐。
      () => ["@n 走廊恢复安静。"],
      () => "",
    );

    const groups: Array<Record<string, unknown>> = [];
    const interaction: InteractionEvent = {
      type: "interaction",
      interaction_id: "interaction_1",
      mode: "input",
      prompt: "你想说什么？",
      input: { kind: "free_text", placeholder: "……", max_length: 100 },
    };
    const envelope = await (gen as any).generateInputBridge(
      1,
      createInitialState(),
      interaction,
      undefined,
      {
        identity: v2Identity(),
        onGroup: (group: Record<string, unknown>) => groups.push(group),
      },
    );

    expect(create).toHaveBeenCalledTimes(1); // 不烧修复轮
    expect(groups).toHaveLength(1);
    expect(groups[0]!.main).toMatchObject({ type: "narration", text: "走廊恢复安静。" });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "buffer" });
  });

  it("fails loudly when a v2 identity arrives without a roster registry", async () => {
    const gen = makeTestGenerator();
    mockV2Client(gen, (nonce) => ["@say female_A 你来了。", `@end ${nonce} buffer`], () => "");

    await expect(
      (gen as any).generateOpening(1, createInitialState(), undefined, {
        identity: v2Identity(),
      }),
    ).rejects.toThrow(/registry/);
  });
});
