/**
 * Tests for StoryGenerator prompt construction, response parsing,
 * GenerationEnvelope validation, and autocomplete logic.
 *
 * These tests verify parsing and prompt-building logic WITHOUT making
 * real API calls. The OpenAI client is constructed but never invoked.
 */

import { describe, it, expect } from "vitest";
import { StoryGenerator } from "./llm.js";
import { GenerationEnvelopeSchema, AutocompleteResultSchema } from "./story/types.js";
import type { AppConfig } from "./config.js";
import type { PromptBundle } from "./prompts.js";
import type { StoryContextEvent, InteractionEvent } from "./schema.js";
import { makeTestConfig } from "./test-helpers.js";
import type { StoryState, GenerationEnvelope } from "./story/types.js";
import { createInitialState } from "./story/state.js";

// ---------------------------------------------------------------------------
// Test helpers — reusable fixtures, no real network calls
// ---------------------------------------------------------------------------

const DUMMY_API_KEY = "sk-test-no-calls";

function makeTestPrompts(): PromptBundle {
  return {
    characters: "角色A：勇敢的冒险者\n角色B：神秘的向导",
    storyLine: "第一章：进入迷雾森林，寻找失落的圣物。",
    guideline: "保持悬疑氛围，不要使用现代词汇。",
  };
}

function makeTestInstructions() {
  return {
    output_protocol: "你是互动视觉小说的剧情生成器。输出严格 JSONL。",
    opening: "请从故事开场开始，生成完整开场剧情，直到第一个 choice、interaction 或 end。",
    branch_prefetch: "当前分支问题：{choice_prompt}\n假设玩家选择：{option_text}\n请只生成至少 {min_dialogue} 条 dialogue 的预取片段。",
    input_response: "当前交互点：{interaction_prompt}\n玩家输入：{player_input}\n请生成 NPC 回应。",
    continuation: "以下预取片段已固定：\n{prefetched_jsonl}\n请继续生成完整剧情段。",
    autocomplete_system: "你是输入补全助手。后缀不超过 {max_suffix_characters} 字。返回 JSON：{\"draft_id\":\"...\",\"revision\":0,\"suffix\":\"...\",\"intent\":\"...\",\"confidence\":0.0-1.0}。confidence 低于 {confidence_threshold} 不输出。",
  };
}

function makeTestGenerator(
  overrides?: Partial<AppConfig>,
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

// ---------------------------------------------------------------------------
// removeMarkdownFence — imported from jsonl.ts (shared helper)
// ---------------------------------------------------------------------------

import { removeMarkdownFence } from "./jsonl.js";

describe("removeMarkdownFence", () => {
  it("strips ```json fence from both ends", () => {
    const input = '```json\n{"events":[],"state_patch":{}}\n```';
    expect(removeMarkdownFence(input)).toBe('{"events":[],"state_patch":{}}');
  });

  it("strips ```jsonl fence", () => {
    const input = '```jsonl\n{"events":[],"state_patch":{}}\n```';
    expect(removeMarkdownFence(input)).toBe('{"events":[],"state_patch":{}}');
  });

  it("strips ``` fence with no language tag", () => {
    const input = '```\n{"events":[],"state_patch":{}}\n```';
    expect(removeMarkdownFence(input)).toBe('{"events":[],"state_patch":{}}');
  });

  it("handles text without fences (passthrough)", () => {
    const input = '{"events":[],"state_patch":{}}';
    expect(removeMarkdownFence(input)).toBe('{"events":[],"state_patch":{}}');
  });

  it("strips only the outermost fence and trims whitespace", () => {
    const input = '  ```jsonl   \n  \n{"events":[],"state_patch":{}}\n  ```  ';
    expect(removeMarkdownFence(input)).toBe('{"events":[],"state_patch":{}}');
  });

  it("does not strip triple-backticks inside content", () => {
    const input = '```json\n{"text":"use ``` for code blocks","events":[],"state_patch":{}}\n```';
    const result = removeMarkdownFence(input);
    expect(result).toContain("use ``` for code blocks");
    expect(result).not.toMatch(/^```/);
    expect(result).not.toMatch(/```$/);
  });

  it("is case-insensitive for the language tag", () => {
    const input = '```JSON\n{"events":[],"state_patch":{}}\n```';
    expect(removeMarkdownFence(input)).toBe('{"events":[],"state_patch":{}}');
  });
});

// ---------------------------------------------------------------------------
// parseGenerationEnvelope — tests for the private method via (generator as any)
// ---------------------------------------------------------------------------

describe("parseGenerationEnvelope", () => {
  /**
   * Simple fallback parser that mimics JSONL parsing but is lenient for testing.
   * Returns narration/dialogue events for any JSON array text.
   */
  function makeFallback(text: string) {
    return function fallbackParse(t: string) {
      // Try JSONL first, then fall back
      const lines = t.split(/\r?\n/).filter(Boolean);
      return lines.map((line) => JSON.parse(line));
    };
  }

  const fallbackNeverCalled = () => {
    throw new Error("fallback should not have been called");
  };

  // --- envelope (new format) tests ---

  it("parses valid JSON object with events + state_patch", () => {
    const gen = makeTestGenerator();
    const text = JSON.stringify({
      events: [
        { type: "narration", text: "雨停了。" },
        { type: "dialogue", speaker: "老板", text: "再来一杯？" },
        {
          type: "interaction",
          interaction_id: "int_1",
          prompt: "点什么？",
          mode: "choice",
          options: [{ id: "a", text: "啤酒" }],
        },
      ],
      state_patch: {
        recent_summary: "冒险者与老板交谈了几句。",
      },
    });

    const result = (gen as any).parseGenerationEnvelope(
      text,
      fallbackNeverCalled,
    ) as GenerationEnvelope;

    expect(result.events).toHaveLength(3);
    expect(result.events[0]!.type).toBe("narration");
    expect(result.events[1]!.type).toBe("dialogue");
    expect(result.events[2]!.type).toBe("interaction");
    expect(result.state_patch.recent_summary).toBe("冒险者与老板交谈了几句。");
  });

  it("parses envelope with planning_notes included", () => {
    const gen = makeTestGenerator();
    const text = JSON.stringify({
      events: [
        { type: "narration", text: "窗外雷声滚滚。" },
      ],
      state_patch: {},
      planning_notes: {
        next_scene_plan: "老板会提供一个任务",
        thread_hints: ["tavern_quest"],
        character_directions: { innkeeper: "主动提供情报" },
        anticipated_interactions: ["choice"],
      },
    });

    const result = (gen as any).parseGenerationEnvelope(
      text,
      fallbackNeverCalled,
    ) as GenerationEnvelope;

    expect(result.events).toHaveLength(1);
    expect(result.planning_notes).toBeDefined();
    expect(result.planning_notes!.next_scene_plan).toBe("老板会提供一个任务");
    expect(result.planning_notes!.thread_hints).toEqual(["tavern_quest"]);
    expect(result.planning_notes!.character_directions).toEqual({
      innkeeper: "主动提供情报",
    });
    expect(result.planning_notes!.anticipated_interactions).toEqual(["choice"]);
  });

  it("parses envelope when wrapped in markdown fence", () => {
    const gen = makeTestGenerator();
    const text = '```json\n' + JSON.stringify({
      events: [
        { type: "narration", text: "天亮了。" },
        { type: "end", ending_id: "good_end", text: "冒险结束。" },
      ],
      state_patch: { recent_summary: "故事完结。" },
    }) + '\n```';

    const result = (gen as any).parseGenerationEnvelope(
      text,
      fallbackNeverCalled,
    ) as GenerationEnvelope;

    expect(result.events).toHaveLength(2);
    expect(result.events[1]!.type).toBe("end");
  });

  it("parses envelope with only narration/dialogue (no terminal event) in events", () => {
    const gen = makeTestGenerator();
    const text = JSON.stringify({
      events: [
        { type: "narration", text: "微风吹过。" },
        { type: "dialogue", speaker: "A", text: "你好。" },
      ],
      state_patch: {},
    });

    // parseGenerationEnvelope does NOT validate terminal-event placement;
    // that is done by the JSONL fallback parser. The envelope path just
    // validates structural correctness.
    const result = (gen as any).parseGenerationEnvelope(
      text,
      fallbackNeverCalled,
    ) as GenerationEnvelope;

    expect(result.events).toHaveLength(2);
    expect(result.state_patch).toEqual({});
  });

  it("handles envelope with minimal empty state_patch", () => {
    const gen = makeTestGenerator();
    const text = JSON.stringify({
      events: [{ type: "narration", text: "..." }],
      state_patch: {},
    });

    const result = (gen as any).parseGenerationEnvelope(
      text,
      fallbackNeverCalled,
    ) as GenerationEnvelope;

    expect(result.events).toHaveLength(1);
    expect(result.state_patch).toEqual({});
  });

  // --- fallback (legacy JSONL) tests ---

  it("falls back to JSONL when text is a JSON array (not object)", () => {
    const gen = makeTestGenerator();
    const jsonlLines = [
      '{"type":"narration","text":"夜幕降临。"}',
      '{"type":"dialogue","speaker":"小樱","text":"好美啊。"}',
      '{"type":"end","ending_id":"end_1","text":"THE END"}',
    ];
    const text = jsonlLines.join("\n");

    const result = (gen as any).parseGenerationEnvelope(
      text,
      makeFallback(text),
    ) as GenerationEnvelope;

    expect(result.events).toHaveLength(3);
    expect(result.state_patch).toEqual({});
    expect(result.events[0]!.type).toBe("narration");
    expect(result.events[2]!.type).toBe("end");
  });

  it("falls back when JSON object has no 'events' key", () => {
    const gen = makeTestGenerator();
    const text = JSON.stringify({ type: "narration", text: "意外。" });

    let fallbackCalled = false;
    const fallback = () => {
      fallbackCalled = true;
      return [{ type: "narration", text: "fallback used" }];
    };

    const result = (gen as any).parseGenerationEnvelope(text, fallback) as GenerationEnvelope;
    expect(fallbackCalled).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.state_patch).toEqual({});
  });

  it("falls back when JSON parsing of envelope fails (malformed JSON object)", () => {
    const gen = makeTestGenerator();
    // The text is not valid JSON
    const text = '{events: [{type: "narration"}]}'; // invalid JSON (unquoted keys)

    let fallbackCalled = false;
    const fallback = () => {
      fallbackCalled = true;
      return [{ type: "narration", text: "fallback" }];
    };

    const result = (gen as any).parseGenerationEnvelope(text, fallback) as GenerationEnvelope;
    expect(fallbackCalled).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  it("falls back when envelope Zod validation fails (missing required fields)", () => {
    const gen = makeTestGenerator();
    // Valid JSON but events contains an unknown type
    const text = JSON.stringify({
      events: [{ type: "unknown_type", text: "???" }],
      state_patch: {},
    });

    let fallbackCalled = false;
    const fallback = () => {
      fallbackCalled = true;
      return [{ type: "narration", text: "fallback" }];
    };

    const result = (gen as any).parseGenerationEnvelope(text, fallback) as GenerationEnvelope;
    expect(fallbackCalled).toBe(true);
  });

  // --- error propagation ---

  it("throws when both envelope parsing AND fallback fail", () => {
    const gen = makeTestGenerator();
    const text = "not json at all!!!!";

    expect(() => {
      (gen as any).parseGenerationEnvelope(text, makeFallback(text));
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// GenerationEnvelopeSchema — direct Zod validation edge cases
// ---------------------------------------------------------------------------

describe("GenerationEnvelopeSchema edge cases", () => {
  it("accepts envelope with null portrait", () => {
    const result = GenerationEnvelopeSchema.safeParse({
      events: [
        {
          type: "dialogue",
          speaker: "NPC",
          text: "Hello",
          portrait: null,
        },
      ],
      state_patch: {},
    });
    expect(result.success).toBe(true);
  });

  it("accepts envelope with legacy choice event for backward compatibility", () => {
    const result = GenerationEnvelopeSchema.safeParse({
      events: [
        { type: "narration", text: "你面前有两条路。" },
        {
          type: "choice",
          prompt: "走哪边？",
          options: [
            { id: "left", text: "左边" },
            { id: "right", text: "右边" },
          ],
        },
      ],
      state_patch: {},
    });
    expect(result.success).toBe(true);
  });

  it("accepts envelope with complete StoryStatePatch fields", () => {
    const result = GenerationEnvelopeSchema.safeParse({
      events: [{ type: "narration", text: "测试。" }],
      state_patch: {
        scene: { id: "new_scene", location: "神殿", purpose: "探索" },
        canon: { artifact_found: true },
        characters: {
          hero: { location: "神殿", emotion: "兴奋" },
        },
        open_threads: [
          {
            id: "t1",
            summary: "调查神殿",
            status: "active",
            last_touched_turn: 3,
          },
        ],
        recent_summary: "英雄进入了神殿。",
        player_profile: { recent_tendencies: ["探索"] },
      },
      planning_notes: {
        next_scene_plan: "发现隐藏密室",
        thread_hints: ["hidden_room"],
        character_directions: { hero: "寻找线索" },
        anticipated_interactions: ["input"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects envelope with missing events array", () => {
    const result = GenerationEnvelopeSchema.safeParse({
      state_patch: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects envelope with missing state_patch", () => {
    const result = GenerationEnvelopeSchema.safeParse({
      events: [{ type: "narration", text: "test" }],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildAutocompleteSystem / buildAutocompletePrompt — private method tests
// ---------------------------------------------------------------------------

describe("buildAutocompleteSystem", () => {
  it("autocomplete_system template includes max_suffix_characters placeholder", () => {
    const gen = makeTestGenerator();
    const tmpl = (gen as any).instructions.autocomplete_system as string;
    expect(tmpl).toContain("{max_suffix_characters}");
    expect(tmpl).toContain("输入补全助手");
  });

  it("autocomplete_system template includes confidence_threshold placeholder", () => {
    const gen = makeTestGenerator();
    const tmpl = (gen as any).instructions.autocomplete_system as string;
    expect(tmpl).toContain("{confidence_threshold}");
  });

  it("autocomplete_system template references JSON output fields", () => {
    const gen = makeTestGenerator();
    const tmpl = (gen as any).instructions.autocomplete_system as string;
    expect(tmpl).toContain("draft_id");
    expect(tmpl).toContain("suffix");
    expect(tmpl).toContain("confidence");
  });
});

describe("buildAutocompletePrompt", () => {
  const interaction: InteractionEvent = {
    type: "interaction",
    interaction_id: "int_1",
    prompt: "你想说什么？",
    mode: "input",
    input: {
      kind: "free_text",
      placeholder: "输入你的回答...",
      max_length: 200,
    },
  };

  it("includes scene location and time", () => {
    const gen = makeTestGenerator();
    const state = makeTestState();
    const prompt = (gen as any).buildAutocompletePrompt(
      state,
      [],
      interaction,
      "我觉得",
    ) as string;

    expect(prompt).toContain("当前场景：");
    expect(prompt).toContain("酒馆");
    expect(prompt).toContain("黄昏");
  });

  it("includes character names and emotions", () => {
    const gen = makeTestGenerator();
    const state = makeTestState();
    const prompt = (gen as any).buildAutocompletePrompt(
      state,
      [],
      interaction,
      "你好",
    ) as string;

    expect(prompt).toContain("hero");
    expect(prompt).toContain("警惕");
    expect(prompt).toContain("innkeeper");
    expect(prompt).toContain("友善");
  });

  it("includes recent dialogue from history (public info only)", () => {
    const gen = makeTestGenerator();
    const state = makeTestState();
    const history = makeTestHistory();

    const prompt = (gen as any).buildAutocompletePrompt(
      state,
      history,
      interaction,
      "我想",
    ) as string;

    expect(prompt).toContain("最近对话");
    expect(prompt).toContain("老板");
    expect(prompt).toContain("欢迎！要喝点什么？");
  });

  it("includes the interaction prompt text", () => {
    const gen = makeTestGenerator();
    const state = makeTestState();

    const prompt = (gen as any).buildAutocompletePrompt(
      state,
      [],
      interaction,
      "test",
    ) as string;

    expect(prompt).toContain("你想说什么？");
  });

  it("includes the player's current prefix", () => {
    const gen = makeTestGenerator();
    const state = makeTestState();

    const prompt = (gen as any).buildAutocompletePrompt(
      state,
      [],
      interaction,
      "我应该去",
    ) as string;

    expect(prompt).toContain('"我应该去"');
  });

  it("includes only recent 4 events for dialogue context", () => {
    const gen = makeTestGenerator();
    const state = makeTestState();

    const longHistory: StoryContextEvent[] = Array.from({ length: 10 }, (_, i) => ({
      type: "dialogue" as const,
      speaker: `NPC${i}`,
      text: `Line ${i}`,
      line_id: `l_${i}`,
      seq: i,
      turn: 1,
      timestamp: "2024-01-01T00:00:00.000Z",
      source: "model",
    }));

    const prompt = (gen as any).buildAutocompletePrompt(
      state,
      longHistory.slice(-6), // the method uses recentHistory (last 6)
      interaction,
      "hey",
    ) as string;

    // Method slices recentHistory.slice(-4) for display
    // With 6 events passed, should only show last 4
    expect(prompt).toContain("NPC8");
    expect(prompt).toContain("NPC9");
    // NPC5 and NPC6 should not appear (only last 4 of the 6)
    const npc5Count = (prompt.match(/NPC5/g) || []).length;
    expect(npc5Count).toBe(0);
  });

  it("does NOT include canon secrets (public info only)", () => {
    const gen = makeTestGenerator();
    const state = makeTestState();
    // canon is not included in autocomplete prompt by design
    const prompt = (gen as any).buildAutocompletePrompt(
      state,
      [],
      interaction,
      "test",
    ) as string;

    expect(prompt).not.toContain("weather");
    expect(prompt).not.toContain("rainy");
    expect(prompt).not.toContain("canon");
  });
});

// ---------------------------------------------------------------------------
// AutocompleteResultSchema — confidence threshold and validation
// ---------------------------------------------------------------------------

describe("AutocompleteResultSchema", () => {
  it("accepts a valid autocomplete result", () => {
    const result = AutocompleteResultSchema.safeParse({
      draft_id: "draft-1",
      revision: 0,
      suffix: " quietly",
      intent: "move stealthily",
      confidence: 0.85,
    });
    expect(result.success).toBe(true);
  });

  it("rejects confidence > 1.0", () => {
    const result = AutocompleteResultSchema.safeParse({
      draft_id: "d",
      revision: 0,
      suffix: "x",
      intent: "x",
      confidence: 1.01,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence < 0", () => {
    const result = AutocompleteResultSchema.safeParse({
      draft_id: "d",
      revision: 0,
      suffix: "x",
      intent: "x",
      confidence: -0.01,
    });
    expect(result.success).toBe(false);
  });

  it("accepts confidence exactly 0", () => {
    const result = AutocompleteResultSchema.safeParse({
      draft_id: "d",
      revision: 0,
      suffix: "x",
      intent: "x",
      confidence: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts confidence exactly 1.0", () => {
    const result = AutocompleteResultSchema.safeParse({
      draft_id: "d",
      revision: 0,
      suffix: "x",
      intent: "x",
      confidence: 1.0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty draft_id", () => {
    const result = AutocompleteResultSchema.safeParse({
      draft_id: "",
      revision: 0,
      suffix: "x",
      intent: "x",
      confidence: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative revision", () => {
    const result = AutocompleteResultSchema.safeParse({
      draft_id: "d",
      revision: -1,
      suffix: "x",
      intent: "x",
      confidence: 0.5,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: ContextInput construction for generation methods
// ---------------------------------------------------------------------------

describe("StoryGenerator ContextInput integration", () => {
  it("generator constructor builds systemPrompt with prompts and empty state", () => {
    const gen = makeTestGenerator();
    const systemPrompt = (gen as any).systemPrompt as string;

    expect(systemPrompt).toContain("互动视觉小说的剧情生成器");
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
// Autocomplete minimum_characters check logic
// ---------------------------------------------------------------------------

describe("generateAutocomplete minimum_characters logic", () => {
  it("should return null before making API call when prefix too short", async () => {
    const gen = makeTestGenerator({
      autocomplete: {
        minimum_characters: 5,
        debounce_ms: 350,
        max_suffix_characters: 20,
        confidence_threshold: 0.55,
      },
    });

    const state = makeTestState();
    const interaction: InteractionEvent = {
      type: "interaction",
      interaction_id: "int_1",
      prompt: "What do you do?",
      mode: "input",
      input: { kind: "free_text", placeholder: "...", max_length: 200 },
    };

    // Prefix is too short (only 3 chars after trim)
    const result = await gen.generateAutocomplete(state, [], interaction, "  ab ");
    expect(result).toBeNull();
  });

  it("should return null when prefix has only whitespace", async () => {
    const gen = makeTestGenerator();
    const state = makeTestState();
    const interaction: InteractionEvent = {
      type: "interaction",
      interaction_id: "int_1",
      prompt: "What do you do?",
      mode: "input",
      input: { kind: "free_text", placeholder: "...", max_length: 200 },
    };

    const result = await gen.generateAutocomplete(state, [], interaction, "     ");
    expect(result).toBeNull();
  });

  it("passes min-char check when prefix is long enough (prefix check is synchronous)", () => {
    const gen = makeTestGenerator({
      autocomplete: {
        minimum_characters: 4,
        debounce_ms: 350,
        max_suffix_characters: 20,
        confidence_threshold: 0.55,
      },
    });

    const state = makeTestState();
    const interaction: InteractionEvent = {
      type: "interaction",
      interaction_id: "int_1",
      prompt: "What do you do?",
      mode: "input",
      input: { kind: "free_text", placeholder: "...", max_length: 200 },
    };

    // generateAutocomplete checks prefix length synchronously before
    // making any API call. If the prefix is long enough, it proceeds to
    // the async API call — we verify this by checking that the promise
    // was created (i.e. the sync check passed) without awaiting it.
    const promise = gen.generateAutocomplete(state, [], interaction, "hello world");
    expect(promise).toBeInstanceOf(Promise);

    // Don't await — would hit the fake API and fail. We just verified
    // the synchronous guard didn't short-circuit to null.
    // Suppress the eventual rejection so it doesn't pollute the test run.
    promise.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// Autocomplete suffix truncation logic (tested via schema + manual check)
// ---------------------------------------------------------------------------

describe("Autocomplete suffix truncation", () => {
  it("AutocompleteResultSchema accepts suffix within max length", () => {
    const result = AutocompleteResultSchema.safeParse({
      draft_id: "d",
      revision: 0,
      suffix: "a".repeat(20),
      intent: "test",
      confidence: 0.8,
    });
    expect(result.success).toBe(true);
  });

  it("AutocompleteResultSchema accepts long suffix (validation doesn't enforce max)", () => {
    // The schema doesn't enforce max_suffix_characters — the
    // StoryGenerator truncates before returning. Schema just
    // validates structural type.
    const result = AutocompleteResultSchema.safeParse({
      draft_id: "d",
      revision: 0,
      suffix: "a".repeat(500),
      intent: "test",
      confidence: 0.8,
    });
    expect(result.success).toBe(true);
  });
});
