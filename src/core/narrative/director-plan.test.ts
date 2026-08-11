import { describe, it, expect } from "vitest";
import {
  DirectorPlanSchema,
  DirectorPhaseSchema,
  PlannedBeatSchema,
  AnchorOpSchema,
  SetupDirectiveSchema,
  type DirectorPlan,
} from "./director-plan.js";

function makePlan(overrides: Partial<DirectorPlan> = {}): DirectorPlan {
  return {
    revision: 1,
    basedOnMemoryRevision: 7,
    phase: "development",
    currentGoal: "将玩家对苏遥的怀疑推进到新阶段",
    beats: [{ purpose: "让玩家得到一个关于终端身份的侧面证据" }],
    focusThreads: ["terminal_origin", "suyao_identity"],
    setupDirectives: [{ id: "terminal_reacts_to_suyao", action: "reinforce", urgency: "soon" }],
    revealLocks: ["suyao_memory_origin"],
    expiresAfterCheckpoint: 4,
    ...overrides,
  };
}

describe("DirectorPlanSchema", () => {
  it("parses a legal plan and round-trips", () => {
    const plan = makePlan();
    expect(DirectorPlanSchema.parse(plan)).toEqual(plan);
  });

  it("rejects missing required fields and over-limit arrays", () => {
    expect(DirectorPlanSchema.safeParse({ ...makePlan(), phase: undefined }).success).toBe(false);
    expect(DirectorPlanSchema.safeParse(makePlan({ beats: [] })).success).toBe(false);
    expect(
      DirectorPlanSchema.safeParse(makePlan({ revealLocks: Array.from({ length: 9 }, (_, i) => `lock_${i}`) })).success,
    ).toBe(false);
    expect(
      DirectorPlanSchema.safeParse(makePlan({ currentGoal: "x".repeat(201) })).success,
    ).toBe(false);
  });

  it("rejects empty purpose and unknown phase values", () => {
    expect(DirectorPlanSchema.safeParse(makePlan({ beats: [{ purpose: "" }] })).success).toBe(false);
    expect(DirectorPhaseSchema.safeParse("finale").success).toBe(false);
  });

  it("validates anchor and setup directive shapes", () => {
    expect(AnchorOpSchema.parse({ type: "pass", id: "a1" })).toEqual({ type: "pass", id: "a1" });
    expect(AnchorOpSchema.safeParse({ type: "skip", id: "a1" }).success).toBe(false);
    expect(SetupDirectiveSchema.parse({ id: "s1", action: "payoff", urgency: "now" }))
      .toEqual({ id: "s1", action: "payoff", urgency: "now" });
  });
});
