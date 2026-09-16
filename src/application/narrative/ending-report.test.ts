/**
 * ending-report 聚合测试（记忆 spec §8.4，MA-A）：数值口径锁定。
 */

import { describe, it, expect } from "vitest";

import { emptyState, makeSetup, makeThread } from "./narrative-director-test-kit.js";
import { buildEndingReport } from "./ending-report.js";
import type { Lesson, NarrativeMemoryState } from "../../core/narrative/memory-types.js";

function stateWith(overrides: Partial<NarrativeMemoryState>): NarrativeMemoryState {
  return { ...emptyState(), ...overrides };
}

describe("buildEndingReport", () => {
  it("computes the payoff rate as paid_off / (paid_off + dropped + active)", () => {
    const memory = stateWith({
      setups: {
        paid: makeSetup({ id: "paid", status: "paid_off" }),
        paid2: makeSetup({ id: "paid2", status: "paid_off" }),
        dropped: makeSetup({ id: "dropped", status: "dropped" }),
        active: makeSetup({ id: "active", status: "seeded" }),
        planned: makeSetup({ id: "planned", status: "planned" }),
      },
    });
    const report = buildEndingReport(memory, [], "2026-09-17T00:00:00Z");
    expect(report.setups).toEqual({
      paidOff: 2,
      dropped: 1,
      active: 2,
      payoffRate: 2 / 5,
    });
  });

  it("yields rate 0 when there are no setups at all", () => {
    const report = buildEndingReport(emptyState(), [], "2026-09-17T00:00:00Z");
    expect(report.setups).toEqual({ paidOff: 0, dropped: 0, active: 0, payoffRate: 0 });
  });

  it("distributes thread terminal states and counts open threads as active", () => {
    const memory = stateWith({
      threads: {
        r: makeThread({ id: "r", status: "resolved" }),
        a: makeThread({ id: "a", status: "abandoned" }),
        o: makeThread({ id: "o", status: "open" }),
        d: makeThread({ id: "d", status: "developing" }),
      },
    });
    const report = buildEndingReport(memory, [], "2026-09-17T00:00:00Z");
    expect(report.threads).toEqual({ resolved: 1, abandoned: 1, active: 2 });
  });

  it("appends active lessons sorted by occurrences desc", () => {
    const lessons: Lesson[] = [
      {
        id: "lesson_1",
        tag: "setup-flow",
        content: "低频",
        source: "rejection",
        occurrences: 1,
        active: true,
        createdAtCheckpoint: 1,
      },
      {
        id: "lesson_2",
        tag: "other",
        content: "高频",
        source: "manual",
        occurrences: 4,
        active: true,
        createdAtCheckpoint: 2,
      },
      {
        id: "lesson_3",
        tag: "style",
        content: "已退役",
        source: "audit",
        occurrences: 9,
        active: false,
        createdAtCheckpoint: 3,
      },
    ];
    const report = buildEndingReport(emptyState(), lessons, "2026-09-17T00:00:00Z");
    expect(report.lessons.map((l) => l.id)).toEqual(["lesson_2", "lesson_1"]);
    expect(report.lessons[0]).toEqual({
      id: "lesson_2",
      tag: "other",
      content: "高频",
      occurrences: 4,
    });
  });
});
