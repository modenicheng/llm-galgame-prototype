/**
 * 会话记忆代理合并层测试——merge-only 语义、注入限额、线程前向迁移。
 */
import { describe, it, expect } from "vitest";
import { applyMemoryProposal } from "./memory-agent.js";
import { createInitialState } from "./state.js";
import type { MemoryAgentProposal } from "../core/ports/session-memory-agent-port.js";
import type { StoryState } from "./types.js";

const KNOWN = new Set(["raspberry", "female_B", "male_A"]);

function stateWith(overrides: Partial<StoryState>): StoryState {
  return { ...createInitialState(), ...overrides };
}

describe("applyMemoryProposal — characters", () => {
  it("merges non-empty fields onto existing character entries", () => {
    const state = stateWith({
      characters: { raspberry: { emotion: "紧张" } },
    });
    const proposal: MemoryAgentProposal = {
      characters: {
        raspberry: { emotion: "得意", current_goal: "把投影修好" },
        female_B: { relationship_to_player: "爱拆台的同伴" },
      },
    };

    const next = applyMemoryProposal(state, proposal, { knownCharacterIds: KNOWN, turn: 3 });

    expect(next).not.toBeNull();
    expect(next!.characters.raspberry).toEqual({
      emotion: "得意",
      current_goal: "把投影修好",
    });
    expect(next!.characters.female_B).toEqual({ relationship_to_player: "爱拆台的同伴" });
    // 未提及的男性角色不受影响；scene / recent_summary 原样。
    expect(next!.characters.male_A).toBeUndefined();
    expect(next!.recent_summary).toBe(state.recent_summary);
    expect(next!.scene).toBe(state.scene);
  });

  it("rejects unknown characters and machine-marked ids", () => {
    const state = stateWith({});
    const proposal: MemoryAgentProposal = {
      characters: {
        stranger: { emotion: "开心" },
        "@6ch ghost": { emotion: "开心" },
        raspberry: { emotion: "" }, // 空值 = 无效
      },
    };

    const next = applyMemoryProposal(state, proposal, { knownCharacterIds: KNOWN, turn: 2 });

    expect(next).toBeNull();
  });

  it("keeps existing fields when proposal omits them (merge-only)", () => {
    const state = stateWith({
      characters: { raspberry: { emotion: "紧张", current_goal: "修电脑" } },
    });
    const proposal: MemoryAgentProposal = {
      characters: { raspberry: { emotion: "释然" } },
    };

    const next = applyMemoryProposal(state, proposal, { knownCharacterIds: KNOWN, turn: 4 });

    expect(next!.characters.raspberry).toEqual({ emotion: "释然", current_goal: "修电脑" });
  });
});

describe("applyMemoryProposal — canon", () => {
  it("merges string facts and pins scenario keys under the 12-key cap", () => {
    const canon: Record<string, unknown> = { scenario_seed: "s1", scenario_title: "标题" };
    for (let i = 0; i < 10; i++) canon[`fact${i}`] = `旧事实${i}`;
    const state = stateWith({ canon });

    const proposal: MemoryAgentProposal = {
      canon: { "投影仪": "已修好", "借笔": "欠树莓娘一支笔" },
    };

    const next = applyMemoryProposal(state, proposal, { knownCharacterIds: KNOWN, turn: 5 });

    expect(next).not.toBeNull();
    expect(Object.keys(next!.canon)).toHaveLength(12);
    expect(next!.canon["scenario_seed"]).toBe("s1");
    expect(next!.canon["scenario_title"]).toBe("标题");
    expect(next!.canon["投影仪"]).toBe("已修好");
    expect(next!.canon["fact0"]).toBeUndefined(); // 最旧的未钉住键被逐出
    expect(next!.canon["借笔"]).toBe("欠树莓娘一支笔");
  });

  it("returns null when nothing actually changes", () => {
    const state = stateWith({ canon: { 已知: "事实" } });

    expect(
      applyMemoryProposal(state, { canon: { 已知: "事实" } }, { knownCharacterIds: KNOWN, turn: 1 }),
    ).toBeNull();
  });
});

describe("applyMemoryProposal — open_threads", () => {
  it("advances thread status forward but never backwards (L1 ready flip preserved)", () => {
    const state = stateWith({
      open_threads: [
        { id: "seed-situation", summary: "种子线", status: "ready", last_touched_turn: 0 },
        { id: "borrowed-pen", summary: "借笔未还", status: "active", last_touched_turn: 2 },
      ],
    });

    const next = applyMemoryProposal(
      state,
      {
        open_threads: [
          { id: "seed-situation", status: "active" as const }, // 向后 → 拒绝
          { id: "borrowed-pen", status: "resolved" as const }, // 向前 → 接受
        ],
      },
      { knownCharacterIds: KNOWN, turn: 6 },
    );

    expect(next).not.toBeNull();
    expect(next!.open_threads.find((t) => t.id === "seed-situation")!.status).toBe("ready");
    expect(next!.open_threads.find((t) => t.id === "borrowed-pen")!.status).toBe("resolved");
  });

  it("adds a new thread with summary and stamps last_touched_turn", () => {
    const state = stateWith({ open_threads: [] });

    const next = applyMemoryProposal(
      state,
      { open_threads: [{ id: "weekend-plan", summary: "约好周末一起占座", status: "new" as const }] },
      { knownCharacterIds: KNOWN, turn: 3 },
    );

    expect(next!.open_threads).toHaveLength(1);
    expect(next!.open_threads[0]).toEqual({
      id: "weekend-plan",
      summary: "约好周末一起占座",
      status: "new",
      last_touched_turn: 3,
    });
  });

  it("caps threads at 8, evicting closed threads first", () => {
    const threads = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      summary: `线索${i}`,
      status: (i === 0 ? "abandoned" : "active") as "abandoned" | "active",
      last_touched_turn: i,
    }));
    const state = stateWith({ open_threads: threads });

    const next = applyMemoryProposal(
      state,
      { open_threads: [{ id: "t-new", summary: "新线索" }] },
      { knownCharacterIds: KNOWN, turn: 9 },
    );

    expect(next!.open_threads).toHaveLength(8);
    expect(next!.open_threads.find((t) => t.id === "t0")).toBeUndefined(); // 已关闭的最先被逐
    expect(next!.open_threads.find((t) => t.id === "t-new")).toBeDefined();
    expect(next!.open_threads.find((t) => t.id === "t1")).toBeDefined();
  });
});
