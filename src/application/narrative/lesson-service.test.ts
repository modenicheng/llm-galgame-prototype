/**
 * LessonService tests（记忆 spec §7，MA-A）：
 * rejection 自动晋升、幂等累加、unknown 规则跳过、滚动窗口、brief 排序。
 */

import { describe, it, expect } from "vitest";

import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";
import type { NarrativeConfig } from "../../config.js";
import type { Lesson } from "../../core/narrative/memory-types.js";
import type { RejectedOp } from "../../core/narrative/memory-operation.js";
import { LessonService } from "./lesson-service.js";

function makeConfig(overrides?: Partial<NarrativeConfig["lessons"]>): NarrativeConfig {
  return {
    ...DEFAULT_NARRATIVE_CONFIG,
    lessons: { ...DEFAULT_NARRATIVE_CONFIG.lessons, ...overrides },
  };
}

function rejectedSetup(reason: string, rule?: string): RejectedOp {
  return {
    kind: "setup",
    op: { type: "seed", id: "s1" },
    reason,
    ...(rule !== undefined ? { rule } : {}),
  };
}

function makeLesson(overrides: Partial<Lesson> & { id: string }): Lesson {
  return {
    tag: "setup-flow",
    content: `${overrides.id} content`,
    source: "rejection",
    occurrences: 1,
    active: true,
    createdAtCheckpoint: 1,
    ...overrides,
  };
}

describe("LessonService", () => {
  it("promotes a lesson after the same rule reaches auto_from_rejections", () => {
    const svc = new LessonService(makeConfig({ auto_from_rejections: 2 }));
    const reason = "[SETUP_SEED_WITHOUT_INTENDED_PAYOFF] 伏笔 s1 未声明 intendedPayoff";
    expect(svc.observeRejections([rejectedSetup(reason)], 1)).toHaveLength(0);
    const promoted = svc.observeRejections([rejectedSetup(reason)], 2);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      id: "lesson_1",
      tag: "setup-flow",
      content: reason,
      source: "rejection",
      sourceRef: "SETUP_SEED_WITHOUT_INTENDED_PAYOFF",
      occurrences: 1,
      active: true,
    });
  });

  it("counts by stable rule code, not by free-text reason", () => {
    const svc = new LessonService(makeConfig({ auto_from_rejections: 2 }));
    expect(
      svc.observeRejections(
        [rejectedSetup("[SETUP_MISSING] 伏笔 a 不存在", "SETUP_MISSING")],
        1,
      ),
    ).toHaveLength(0);
    // 同规则不同 reason 文本 → 仍计入同一计数器
    const promoted = svc.observeRejections(
      [rejectedSetup("[SETUP_MISSING] 伏笔 b 不存在", "SETUP_MISSING")],
      2,
    );
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.sourceRef).toBe("SETUP_MISSING");
  });

  it("skips rejections without a stable rule code (unknown)", () => {
    const svc = new LessonService(makeConfig());
    expect(
      svc.observeRejections(
        [rejectedSetup("无码的自由文本拒绝"), rejectedSetup("无码的自由文本拒绝")],
        1,
      ),
    ).toHaveLength(0);
    expect(svc.all()).toHaveLength(0);
  });

  it("accumulates occurrences when the same tag+content recurs", () => {
    const svc = new LessonService(makeConfig({ auto_from_rejections: 1 }));
    const reason = "[SETUP_BUDGET_EXCEEDED] 活跃伏笔数已达上限";
    const first = svc.observeRejections([rejectedSetup(reason)], 1);
    expect(first).toHaveLength(1);
    const again = svc.observeRejections([rejectedSetup(reason)], 2);
    expect(again).toHaveLength(1);
    expect(again[0]!.occurrences).toBe(2);
    expect(svc.all()).toHaveLength(1);
  });

  it("promote() is idempotent per tag+content and continues the id sequence on load", () => {
    const svc = new LessonService(makeConfig());
    svc.load([makeLesson({ id: "lesson_7", content: "既有教训" })]);
    const a = svc.promote("setup-flow", "既有教训", "manual", undefined, 3);
    expect(a.occurrences).toBe(2);
    const b = svc.promote("setup-flow", "全新教训", "manual", undefined, 3);
    expect(b.id).toBe("lesson_8");
  });

  it("briefLessons sorts by occurrences desc then recency and caps at brief_max", () => {
    const svc = new LessonService(makeConfig({ brief_max: 2 }));
    svc.load([
      makeLesson({ id: "lesson_1", content: "低频", occurrences: 1, createdAtCheckpoint: 1 }),
      makeLesson({ id: "lesson_2", content: "高频", occurrences: 5, createdAtCheckpoint: 1 }),
      makeLesson({ id: "lesson_3", content: "高频较新", occurrences: 5, createdAtCheckpoint: 9 }),
      makeLesson({ id: "lesson_4", content: "不活跃", occurrences: 9, active: false }),
    ]);
    const brief = svc.briefLessons();
    expect(brief.map((l) => l.id)).toEqual(["lesson_3", "lesson_2"]);
  });

  it("retires the oldest active lessons beyond brief_max * 3 (rolling window)", () => {
    const svc = new LessonService(makeConfig({ brief_max: 2 }));
    svc.load([
      makeLesson({ id: "lesson_1", createdAtCheckpoint: 1 }),
      makeLesson({ id: "lesson_2", createdAtCheckpoint: 2 }),
      makeLesson({ id: "lesson_3", createdAtCheckpoint: 3 }),
      makeLesson({ id: "lesson_4", createdAtCheckpoint: 4 }),
      makeLesson({ id: "lesson_5", createdAtCheckpoint: 5 }),
      makeLesson({ id: "lesson_6", createdAtCheckpoint: 6 }),
      makeLesson({ id: "lesson_7", createdAtCheckpoint: 7 }),
    ]);
    // 7 active > 2*3 → 最旧的 1 条置 inactive
    const promoted = svc.promote("other", "触发窗口整理", "manual", undefined, 8);
    expect(promoted.active).toBe(true);
    // 8 active > limit 6 → 最旧的 2 条（lesson_1/2）置 inactive
    expect(svc.all().find((l) => l.id === "lesson_1")!.active).toBe(false);
    expect(svc.all().find((l) => l.id === "lesson_2")!.active).toBe(false);
    expect(svc.all().find((l) => l.id === "lesson_3")!.active).toBe(true);
    expect(svc.all().filter((l) => l.active)).toHaveLength(6);
  });
});
