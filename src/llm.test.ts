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
import type { DslStreamObserver, WriterPromptReport } from "./core/ports/dsl-stream-observer.js";
import { Metrics } from "./runtime/metrics.js";

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
    continuation:
      "以下预取片段已固定：\n{prefetched}\n请继续生成完整剧情段。长度上限：本次最多输出 {target_lines} 条文本行。",
    input_bridge: "当前交互点：{interaction_prompt}\n生成 1–2 条 narration 作为场景过渡。",
    recovery:
      "任务：修复收尾（task_type=recovery）。上一次输出被拒绝：{repair_reason}\n你上一段输出的原始尾部：\n{raw_tail}\n已固定前缀：\n{prefetched}\n哨兵：@end {nonce} buffer/interaction/ending。",
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
        "[交互] 怎么回应？",
      ].join("\n"),
    );
    expect(out).not.toContain("line_id");
    expect(out).not.toContain("seq");
    // choice/end 机器事件仍被跳过（docs §69）。
    expect(out).not.toContain("choice");
    expect(out).not.toContain("end");
  });

  it("serializeStoryContext truncates and normalizes interaction prompts", () => {
    const longPrompt = "很长的题干".repeat(40);
    const out = serializeStoryContext([
      {
        type: "interaction",
        interaction_id: "i1",
        prompt: `  第一问\n  第二问  ${longPrompt}  `,
        mode: "choice",
        options: [
          { id: "a", text: "好" },
          { id: "b", text: "不" },
        ],
      },
    ]);
    expect(out).toBe(`[交互] 第一问 第二问 ${"很长的题干".repeat(14)}很长…`);
    expect(out.length).toBeLessThan(120);
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
    const roster = {
      suyao: {
        scriptName: "苏遥",
        displayName: "苏遥",
        spriteSet: "suyao",
        defaultVariant: "normal",
        defaultPosition: "left" as const,
        allowedSpriteSets: ["suyao"],
      },
      yuki: {
        scriptName: "由纪",
        displayName: "由纪",
        spriteSet: "yuki",
        defaultVariant: "normal",
        defaultPosition: "right" as const,
        allowedSpriteSets: ["yuki"],
      },
      kaito: {
        scriptName: "海斗",
        displayName: "海斗",
        spriteSet: "male_A",
        defaultVariant: "base",
        defaultPosition: "far_left" as const,
        allowedSpriteSets: ["male_A"],
      },
    };
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
    expect(prompt).toContain("本次续写行数上限：6");
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
    observer?: DslStreamObserver,
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
      undefined,
      undefined,
      undefined,
      observer,
    );
  }

  function dslStream(lines: string[], finishReason?: string): AsyncGenerator<unknown> {
    return (async function* () {
      for (const line of lines) {
        yield { choices: [{ delta: { content: `${line}\n` } }] };
      }
      // Final SSE chunk carrying the end-of-stream signal (no content).
      if (finishReason !== undefined) {
        yield { choices: [{ delta: {}, finish_reason: finishReason }] };
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

  it("emits a cancelled attempt end when the stream aborts mid-request", async () => {
    const onAttemptEnd = vi.fn();
    const gen = makeDslGenerator(undefined, {
      onAttemptStart: vi.fn(),
      onDelta: vi.fn(),
      onLine: vi.fn(),
      onGroup: vi.fn(),
      onAttemptEnd,
    } as any);
    // Transport-level abort: the SDK call itself dies with an AbortError.
    (gen as any).client = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw new DOMException("The operation was aborted.", "AbortError");
          }),
        },
      },
    };
    const controller = new AbortController();
    await expect(
      gen.generateOpening(1, createInitialState(), controller.signal),
    ).rejects.toThrow();
    expect(onAttemptEnd).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ state: "cancelled" }),
    );
  });

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
    expect(envelope.state_patch).toEqual({});
    expect(envelope.groups).toHaveLength(2);
    expect(envelope.segmentEnd).toEqual({
      kind: "complete",
      nonce: expect.any(String),
      reason: "interaction",
    });
  });

  it("repairs a missing end keyword and closes a complete interaction form", async () => {
    const repairs: Array<{ kind: string; lineIndex: number; message: string }> = [];
    const observer = {
      onAttemptStart: vi.fn(),
      onDelta: vi.fn(),
      onLine: vi.fn(),
      onGroup: vi.fn(),
      onRepair: vi.fn((_attemptId: string, repair: (typeof repairs)[number]) => repairs.push(repair)),
      onUsage: vi.fn(),
      onAttemptEnd: vi.fn(),
    } as DslStreamObserver;
    const gen = makeDslGenerator(undefined, observer);
    mockDslClient(gen, (nonce) => [
      "@? 你要怎么接话？",
      "@+ 凑过去看那张纸片，先别撕",
      "@+ 问这挂件是在哪儿捡到的",
      "@= 你想说点什么",
      `@ ${nonce} interaction`,
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
    expect(received[0]?.source).toEqual({
      attemptId: expect.stringContaining("opening-"),
      lineIndex: 1,
    });
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
    expect(repairs.map((repair) => repair.kind)).toEqual(["end_keyword", "form_close"]);
    expect(repairs.map((repair) => repair.lineIndex)).toEqual([5, 5]);
    expect(observer.onUsage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ source: "estimated", input: expect.any(Number), output: expect.any(Number) }),
    );
  });

  it("repairs an empty @? into the form end while a form is open", async () => {
    const repairs: Array<{ kind: string; lineIndex: number; message: string }> = [];
    const observer = {
      onAttemptStart: vi.fn(),
      onDelta: vi.fn(),
      onLine: vi.fn(),
      onGroup: vi.fn(),
      onRepair: vi.fn((_attemptId: string, repair: (typeof repairs)[number]) => repairs.push(repair)),
      onUsage: vi.fn(),
      onAttemptEnd: vi.fn(),
    } as DslStreamObserver;
    const gen = makeDslGenerator(undefined, observer);
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
    expect(repairs.map((repair) => repair.kind)).toEqual(["form_close"]);
    expect(repairs[0]?.message).toContain("空提示");
  });

  it("does not repair a loose terminal with the wrong nonce", async () => {
    const repairs: Array<{ kind: string; lineIndex: number; message: string }> = [];
    const observer = {
      onAttemptStart: vi.fn(),
      onDelta: vi.fn(),
      onLine: vi.fn(),
      onGroup: vi.fn(),
      onRepair: vi.fn((_attemptId: string, repair: (typeof repairs)[number]) => repairs.push(repair)),
      onUsage: vi.fn(),
      onAttemptEnd: vi.fn(),
    } as DslStreamObserver;
    const gen = makeDslGenerator(undefined, observer);
    // Continuation replays the same broken content: the budget runs out and
    // the attempt fails — but no end_keyword repair may ever fire for a
    // nonce that cannot match.
    mockDslClient(gen, () => ["@? 怎么回应？", "@+ 先看看", "@ dead interaction"]);

    await expect(
      (gen as any).generateOpening(1, createInitialState()),
    ).rejects.toThrow(/连续校验失败|EMPTY_FORM_PROMPT|UNKNOWN_COMMAND/);
    expect(repairs.map((repair) => repair.kind)).not.toContain("end_keyword");
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
    const repairs: Array<{ kind: string; message: string }> = [];
    const observer = {
      onAttemptStart: vi.fn(),
      onDelta: vi.fn(),
      onLine: vi.fn(),
      onGroup: vi.fn(),
      onRepair: vi.fn((_a: string, repair: (typeof repairs)[number]) => repairs.push(repair)),
      onUsage: vi.fn(),
      onAttemptEnd: vi.fn(),
    } as DslStreamObserver;
    const gen = makeDslGenerator(undefined, observer);
    mockDslClient(gen, (nonce) => [
      "树莓娘正等你接话，同学乙拎着包也没动。",
      "@?",
      "你打算怎么办？",
      "@+ 坐树莓娘旁边",
      "@+ 直接去第一排",
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
    expect(received[0]!.main).toEqual({ type: "narration", text: "树莓娘正等你接话，同学乙拎着包也没动。" });
    expect(received[1]!.main).toMatchObject({
      type: "interaction",
      interaction: { mode: "choice", prompt: "你打算怎么办？" },
    });
    expect(repairs.map((repair) => repair.kind)).toContain("form_prompt_merge");
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

  // -------------------------------------------------------------------------
  // onPrompt — monitor audit invariant: joining a report's message segments
  // must reproduce the exact content that went over the wire.
  // -------------------------------------------------------------------------

  it("reports the exact prompt payload per attempt, before any delta", async () => {
    const reports: WriterPromptReport[] = [];
    const order: string[] = [];
    const observer = {
      onAttemptStart: vi.fn(() => order.push("start")),
      onPrompt: vi.fn((report: WriterPromptReport) => {
        order.push("prompt");
        reports.push(report);
      }),
      onDelta: vi.fn(() => order.push("delta")),
      onLine: vi.fn(),
      onGroup: vi.fn(),
      onAttemptEnd: vi.fn(),
    } as unknown as DslStreamObserver;
    const gen = makeDslGenerator(undefined, observer);
    mockDslClient(gen, (nonce) => [
      "地下室里只亮着终端的一点蓝光。",
      `@end ${nonce} buffer`,
    ]);

    await gen.generateOpening(1, createInitialState());
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;
    const sent = create.mock.calls[0]![0].messages as Array<{ role: string; content: string }>;

    expect(reports).toHaveLength(1);
    expect(reports[0]!.requestIndex).toBe(0);
    // Fires between onAttemptStart and the first delta.
    expect(order.indexOf("prompt")).toBeGreaterThan(order.indexOf("start"));
    expect(order.indexOf("prompt")).toBeLessThan(order.indexOf("delta"));

    const messages = reports[0]!.messages;
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    // Audit invariant: joined segments === sent bytes, for every message.
    for (const [index, message] of messages.entries()) {
      expect(message.segments.map((segment) => segment.text).join("")).toBe(sent[index]!.content);
    }
    // Origins are labeled: static prompt files in system, task template in user.
    expect(messages[0]!.segments.map((segment) => segment.source)).toContain(
      "prompts/characters.txt",
    );
    expect(messages[1]!.segments.map((segment) => segment.source)).toContain(
      "prompts/instructions.yaml#opening",
    );
  });

  it("reports the repair instruction as its own segment on retry attempts", async () => {
    const reports: WriterPromptReport[] = [];
    const observer = {
      onAttemptStart: vi.fn(),
      onPrompt: vi.fn((report: WriterPromptReport) => reports.push(report)),
      onDelta: vi.fn(),
      onLine: vi.fn(),
      onGroup: vi.fn(),
      onAttemptEnd: vi.fn(),
    } as unknown as DslStreamObserver;
    const gen = makeDslGenerator({ generation: { repair_attempts: 1 } }, observer);
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) return ["@end bbbb buffer"]; // wrong nonce → retry
      return ["地下室里只亮着终端的一点蓝光。", `@end ${nonce} buffer`];
    });

    await gen.generateOpening(1, createInitialState());
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;
    const retryUser = create.mock.calls[1]![0].messages[1].content as string;

    expect(reports).toHaveLength(2);
    const retryReport = reports[1]!;
    const repairSegment = retryReport.messages[1]!.segments.at(-1)!;
    expect(repairSegment.source).toBe("runtime/repair");
    expect(repairSegment.label).toContain("修复指令");
    // Byte-exact including the repair tail.
    expect(retryReport.messages[1]!.segments.map((segment) => segment.text).join("")).toBe(
      retryUser,
    );
  });

  it("reports strip-continue follow-ups as a second request with the assistant prefix", async () => {
    const reports: WriterPromptReport[] = [];
    const observer = {
      onAttemptStart: vi.fn(),
      onPrompt: vi.fn((report: WriterPromptReport) => reports.push(report)),
      onDelta: vi.fn(),
      onLine: vi.fn(),
      onGroup: vi.fn(),
      onAttemptEnd: vi.fn(),
    } as unknown as DslStreamObserver;
    const gen = makeDslGenerator(undefined, observer);
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) return ["地下室里只亮着终端的一点蓝光。", "@?"];
      return ["@? 怎么回应？", "@+ 暂时停手", `@end ${nonce} interaction`];
    });

    await gen.generateOpening(1, createInitialState());
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;
    const continuationMessages = create.mock.calls[1]![0]
      .messages as Array<{ role: string; content: string }>;

    expect(reports.map((report) => report.requestIndex)).toEqual([0, 1]);
    const followUp = reports[1]!;
    expect(followUp.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(followUp.messages[2]!.segments[0]!.source).toBe("writer-output/prefix");
    expect(followUp.messages[3]!.segments[0]!.source).toBe("runtime/strip-continue");
    // Audit invariant holds for every message of the follow-up request.
    for (const [index, message] of followUp.messages.entries()) {
      expect(message.segments.map((segment) => segment.text).join("")).toBe(
        continuationMessages[index]!.content,
      );
    }
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
    // 白名单新码（RETIRED_ALIAS）：裸 bg 行剔除后续写改写成 @bg 形式。
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

  it("strip-continues an @ending written before the sentinel", async () => {
    // 白名单新码（ENDING_EPILOGUE_ORPHAN）：哨兵前 @ending 剔除后续写，
    // 模型把 @ending 放到 @end ending 之后。
    const gen = makeDslGenerator();
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) {
        return ["故事在这里停住。", "@ending HE 樱花落幕", `@end ${nonce} ending`];
      }
      return ["她合上笔记本。", `@end ${nonce} ending`, "@ending HE 樱花落幕"];
    });

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: (group: EventGroupDraft) => received.push(group),
    });
    const create = (gen as any).client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    const assistant = create.mock.calls[1]![0].messages[2] as { role: string; content: string };
    expect(assistant.content).not.toContain("@ending");
    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "ending" });
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

  it("strip-continues a bare @? followed by the interaction sentinel", async () => {
    // 2026-09-17 真实会话形状（监控 21:25 截图）：正文 → 裸 @? → 直接收
    // @end interaction。延迟行的"下一行不是旁白"分支必须走剔除续写，
    // 而不是 fail 掉整段（那会让修复链等玩家读完所有保留事件）。
    const gen = makeDslGenerator();
    let callCount = 0;
    mockDslClient(gen, (nonce) => {
      callCount += 1;
      if (callCount === 1) {
        return [
          "苏遥把纸片折好塞进口袋。",
          "树莓娘[center]: 你看到她写的什么了吗？",
          "@?",
          `@end ${nonce} interaction`,
        ];
      }
      return [
        "@? 你打算怎么接这个话头？",
        "@+ 直接问她写的是什么",
        "@= 自己说一句",
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
    expect(assistant.content).toContain("树莓娘[center]: 你看到她写的什么了吗？");
    expect(assistant.content).not.toContain("@?");
    expect(received).toHaveLength(3);
    expect(received[2]!.main).toMatchObject({
      type: "interaction",
      interaction: { mode: "hybrid", prompt: "你打算怎么接这个话头？" },
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

  it("attaches the raw output tail to Game-level fail errors (wrap-up input)", async () => {
    const gen = makeDslGenerator();
    mockDslClient(gen, () => [
      "地下室里只亮着终端的一点蓝光。",
      "她抬起了手，话说到一半",
      // no sentinel → truncated with forwarded groups
    ]);

    const promise = (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: () => undefined,
    });
    const error = (await promise.catch((failure: unknown) => failure)) as Error & {
      rawTail?: string;
    };
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/没有 @end 哨兵/);
    // 尾部原文逐字保留（收尾模式补残句的模型输入）。
    expect(error.rawTail).toContain("她抬起了手，话说到一半");
    expect(error.rawTail).toContain("地下室里只亮着终端的一点蓝光。");
  });

  it("applies the remaining line budget to the continuation template and task header", async () => {
    const gen = makeDslGenerator();
    let capturedUser = "";
    (gen as any).client = {
      chat: {
        completions: {
          create: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
            capturedUser = request.messages[1]!.content as string;
            const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(capturedUser)?.[1] ?? "aaaa";
            return dslStream(["续写一句。", `@end ${nonce} buffer`]);
          }),
        },
      },
    };
    const prefetched = [
      { type: "narration", text: "已固定前缀句。", line_id: "l-1", seq: 1 },
    ] as unknown as Parameters<(typeof gen)["generateContinuation"]>[2];

    await (gen as any).generateContinuation(2, createInitialState(), [], prefetched, undefined, {
      repairReason: "上一段输出被截断。",
      remainingLines: 3,
    });

    // 模板与任务头都用剩余预算（3），不用全额 text_buffer.target_lines。
    expect(capturedUser).toContain("本次最多输出 3 条文本行");
    expect(capturedUser).toContain("本次续写行数上限：3");
    // 预算模式仍走 continuation 模板，不进收尾模式。
    expect(capturedUser).not.toContain("task_type=recovery");
    expect(capturedUser).not.toContain("本次最多输出 6 条文本行");
  });

  it("switches to the recovery wrap-up template at zero remaining budget", async () => {
    const gen = makeDslGenerator();
    let capturedUser = "";
    (gen as any).client = {
      chat: {
        completions: {
          create: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
            capturedUser = request.messages[1]!.content as string;
            const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(capturedUser)?.[1] ?? "aaaa";
            return dslStream([
              "@? 现在怎么办？",
              "@+ 先离开这里",
              "@+ 继续追问",
              "@/?",
              `@end ${nonce} interaction`,
            ]);
          }),
        },
      },
    };

    const envelope = await (gen as any).generateContinuation(
      2,
      createInitialState(),
      [],
      [],
      undefined,
      {
        repairReason: "上一段输出被截断。",
        remainingLines: 0,
        rawTail: "她抬起了手，话说到一半",
      },
    );

    expect(envelope.segmentEnd).toMatchObject({ kind: "complete", reason: "interaction" });
    // 收尾模式：recovery 模板 + 原始尾部 + 零预算任务头，不再主动续写。
    expect(capturedUser).toContain("任务：修复收尾（task_type=recovery）");
    expect(capturedUser).toContain("她抬起了手，话说到一半");
    expect(capturedUser).toContain("本次续写行数上限：0（正文预算已用尽，只收尾，不推进剧情）");
    expect(capturedUser).not.toContain("任务：主动续写");
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

  // -------------------------------------------------------------------------
  // Deterministic sentinel autoclose (E2, 2026-09-18)
  // -------------------------------------------------------------------------

  /** Client mock whose stream ends with an explicit finish_reason. */
  function mockFinishDslClient(
    gen: StoryGenerator,
    lines: string[],
    finishReason: string,
  ): void {
    (gen as any).client = {
      chat: {
        completions: {
          create: vi.fn(async () => dslStream(lines, finishReason)),
        },
      },
    };
  }

  const bridgeInteraction: InteractionEvent = {
    type: "interaction",
    interaction_id: "int_1",
    prompt: "你想说什么？",
    mode: "input",
    input: { kind: "free_text", placeholder: "...", max_length: 200 },
  };

  it("autocloses a naturally-stopped single-reason stream that omitted the sentinel", async () => {
    const repairs: Array<{ kind: string; message: string }> = [];
    const gen = makeDslGenerator(undefined, {
      onAttemptStart: vi.fn(),
      onDelta: vi.fn(),
      onLine: vi.fn(),
      onGroup: vi.fn(),
      onRepair: (_id: string, repair: { kind: string; message: string }) => repairs.push(repair),
      onAttemptEnd: vi.fn(),
    } as any);
    mockFinishDslClient(gen, ["她静静地看着你。", "窗外的光又暗了一格。"], "stop");

    const received: EventGroupDraft[] = [];
    const envelope = await (gen as any).generateInputBridge(
      1,
      createInitialState(),
      bridgeInteraction,
      undefined,
      { onGroup: (group: EventGroupDraft) => received.push(group) },
    );

    // 2 narration groups survive; the segment completes as buffer.
    expect(received).toHaveLength(2);
    expect(envelope.segmentEnd).toEqual({
      kind: "complete",
      nonce: expect.any(String),
      reason: "buffer",
    });
    const autoclose = repairs.find((repair) => repair.kind === "sentinel_autoclose");
    expect(autoclose).toBeDefined();
    expect(autoclose!.message).toMatch(/@end [0-9a-f]{4} buffer/);
  });

  it("does not autoclose a budget-truncated stream (finish_reason=length)", async () => {
    const gen = makeDslGenerator();
    mockFinishDslClient(gen, ["她静静地看着你。", "窗外的光又暗了一格。"], "length");

    const promise = (gen as any).generateInputBridge(
      1,
      createInitialState(),
      bridgeInteraction,
      undefined,
      { onGroup: () => undefined },
    );
    await expect(promise).rejects.toThrow(/没有 @end 哨兵/);
  });

  it("does not autoclose multi-reason tasks even on natural stop", async () => {
    const gen = makeDslGenerator();
    mockFinishDslClient(gen, ["地下室里只亮着终端的一点蓝光。"], "stop");

    const promise = (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: () => undefined,
    });
    // opening 允许 interaction/buffer/ending 多种收束理由——reason 承载语义，
    // 不替模型决定，维持 fail。
    await expect(promise).rejects.toThrow(/没有 @end 哨兵/);
  });

  // -------------------------------------------------------------------------
  // Thinking mode (DeepSeek reasoning_content / reasoning_effort)
  // -------------------------------------------------------------------------

  it("keeps reasoning_content deltas out of the DSL stream and reports thinking usage", async () => {
    const onDelta = vi.fn();
    const onUsage = vi.fn();
    const reasoningA = "先想一下场景。";
    const reasoningB = "再想一下语法。";
    const gen = makeDslGenerator(
      {
        generation: {
          temperature: 1.0,
          max_tokens: 500,
          repair_attempts: 0,
          thinking: { type: "enabled", effort: "low" },
        },
      },
      {
        onAttemptStart: vi.fn(),
        onDelta,
        onLine: vi.fn(),
        onGroup: vi.fn(),
        onAttemptEnd: vi.fn(),
        onUsage,
      } as DslStreamObserver,
    );
    (gen as any).client = {
      chat: {
        completions: {
          create: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
            const user = request.messages[1]!.content as string;
            const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(user)?.[1] ?? "aaaa";
            return (async function* () {
              yield { choices: [{ delta: { reasoning_content: reasoningA } }] };
              yield { choices: [{ delta: { reasoning_content: reasoningB } }] };
              for (const line of ["她静静地看着你。", `@end ${nonce} buffer`]) {
                yield { choices: [{ delta: { content: `${line}\n` } }] };
              }
              yield {
                choices: [],
                usage: {
                  prompt_tokens: 36,
                  completion_tokens: 209,
                  completion_tokens_details: { reasoning_tokens: 189 },
                },
              };
            })();
          }),
        },
      },
    };

    const envelope = await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: vi.fn(),
    });
    expect(envelope.groups.length).toBe(1);
    // Reasoning never leaks into the content deltas (DSL grammar safety).
    const deltaText = onDelta.mock.calls.map((call) => call[1]).join("");
    expect(deltaText).not.toContain("先想一下");
    expect(deltaText).toContain("她静静地看着你。");
    // Usage carries the api-reported thinking numbers.
    expect(onUsage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        reasoningTokens: 189,
        reasoningChars: reasoningA.length + reasoningB.length,
        thinkingMs: expect.any(Number),
      }),
    );
  });

  it("maps thinking config onto top-level request-body fields", async () => {
    const disabled = makeDslGenerator();
    mockDslClient(disabled, (nonce) => ["她静静地看着你。", `@end ${nonce} buffer`]);
    await (disabled as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: vi.fn(),
    });
    const disabledBody = ((disabled as any).client.chat.completions.create as ReturnType<
      typeof vi.fn
    >).mock.calls[0]![0] as Record<string, unknown>;
    expect(disabledBody.thinking).toEqual({ type: "disabled" });
    expect("reasoning_effort" in disabledBody).toBe(false);

    const enabled = makeDslGenerator({
      generation: { temperature: 1.0, max_tokens: 500, repair_attempts: 0, thinking: { type: "enabled", effort: "low" } },
    });
    mockDslClient(enabled, (nonce) => ["她静静地看着你。", `@end ${nonce} buffer`]);
    await (enabled as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: vi.fn(),
    });
    const enabledBody = ((enabled as any).client.chat.completions.create as ReturnType<
      typeof vi.fn
    >).mock.calls[0]![0] as Record<string, unknown>;
    expect(enabledBody.thinking).toEqual({ type: "enabled" });
    expect(enabledBody.reasoning_effort).toBe("low");
  });

  it("counts DSL repairs and attempt outcomes into Metrics via the observer tap", async () => {
    const metrics = new Metrics();
    const config = makeTestConfig({
      generation: {
        temperature: 1.0,
        max_tokens: 500,
        repair_attempts: 0,
        max_consecutive_repairs: 2,
        thinking: { type: "disabled" },
      },
    });
    const gen = new StoryGenerator(
      config,
      makeTestPrompts(),
      makeTestInstructions(),
      DUMMY_API_KEY,
      undefined,
      metrics,
      undefined,
      {
        onAttemptStart: vi.fn(),
        onDelta: vi.fn(),
        onLine: vi.fn(),
        onGroup: vi.fn(),
        onAttemptEnd: vi.fn(),
      } as DslStreamObserver,
    );
    // Missing "end" keyword + missing @/? → end_keyword + form_close repairs.
    mockDslClient(gen, (nonce) => [
      "@? 你要怎么接话？",
      "@+ 凑过去看那张纸片，先别撕",
      "@+ 问这挂件是在哪儿捡到的",
      "@= 你想说点什么",
      `@ ${nonce} interaction`,
    ]);

    await (gen as any).generateOpening(1, createInitialState(), undefined, {
      onGroup: vi.fn(),
    });

    const snap = metrics.snapshot();
    expect(snap.writer.repairs.total).toBe(2);
    expect(snap.writer.repairs.by_kind).toEqual({ end_keyword: 1, form_close: 1 });
    expect(snap.writer.outcomes.done).toBe(1);
    expect(snap.llm.ttft_ms.samples).toBe(1);
  });
});
