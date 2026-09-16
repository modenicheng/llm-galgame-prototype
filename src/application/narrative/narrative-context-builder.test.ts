/**
 * Tests for MemoryProjection director-note rendering (narrative director, Task 7).
 */

import { describe, it, expect } from "vitest";

import type { MemoryProjection } from "../../core/narrative/memory-projection.js";
import { renderMemoryProjection } from "./narrative-context-builder.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBrief(overrides: Partial<MemoryProjection> = {}): MemoryProjection {
  return {
    revision: 3,
    consolidatedThroughEventSeq: 120,
    currentEventSeq: 135,
    checkpointCount: 2,
    location: "旧图书馆",
    characters: ["苏遥"],
    activeThreads: [],
    setupDirectives: [],
    relevantEpisodes: [],
    anchors: [],
        avoidanceLessons: [],
    relatedFacts: [],
    characterBeliefs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderMemoryProjection
// ---------------------------------------------------------------------------

describe("renderMemoryProjection", () => {
  it("renders the revision annotation with both seq numbers", () => {
    const note = renderMemoryProjection(makeBrief(), 40);
    expect(note).toContain("===== 导演便签 =====");
    expect(note).toContain(
      "记忆已整理至事件 120（当前事件 135），最近 40 条原始事件见上方剧情历史。",
    );
  });

  it("renders setup premises and payoff targets (payoff only)", () => {
    const brief = makeBrief({
      setupDirectives: [
        { id: "s1", action: "reinforce", urgency: "soon", premise: "终端似乎会对苏遥产生异常响应。" },
        { id: "s2", action: "payoff", urgency: "now", premise: "教授失踪。", payoff: "揭示教授的去向。" },
      ],
    });
    const note = renderMemoryProjection(brief, 80);
    expect(note).toContain("REINFORCE s1（soon）；前提：终端似乎会对苏遥产生异常响应。");
    expect(note).toContain("PAYOFF s2（now）；前提：教授失踪。；目标：揭示教授的去向。");
  });

  it("annotates the raw-history window with the exact count passed in", () => {
    const note = renderMemoryProjection(makeBrief(), 80);
    expect(note).toContain("最近 80 条原始事件见上方剧情历史");
  });

  it("renders threads, setups, episodes, anchors and revealLocks sections", () => {
    const brief = makeBrief({
      activeThreads: [
        {
          id: "thread_suyao",
          kind: "character",
          summary: "苏遥对主角隐瞒了旧终端的秘密",
          status: "developing",
          importance: "major",
          lastTouchedAtCheckpoint: 10,
          nextPressure: "苏遥可能在今晚再次提起旧终端",
        },
        {
          id: "thread_escape",
          kind: "main",
          summary: "寻找离开旧图书馆的出口",
          status: "open",
          importance: "minor",
          lastTouchedAtCheckpoint: 9,
        },
      ],
      setupDirectives: [
        { id: "setup_key", action: "seed", urgency: "now" },
        { id: "setup_door", action: "payoff", urgency: "soon" },
      ],
      relevantEpisodes: [
        {
          id: "ep_1",
          fromEventSeq: 20,
          toEventSeq: 35,
          summary: "苏遥在旧终端前犹豫不决",
          characters: ["苏遥"],
          locations: ["旧图书馆"],
          threads: ["thread_suyao"],
          setups: [],
          importance: "major",
        },
      ],
      anchors: [
        {
          id: "anchor_escape",
          purpose: "逃出旧图书馆",
          prerequisites: [],
          required: true,
          status: "pending",
        },
      ],
          });
    const note = renderMemoryProjection(brief, 40);

    expect(note).toContain("[活跃剧情线]");
    expect(note).toContain(
      "- thread_suyao（character，developing，major）：苏遥对主角隐瞒了旧终端的秘密 压力：苏遥可能在今晚再次提起旧终端",
    );
    // No nextPressure -> no pressure suffix.
    expect(note).toContain("- thread_escape（main，open，minor）：寻找离开旧图书馆的出口");

    expect(note).toContain("[伏笔任务]");
    expect(note).toContain("- SEED setup_key（now）");
    expect(note).toContain("- PAYOFF setup_door（soon）");

    expect(note).toContain("[相关长线记忆]");
    expect(note).toContain("- 事件 20-35：苏遥在旧终端前犹豫不决");

    expect(note).toContain("[锚点进度]");
    expect(note).toContain("- anchor_escape：pending");

  });

  it("omits sections whose lists are empty", () => {
    const note = renderMemoryProjection(makeBrief(), 40);
    expect(note).not.toContain("[活跃剧情线]");
    expect(note).not.toContain("[伏笔任务]");
    expect(note).not.toContain("[相关长线记忆]");
    expect(note).not.toContain("[锚点进度]");
    expect(note).not.toContain("- ");
  });


});


describe("renderMemoryProjection MA-A sections", () => {
  it("renders the avoidance lessons list", () => {
    const brief = makeBrief({
      avoidanceLessons: [
        {
          id: "lesson_1",
          tag: "setup-flow",
          content: "没有回收计划的伏笔不许下场",
          source: "rejection",
          occurrences: 2,
          active: true,
          createdAtCheckpoint: 1,
        },
      ],
    });
    const note = renderMemoryProjection(brief, 40);
    expect(note).toContain("[规避清单]");
    expect(note).toContain("没有回收计划的伏笔不许下场（setup-flow，×2）");
  });

  it("omits the avoidance section when there are no lessons", () => {
    expect(renderMemoryProjection(makeBrief(), 40)).not.toContain("[规避清单]");
  });

  it("appends the overdue ultimatum for resolve_or_drop directives", () => {
    const brief = makeBrief({
      setupDirectives: [
        {
          id: "s1",
          action: "resolve_or_drop",
          urgency: "overdue",
          premise: "终端对苏遥异常响应",
        },
      ],
    });
    const note = renderMemoryProjection(brief, 40);
    expect(note).toContain("RESOLVE_OR_DROP s1（overdue）");
    expect(note).toContain("本段必须推进回收或显式放弃，不得继续悬置");
  });

  it("marks setups without an intended payoff as 未定回收计划", () => {
    const brief = makeBrief({
      setupDirectives: [
        { id: "s1", action: "hold", urgency: "normal", premise: "p", payoffMissing: true },
      ],
    });
    expect(renderMemoryProjection(brief, 40)).toContain("未定回收计划");
  });
});
