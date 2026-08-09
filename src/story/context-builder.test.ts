/**
 * Tests for the LLM context builder.
 */

import { describe, it, expect } from "vitest";
import {
  buildDslUserPrompt,
  buildSystemContext,
  type ContextInput,
  type DslContextInput,
} from "./context-builder.js";
import { createInitialState } from "./state.js";
import type { NarrativeBrief } from "../core/narrative/narrative-brief.js";
import type { PromptBundle } from "../prompts.js";
import type { StoryContextEvent } from "../schema.js";
import type { StoryState } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePrompts(): PromptBundle {
  return {
    characters: "角色A：勇敢的冒险者\n角色B：神秘的向导",
    storyLine: "第一章：进入迷雾森林，寻找失落的圣物。",
    guideline: "保持悬疑氛围，不要使用现代词汇。",
    dslProtocol: "你是互动视觉小说的编剧。输出行式 Gal DSL。",
  };
}

function makeDefaultContext(): ContextInput {
  return {
    prompts: makePrompts(),
    state: createInitialState(),
    recentEvents: [],
  };
}

function makeRichState(): StoryState {
  return createInitialState({
    scene: {
      id: "dark_forest",
      location: "森林深处",
      time: "深夜",
      purpose: "找到隐藏的圣物线索",
    },
    canon: { weather: "foggy", danger_level: 7, torches: 2 },
    characters: {
      hero: {
        location: "森林",
        emotion: "紧张",
        current_goal: "寻找圣物",
        relationship_to_player: "self",
        known_facts: ["圣物在森林深处", "夜晚有狼出没"],
      },
      guide: {
        location: "森林",
        emotion: "神秘",
        relationship_to_player: "ally",
      },
    },
    open_threads: [
      {
        id: "main_quest",
        summary: "找到失落的圣物",
        status: "active",
        last_touched_turn: 5,
      },
      {
        id: "wolf_howl",
        summary: "调查远处的狼嚎声",
        status: "new",
        last_touched_turn: 5,
      },
    ],
    recent_summary: "冒险者和向导深入迷雾森林，听到了远处的狼嚎。",
    player_profile: {
      recent_tendencies: ["探索", "谨慎"],
    },
  });
}

function makeBrief(): NarrativeBrief {
  return {
    revision: 2,
    consolidatedThroughEventSeq: 88,
    currentEventSeq: 92,
    checkpointCount: 1,
    location: "旧图书馆",
    characters: ["苏遥"],
    activeThreads: [
      {
        id: "thread_suyao",
        kind: "mystery",
        summary: "旧终端里藏着苏遥的秘密",
        status: "developing",
        importance: "major",
        lastTouchedAtCheckpoint: 12,
      },
    ],
    setupDirectives: [{ id: "setup_key", action: "reinforce", urgency: "now" }],
    relevantEpisodes: [],
    anchors: [],
    revealLocks: [],
  };
}

function makeRecentEvents(): StoryContextEvent[] {
  return [
    {
      type: "narration",
      text: "迷雾笼罩着古老的森林。",
      line_id: "line_001",
      seq: 1,
      turn: 1,
      timestamp: "2024-01-01T00:00:00.000Z",
      source: "model",
    },
    {
      type: "dialogue",
      speaker: "向导",
      text: "小心脚下，这里有很多古老的陷阱。",
      portrait: { character: "guide", expression: "wary", position: "left" },
      line_id: "line_002",
      seq: 2,
      turn: 1,
      timestamp: "2024-01-01T00:00:01.000Z",
      source: "model",
    },
    {
      type: "player_choice",
      choice_id: "opt_cautious",
      text: "谨慎地跟着向导前进",
      seq: 3,
      turn: 1,
      timestamp: "2024-01-01T00:00:02.000Z",
      source: "player",
    },
  ];
}

// ---------------------------------------------------------------------------
// buildSystemContext
// ---------------------------------------------------------------------------

describe("buildSystemContext", () => {
  it("should include the output protocol (dsl-protocol)", () => {
    const ctx = makeDefaultContext();
    const system = buildSystemContext(ctx);
    expect(system).toContain("行式 Gal DSL");
    expect(system).toContain("角色设定");
  });

  it("should include character settings", () => {
    const ctx = makeDefaultContext();
    const system = buildSystemContext(ctx);
    expect(system).toContain("角色设定");
    expect(system).toContain("角色A");
    expect(system).toContain("角色B");
  });

  it("should include storyline", () => {
    const ctx = makeDefaultContext();
    const system = buildSystemContext(ctx);
    expect(system).toContain("故事大纲");
    expect(system).toContain("迷雾森林");
  });

  it("should include guideline", () => {
    const ctx = makeDefaultContext();
    const system = buildSystemContext(ctx);
    expect(system).toContain("写作限制");
    expect(system).toContain("悬疑氛围");
  });

  it("should include author config when provided", () => {
    const ctx: ContextInput = {
      ...makeDefaultContext(),
      authorConfig: {
        control: {
          world: { mode: "locked" },
          characters: { mode: "preferred" },
          plot: { mode: "free" },
          endings: { mode: "free" },
          style: { mode: "locked" },
        },
        rules: {
          locked: ["所有角色必须是动物"],
          preferred: [],
          seeds: [],
        },
      },
    };
    const system = buildSystemContext(ctx);
    expect(system).toContain("作者控制配置");
    expect(system).toContain("locked");
    expect(system).toContain("所有角色必须是动物");
  });

  it("should not include dynamic state in system context", () => {
    // System context should NOT contain the state summary — that goes
    // into the user prompt for per-request freshness.
    const ctx: ContextInput = {
      ...makeDefaultContext(),
      state: makeRichState(),
    };
    const system = buildSystemContext(ctx);
    expect(system).not.toContain("[Scene]");
    expect(system).not.toContain("[Characters]");
    expect(system).not.toContain("[Open Threads]");
    expect(system).not.toContain("[Canon]");
    expect(system).not.toContain("[Recent]");
  });
});

// ---------------------------------------------------------------------------
// buildDslUserPrompt + director brief
// ---------------------------------------------------------------------------

describe("buildDslUserPrompt", () => {
  it("renders the director brief between history and stage state", () => {
    const ctx: DslContextInput = {
      ...makeDefaultContext(),
      taskType: "continuation",
      generationNonce: "b7f2",
      targetLines: 6,
      directorBrief: makeBrief(),
      tailVisualState: { background: "library", characters: {} },
    };

    const prompt = buildDslUserPrompt(4, ctx);
    expect(prompt).toContain("导演便签");

    const historyAt = prompt.indexOf("===== 剧情历史 =====");
    const noteAt = prompt.indexOf("导演便签");
    const stageAt = prompt.indexOf("===== 当前舞台状态 =====");
    expect(historyAt).toBeGreaterThanOrEqual(0);
    expect(noteAt).toBeGreaterThan(historyAt);
    expect(stageAt).toBeGreaterThan(noteAt);
    expect(prompt).toContain("记忆已整理至事件 88（当前事件 92）");
    expect(prompt).toContain("[活跃剧情线]");
  });

  it("omits the director note entirely without a brief", () => {
    const ctx: DslContextInput = {
      ...makeDefaultContext(),
      taskType: "continuation",
      generationNonce: "c0de",
      targetLines: 6,
    };

    const prompt = buildDslUserPrompt(4, ctx);
    expect(prompt).not.toContain("导演便签");
    expect(prompt).not.toContain("记忆已整理至事件");
  });
});
