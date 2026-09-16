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
import type { MemoryProjection } from "../core/narrative/memory-projection.js";
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
    characters: {
      hero: { location: "森林" },
      guide: { location: "森林" },
    },
    recent_summary: "夜幕降临，冒险者在林中点起火把。",
  });
}

function makeBrief(): MemoryProjection {
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
        avoidanceLessons: [],
    relatedFacts: [],
    characterBeliefs: [],
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
  it("orders sections stable-first for prefix-cache locality (D9)", () => {
    const ctx: DslContextInput = {
      ...makeDefaultContext(),
      taskType: "continuation",
      generationNonce: "b7f2",
      targetLines: 6,
      tailVisualState: { background: "library", characters: {} },
      actorBriefing:
        "===== 导演便签 =====\n记忆已整理至事件 88（当前事件 92），最近 0 条原始事件见上方剧情历史。\n[活跃剧情线]\n- thread_1（main，developing，major）：寻找失踪的妹妹",
      modelAssetCatalog: {
        guidance: "",
        backgrounds: { library: { description: "旧图书馆" } },
        bgm: {},
        soundEffects: {},
        spriteSets: {},
        characters: {},
      },
    };

    const prompt = buildDslUserPrompt(4, ctx);
    expect(prompt).toContain("导演便签");

    // 稳定区（历史→素材）在前，易变区（状态→便签→舞台）居中，任务头置尾。
    const at = (marker: string) => prompt.indexOf(marker);
    const historyAt = at("===== 剧情历史 =====");
    const catalogAt = at("===== 可用素材 =====");
    const stateAt = at("===== 当前故事状态 =====");
    const noteAt = at("导演便签");
    const stageAt = at("===== 当前舞台状态 =====");
    const taskTypeAt = at("任务类型：");
    const nonceAt = at("生成段 nonce：");
    expect(historyAt).toBeGreaterThanOrEqual(0);
    expect(catalogAt).toBeGreaterThan(historyAt);
    expect(stateAt).toBeGreaterThan(catalogAt);
    expect(noteAt).toBeGreaterThan(stateAt);
    expect(stageAt).toBeGreaterThan(noteAt);
    expect(taskTypeAt).toBeGreaterThan(stageAt);
    expect(nonceAt).toBeGreaterThan(taskTypeAt);
    // 任务头之后不再有历史区（历史只出现在前缀位置）。
    expect(prompt.indexOf("===== 剧情历史 =====", historyAt + 1)).toBe(-1);
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
