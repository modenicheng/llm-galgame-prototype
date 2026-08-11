import { describe, it, expect } from "vitest";
import type { SetupPayoff, StoryAnchorState } from "../../core/narrative/memory-types.js";
import { computeCurrentAnchorId, scheduleSetups } from "./setup-scheduler.js";

function makeSetup(overrides: Partial<SetupPayoff> = {}): SetupPayoff {
  return {
    id: "s1", kind: "foreshadow", setup: "终端对苏遥异常响应",
    status: "seeded", reinforcementCount: 0, prerequisites: [],
    source: "author", ...overrides,
  };
}

function makeAnchor(overrides: Partial<StoryAnchorState> = {}): StoryAnchorState {
  return { id: "a1", purpose: "p", prerequisites: [], required: false, status: "pending", ...overrides };
}

describe("scheduleSetups", () => {
  it("classifies only non-terminal setups and keeps input order", () => {
    const directives = scheduleSetups(
      [
        makeSetup({ id: "s1", status: "seeded", lastTouchedAtCheckpoint: 8 }),
        makeSetup({ id: "s2", status: "paid_off" }),
        makeSetup({ id: "s3", status: "planned" }),
      ],
      10,
      undefined,
    );
    expect(directives.map((d) => d.id)).toEqual(["s1", "s3"]);
    expect(directives[0]!.action).toBe("reinforce"); // seeded 且 age 2 → reinforce/soon
    expect(directives[1]!.action).toBe("hold");
  });

  it("emits payoff now when payoffBeforeAnchor matches the current anchor", () => {
    const directives = scheduleSetups(
      [makeSetup({ id: "s1", status: "ready", payoffBeforeAnchor: "a2" })],
      10,
      "a2",
    );
    expect(directives[0]).toEqual({ id: "s1", action: "payoff", urgency: "now" });
  });
});

describe("computeCurrentAnchorId", () => {
  it("returns undefined when no anchor is reached or passed", () => {
    expect(computeCurrentAnchorId({ a1: makeAnchor() })).toBeUndefined();
  });

  it("returns the first pending anchor after the last resolved one", () => {
    const anchors: Record<string, StoryAnchorState> = {
      a1: makeAnchor({ id: "a1", status: "reached" }),
      a2: makeAnchor({ id: "a2" }),
      a3: makeAnchor({ id: "a3" }),
    };
    expect(computeCurrentAnchorId(anchors)).toBe("a2");
  });

  it("returns undefined when every anchor is resolved", () => {
    const anchors: Record<string, StoryAnchorState> = {
      a1: makeAnchor({ id: "a1", status: "passed" }),
    };
    expect(computeCurrentAnchorId(anchors)).toBeUndefined();
  });
});
