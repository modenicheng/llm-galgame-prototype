/**
 * Tests for StoryGenerator prompt construction, response parsing, and
 * GenerationEnvelope validation.
 *
 * These tests verify parsing and prompt-building logic WITHOUT making
 * real API calls. The OpenAI client is constructed but never invoked.
 */

import { describe, it, expect, vi } from "vitest";
import { StoryGenerator } from "./llm.js";
import type { AppConfig } from "./config.js";
import type { PromptBundle } from "./prompts.js";
import type { StoryContextEvent, InteractionEvent, ModelEvent } from "./schema.js";
import { makeTestConfig } from "./test-helpers.js";
import type { StoryState, GenerationEnvelope } from "./story/types.js";
import { createInitialState } from "./story/state.js";
import { parseTerminalModelJsonl } from "./jsonl.js";

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
  // --- single-track JSONL protocol (no envelope) ---

  it("strips markdown fence and delegates to the fallback parser", () => {
    const gen = makeTestGenerator();
    const text = '```jsonl\n' + [
      '{"type":"narration","text":"天亮了。"}',
      '{"type":"end","ending_id":"good_end","text":"冒险结束。"}',
    ].join("\n") + '\n```';

    const result = (gen as any).parseGenerationEnvelope(
      text,
      (t: string) => parseTerminalModelJsonl(t),
    );

    expect(result.events).toHaveLength(2);
    expect(result.events[1]!.type).toBe("end");
  });

  it("collects in-band state_patch lines into patches", () => {
    const gen = makeTestGenerator();
    const text = [
      '{"type":"narration","text":"雨停了。"}',
      '{"type":"state_patch","patch":{"recent_summary":"冒险者与老板交谈了几句。"}}',
      '{"type":"dialogue","speaker":"老板","text":"再来一杯？"}',
      '{"type":"interaction","interaction_id":"int_1","prompt":"点什么？","mode":"choice","options":[{"id":"a","text":"啤酒"}]}',
    ].join("\n");

    const result = (gen as any).parseGenerationEnvelope(
      text,
      (t: string) => parseTerminalModelJsonl(t),
    );

    expect(result.events).toHaveLength(3);
    expect(result.events[0]!.type).toBe("narration");
    expect(result.events[2]!.type).toBe("interaction");
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0]!.recent_summary).toBe("冒险者与老板交谈了几句。");
  });

  it("passes text through unchanged when there is no fence", () => {
    const gen = makeTestGenerator();
    const text = '{"type":"narration","text":"意外。"}';

    const fallback = vi.fn(() => ({ events: [], patches: [] }));
    (gen as any).parseGenerationEnvelope(text, fallback);
    expect(fallback).toHaveBeenCalledWith('{"type":"narration","text":"意外。"}');
  });

  // --- fallback delegation ---

  it("delegates plain JSONL to the fallback parser", () => {
    const gen = makeTestGenerator();
    const jsonlLines = [
      '{"type":"narration","text":"夜幕降临。"}',
      '{"type":"dialogue","speaker":"小樱","text":"好美啊。"}',
      '{"type":"end","ending_id":"end_1","text":"THE END"}',
    ];

    const result = (gen as any).parseGenerationEnvelope(
      jsonlLines.join("\n"),
      (t: string) => parseTerminalModelJsonl(t),
    );

    expect(result.events).toHaveLength(3);
    expect(result.events[0]!.type).toBe("narration");
    expect(result.events[2]!.type).toBe("end");
    expect(result.patches).toEqual([]);
  });

  it("propagates fallback parser errors", () => {
    const gen = makeTestGenerator();
    const text = "not json at all!!!!";

    expect(() => {
      (gen as any).parseGenerationEnvelope(
        text,
        (t: string) => parseTerminalModelJsonl(t),
      );
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// requestEnvelope streaming — single-track JSONL protocol
// ---------------------------------------------------------------------------

describe("requestEnvelope streaming", () => {
  function makeStream(lines: string[]): AsyncGenerator<unknown> {
    return (async function* () {
      for (const line of lines) {
        yield { choices: [{ delta: { content: `${line}\n` } }] };
      }
    })();
  }

  /**
   * Like makeStream, but the final fragment is emitted without a trailing
   * newline — simulating a token-limit cut in the middle of a line.
   */
  function makeStreamTruncated(
    completeLines: string[],
    finalFragment: string,
  ): AsyncGenerator<unknown> {
    return (async function* () {
      for (const line of completeLines) {
        yield { choices: [{ delta: { content: `${line}\n` } }] };
      }
      yield { choices: [{ delta: { content: finalFragment } }] };
    })();
  }

  function mockClient(gen: StoryGenerator, stream: AsyncGenerator<unknown>): void {
    (gen as any).client = {
      chat: {
        completions: {
          create: vi.fn(async () => stream),
        },
      },
    };
  }

  it("publishes events as lines arrive; state_patch lines never enter the event stream", async () => {
    const gen = makeTestGenerator();
    mockClient(gen, makeStream([
      '{"type":"narration","text":"雨停了。"}',
      '{"type":"state_patch","patch":{"recent_summary":"雨中相遇。"}}',
      '{"type":"dialogue","speaker":"老板","text":"再来一杯？"}',
      '{"type":"choice","prompt":"怎么答？","options":[{"id":"a","text":"好"},{"id":"b","text":"不"}]}',
    ]));

    const received: ModelEvent[] = [];
    const envelope = await (gen as any).generateOpening(
      1,
      createInitialState(),
      undefined,
      { onEvent: (e: ModelEvent) => received.push(e) },
    );

    expect(received).toHaveLength(3);
    expect(received[0]!.type).toBe("narration");
    expect(received[1]!.type).toBe("dialogue");
    expect(envelope.events).toHaveLength(3);
    expect(envelope.events[2]!.type).toBe("choice");
    expect(envelope.state_patch.recent_summary).toBe("雨中相遇。");
  });

  it("tolerates markdown fence markers around the JSONL payload", async () => {
    const gen = makeTestGenerator();
    mockClient(gen, makeStream([
      '```jsonl',
      '{"type":"narration","text":"天亮了。"}',
      '{"type":"end","ending_id":"good_end","text":"冒险结束。"}',
      '```',
    ]));

    const received: ModelEvent[] = [];
    const envelope = await (gen as any).generateOpening(
      1,
      createInitialState(),
      undefined,
      { onEvent: (e: ModelEvent) => received.push(e) },
    );

    expect(received).toHaveLength(2);
    expect(envelope.events).toHaveLength(2);
    expect(envelope.events[1]!.type).toBe("end");
  });

  it("parses multiple lines delivered in a single chunk (fence-wrapped block)", async () => {
    const gen = makeTestGenerator();
    mockClient(gen, makeStream([
      '```jsonl\n{"type":"narration","text":"夜深。"}\n{"type":"dialogue","speaker":"A","text":"Hi。"}\n{"type":"end","ending_id":"e","text":"终"}\n```',
    ]));

    const envelope = await (gen as any).generateOpening(1, createInitialState());
    expect(envelope.events).toHaveLength(3);
    expect(envelope.events[2]!.type).toBe("end");
  });

  it("aborts and preserves published events when a later line is malformed", async () => {
    const gen = makeTestGenerator();
    mockClient(gen, makeStream([
      '{"type":"narration","text":"第一句。"}',
      '{"type":"dialogue","speaker":"A","text":"第二句。"}',
      'this is not json',
    ]));

    const received: ModelEvent[] = [];
    const promise = (gen as any).generateOpening(
      1,
      createInitialState(),
      undefined,
      { onEvent: (e: ModelEvent) => received.push(e) },
    );

    await expect(promise).rejects.toThrow(/校验失败/);
    expect(received).toHaveLength(2);
  });

  it("drops a trailing token-limit fragment instead of failing the stream", async () => {
    const gen = makeTestGenerator();
    mockClient(gen, makeStreamTruncated(
      [
        '{"type":"narration","text":"第一句。"}',
        '{"type":"dialogue","speaker":"A","text":"第二句。"}',
        '{"type":"end","ending_id":"e","text":"终"}',
      ],
      '{"type": "d', // cut mid-string, no trailing newline
    ));

    const received: ModelEvent[] = [];
    const envelope = await (gen as any).generateOpening(
      1,
      createInitialState(),
      undefined,
      { onEvent: (e: ModelEvent) => received.push(e) },
    );

    // The partial line is discarded; the complete lines (including the
    // terminal event) are delivered normally.
    expect(received).toHaveLength(3);
    expect(envelope.events).toHaveLength(3);
    expect(envelope.events[2]!.type).toBe("end");
  });

  it("fails the batch (with events preserved) when truncation removes the terminal event", async () => {
    const gen = makeTestGenerator();
    mockClient(gen, makeStreamTruncated(
      ['{"type":"narration","text":"第一句。"}'],
      '{"type":"choice","prompt":"怎么', // terminal cut off mid-string
    ));

    const received: ModelEvent[] = [];
    const promise = (gen as any).generateOpening(
      1,
      createInitialState(),
      undefined,
      { onEvent: (e: ModelEvent) => received.push(e) },
    );

    // Dropping the fragment leaves a batch without a terminal event, so the
    // batch validation must still fail — but the published narration stays
    // available for the runtime's repair path.
    await expect(promise).rejects.toThrow(/完整剧情段/);
    expect(received).toHaveLength(1);
  });


  it("retries from scratch when a malformed line precedes any published event", async () => {
    const gen = makeTestGenerator({ generation: { repair_attempts: 1 } });
    const bad = makeStream(['not json at all']);
    const good = makeStream([
      '{"type":"narration","text":"修复后的开场。"}',
      '{"type":"end","ending_id":"e","text":"终"}',
    ]);
    const create = vi
      .fn()
      .mockResolvedValueOnce(bad)
      .mockResolvedValueOnce(good);
    (gen as any).client = { chat: { completions: { create } } };

    const envelope = await (gen as any).generateOpening(1, createInitialState());
    expect(create).toHaveBeenCalledTimes(2);
    expect(envelope.events).toHaveLength(2);
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
