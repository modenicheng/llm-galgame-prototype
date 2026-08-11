import { describe, it, expect, vi } from "vitest";
import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";
import type { NarrativeMemoryState, StoryAnchorState } from "../../core/narrative/memory-types.js";
import { PlotPlanner, validateAnchorOp, applyAnchorOpToState, type PlotPlannerPort, type PlannerProposal } from "./plot-planner.js";

function makeMemory(overrides: Partial<NarrativeMemoryState> = {}): NarrativeMemoryState {
  return {
    revision: 5, consolidatedThroughEventSeq: 40, checkpointCount: 3,
    threads: {
      t1: { id: "t1", kind: "mystery", summary: "终端来历", status: "developing", importance: "major", introducedAtCheckpoint: 0, lastTouchedAtCheckpoint: 3, source: "author" },
      t2: { id: "t2", kind: "character", summary: "苏遥身份", status: "open", importance: "major", introducedAtCheckpoint: 0, lastTouchedAtCheckpoint: 2, source: "author" },
    },
    setups: {},
    anchors: {
      a1: { id: "a1", purpose: "发现终端", prerequisites: [], required: true, status: "reached" },
      a2: { id: "a2", purpose: "怀疑苏遥", prerequisites: ["a1"], required: false, status: "pending" },
      a3: { id: "a3", purpose: "揭示来历", prerequisites: ["a2"], required: false, status: "pending" },
    },
    recentEpisodeIds: [],
    ...overrides,
  };
}

const VALID_PROPOSAL: PlannerProposal = {
  phase: "development",
  currentGoal: "推进怀疑",
  beats: [{ purpose: "侧面证据" }],
  focusThreads: ["t1", "t2"],
  revealLocks: ["a3"],
  anchorOps: [{ type: "reach", id: "a2" }],
};

describe("PlotPlanner", () => {
  it("builds a validated plan and applies chained anchor ops", async () => {
    const port: PlotPlannerPort = { plan: vi.fn().mockResolvedValue(VALID_PROPOSAL) };
    const planner = new PlotPlanner({ port, config: DEFAULT_NARRATIVE_CONFIG });
    const memory = makeMemory();
    const outcome = await planner.plan({ events: [], memory, currentPlan: undefined, location: "", characters: [] });
    expect(outcome.plan).not.toBeNull();
    expect(outcome.plan!.revision).toBe(1);
    expect(outcome.plan!.basedOnMemoryRevision).toBe(5);
    expect(outcome.plan!.expiresAfterCheckpoint).toBe(6); // 3 + horizon 3
    expect(outcome.anchorOps).toEqual([{ type: "reach", id: "a2" }]);
    expect(outcome.rejected).toEqual([]);
  });

  it("rejects anchor ops whose prerequisites are unsatisfied, keeping valid ones", async () => {
    const port: PlotPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        ...VALID_PROPOSAL,
        anchorOps: [
          { type: "reach", id: "a3" },  // 前置 a2 未完成 → 拒
          { type: "reach", id: "a2" },  // 前置 a1 已完成 → 过，链上 a3 仍拒（同批顺序）
        ],
      }),
    };
    const planner = new PlotPlanner({ port, config: DEFAULT_NARRATIVE_CONFIG });
    const outcome = await planner.plan({ events: [], memory: makeMemory(), currentPlan: undefined, location: "", characters: [] });
    expect(outcome.anchorOps).toEqual([{ type: "reach", id: "a2" }]);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]!.kind).toBe("anchor");
  });

  it("resolves anchor chains within one batch in proposal order", async () => {
    const port: PlotPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        ...VALID_PROPOSAL,
        anchorOps: [
          { type: "reach", id: "a2" },  // 前置 a1 已完成 → 过
          { type: "reach", id: "a3" },  // 前置 a2 本批已 reach → 过（shadow 链）
        ],
      }),
    };
    const planner = new PlotPlanner({ port, config: DEFAULT_NARRATIVE_CONFIG });
    const outcome = await planner.plan({ events: [], memory: makeMemory(), currentPlan: undefined, location: "", characters: [] });
    expect(outcome.anchorOps).toEqual([
      { type: "reach", id: "a2" },
      { type: "reach", id: "a3" },
    ]);
    expect(outcome.rejected).toEqual([]);
  });

  it("dedupes revealLocks without rejection", async () => {
    const port: PlotPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        ...VALID_PROPOSAL,
        revealLocks: ["a3", "a1", "a3"],
      }),
    };
    const planner = new PlotPlanner({ port, config: DEFAULT_NARRATIVE_CONFIG });
    const outcome = await planner.plan({ events: [], memory: makeMemory(), currentPlan: undefined, location: "", characters: [] });
    expect(outcome.plan!.revealLocks).toEqual(["a3", "a1"]);
    expect(outcome.rejected).toEqual([]);
  });

  it("rejects pass on required anchors and unknown ids", async () => {
    expect(validateAnchorOp({ type: "pass", id: "a1" }, makeMemory().anchors)).toContain("required");
    expect(validateAnchorOp({ type: "reach", id: "nope" }, makeMemory().anchors)).toContain("未知");
  });

  it("filters focusThreads to existing non-terminal threads and dedupes", async () => {
    const port: PlotPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        ...VALID_PROPOSAL,
        focusThreads: ["t1", "t1", "ghost", "t2"],
      }),
    };
    const planner = new PlotPlanner({ port, config: DEFAULT_NARRATIVE_CONFIG });
    const outcome = await planner.plan({ events: [], memory: makeMemory(), currentPlan: undefined, location: "", characters: [] });
    expect(outcome.plan!.focusThreads).toEqual(["t1", "t2"]);
    expect(outcome.rejected.some((r) => r.kind === "plan")).toBe(true);
  });

  it("returns a null plan when the port throws or the proposal fails schema", async () => {
    const failingPort: PlotPlannerPort = { plan: vi.fn().mockRejectedValue(new Error("llm down")) };
    const planner = new PlotPlanner({ port: failingPort, config: DEFAULT_NARRATIVE_CONFIG });
    const outcome = await planner.plan({ events: [], memory: makeMemory(), currentPlan: undefined, location: "", characters: [] });
    expect(outcome.plan).toBeNull();

    const badPort: PlotPlannerPort = {
      plan: vi.fn().mockResolvedValue({ ...VALID_PROPOSAL, beats: [] }),
    };
    const badPlanner = new PlotPlanner({ port: badPort, config: DEFAULT_NARRATIVE_CONFIG });
    const badOutcome = await badPlanner.plan({ events: [], memory: makeMemory(), currentPlan: undefined, location: "", characters: [] });
    expect(badOutcome.plan).toBeNull();
    expect(badOutcome.rejected[0]!.kind).toBe("plan");
  });
});

describe("applyAnchorOpToState", () => {
  it("reaches a pending anchor and ignores non-pending ids", () => {
    const state = makeMemory();
    applyAnchorOpToState(state, { type: "reach", id: "a2" });
    expect(state.anchors["a2"]!.status).toBe("reached");
    applyAnchorOpToState(state, { type: "reach", id: "a2" });
    expect(state.anchors["a2"]!.status).toBe("reached"); // 幂等
    applyAnchorOpToState(state, { type: "pass", id: "a3" });
    expect(state.anchors["a3"]!.status).toBe("passed");
  });
});
