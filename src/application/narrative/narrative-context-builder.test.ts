/**
 * Tests for NarrativeBrief director-note rendering (narrative director, Task 7).
 */

import { describe, it, expect } from "vitest";

import type { NarrativeBrief } from "../../core/narrative/narrative-brief.js";
import { renderDirectorNote } from "./narrative-context-builder.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBrief(overrides: Partial<NarrativeBrief> = {}): NarrativeBrief {
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
    revealLocks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderDirectorNote
// ---------------------------------------------------------------------------

describe("renderDirectorNote", () => {
  it("renders the revision annotation with both seq numbers", () => {
    const note = renderDirectorNote(makeBrief(), 40);
    expect(note).toContain("===== 导演便签 =====");
    expect(note).toContain(
      "记忆已整理至事件 120（当前事件 135），最近 40 条原始事件见下方剧情历史。",
    );
  });

  it("renders setup premises and payoff targets (payoff only)", () => {
    const brief = makeBrief({
      setupDirectives: [
        { id: "s1", action: "reinforce", urgency: "soon", premise: "终端似乎会对苏遥产生异常响应。" },
        { id: "s2", action: "payoff", urgency: "now", premise: "教授失踪。", payoff: "揭示教授的去向。" },
      ],
    });
    const note = renderDirectorNote(brief, 80);
    expect(note).toContain("REINFORCE s1（soon）；前提：终端似乎会对苏遥产生异常响应。");
    expect(note).toContain("PAYOFF s2（now）；前提：教授失踪。；目标：揭示教授的去向。");
  });

  it("annotates the raw-history window with the exact count passed in", () => {
    const note = renderDirectorNote(makeBrief(), 80);
    expect(note).toContain("最近 80 条原始事件见下方剧情历史");
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
      revealLocks: ["lock_old_terminal"],
    });
    const note = renderDirectorNote(brief, 40);

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

    expect(note).toContain("[禁止透露]");
    expect(note).toContain("- lock_old_terminal");
  });

  it("omits sections whose lists are empty", () => {
    const note = renderDirectorNote(makeBrief(), 40);
    expect(note).not.toContain("[活跃剧情线]");
    expect(note).not.toContain("[伏笔任务]");
    expect(note).not.toContain("[相关长线记忆]");
    expect(note).not.toContain("[锚点进度]");
    expect(note).not.toContain("[禁止透露]");
    expect(note).not.toContain("- ");
  });

  it("renders the director goal section before threads when present", () => {
    const note = renderDirectorNote(
      makeBrief({
        activeThreads: [
          {
            id: "thread_suyao",
            kind: "character",
            summary: "苏遥对主角隐瞒了旧终端的秘密",
            status: "developing",
            importance: "major",
            lastTouchedAtCheckpoint: 10,
          },
        ],
        phase: "development",
        currentGoal: "推进玩家对苏遥的怀疑",
        beats: [{ purpose: "让玩家得到侧面证据" }, { purpose: "苏遥阻止调查" }],
      }),
      40,
    );
    expect(note).toContain("[导演目标]");
    expect(note).toContain("阶段：development");
    expect(note).toContain("目标：推进玩家对苏遥的怀疑");
    expect(note).toContain("节拍 1：让玩家得到侧面证据");
    expect(note).toContain("节拍 2：苏遥阻止调查");
    expect(note.indexOf("[导演目标]")).toBeLessThan(note.indexOf("[活跃剧情线]"));
  });

  it("omits the director goal section when no plan is in effect", () => {
    const note = renderDirectorNote(makeBrief(), 40);
    expect(note).not.toContain("[导演目标]");
  });
});
