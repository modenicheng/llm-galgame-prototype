import { describe, it, expect } from "vitest";
import type { AnchorStatus, SetupPayoff, StoryAnchorState } from "../../core/narrative/memory-types.js";
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
      () => true,
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
      () => true,
    );
    expect(directives[0]).toEqual({
      id: "s1", action: "payoff", urgency: "now", premise: "终端对苏遥异常响应",
    });
  });

  it("passes the satisfied predicate through to classifySetup", () => {
    // Stale seeded setup (gap >= 2) so the reinforce branch is reachable.
    const setups = [makeSetup({ id: "s1", status: "seeded", prerequisites: ["a1"], lastTouchedAtCheckpoint: 1 })];
    const directives = scheduleSetups(setups, 3, undefined, (id) => id === "s1");
    expect(directives).toEqual([{ id: "s1", action: "reinforce", urgency: "soon", premise: setups[0]!.setup }]);
    expect(scheduleSetups(setups, 3, undefined, () => false)).toEqual([
      { id: "s1", action: "hold", urgency: "normal", premise: setups[0]!.setup },
    ]);
  });
});

describe("computeCurrentAnchorId", () => {
  // New contract (audit P1-5): the current anchor is the first pending
  // anchor whose prerequisites are ALL resolved — not "first after the last
  // resolved one". A story with no resolved anchor yet now yields the first
  // prerequisite-free pending anchor (payoffBeforeAnchor becomes live from
  // the start), instead of undefined.
  it("returns the first pending anchor even before any anchor is resolved", () => {
    expect(computeCurrentAnchorId({ a1: makeAnchor() })).toBe("a1");
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

describe("computeCurrentAnchorId with declaration order", () => {
  function anchor(id: string, status: AnchorStatus, prerequisites: string[] = []): StoryAnchorState {
    return { id, purpose: id, prerequisites, required: true, status };
  }

  it("picks the first pending anchor whose prerequisites are satisfied, in declaration order", () => {
    const anchors = {
      // 字典序会先挑 reveal_secret；声明序应先挑 act2_entry。
      reveal_secret: anchor("reveal_secret", "pending", ["final_choice"]),
      act2_entry: anchor("act2_entry", "pending", []),
      final_choice: anchor("final_choice", "pending", ["act2_entry"]),
    };
    const order = new Map([["act2_entry", 0], ["final_choice", 1], ["reveal_secret", 2]]);
    expect(computeCurrentAnchorId(anchors, order)).toBe("act2_entry");
  });

  it("skips pending anchors with unsatisfied prerequisites", () => {
    const anchors = {
      a: anchor("a", "pending", []),
      b: anchor("b", "pending", ["a"]),
      c: anchor("c", "pending", ["b"]),
    };
    anchors.a.status = "reached";
    const order = new Map([["a", 0], ["b", 1], ["c", 2]]);
    expect(computeCurrentAnchorId(anchors, order)).toBe("b");
  });

  it("returns undefined when no pending anchor is reachable", () => {
    const anchors = {
      a: anchor("a", "pending", ["x"]), // x 不存在
    };
    expect(computeCurrentAnchorId(anchors)).toBeUndefined();
  });

  it("falls back to id order when no declaration order is provided", () => {
    const anchors = {
      b: anchor("b", "pending", []),
      a: anchor("a", "pending", []),
    };
    expect(computeCurrentAnchorId(anchors)).toBe("a");
  });
});
