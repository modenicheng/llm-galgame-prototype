/**
 * LessonService — 教训库聚合/晋升/窗口管理（记忆 spec §7，MA-A）。
 *
 * 纯内存逻辑：lessons 是诊断数据不是事实记忆（硬约束 2），只增不删
 * （append-only 语义：同 tag+content 再现 = occurrences+1）；窗口管理 =
 * 超过 `lessons.brief_max * 3` 时最旧的 active 置 inactive，不做自动复审。
 *
 * Phase A 来源：rejection（同一 validator 拒绝规则码累计 ≥
 * `lessons.auto_from_rejections` 次 → 自动晋升，§7.2 来源 2）。
 * Phase B 接入 audit 来源（major+ finding 晋升）；manual 来源只留类型。
 */

import type { NarrativeConfig } from "../../config.js";
import type { RejectedOp } from "../../core/narrative/memory-operation.js";
import type { Lesson, LessonTag } from "../../core/narrative/memory-types.js";
import { rejectionRule } from "./memory-validator.js";

/** RejectedOp.kind → LessonTag 映射（伏笔流程类单列，其余归 other）。 */
function tagForKind(kind: RejectedOp["kind"]): LessonTag {
  return kind === "setup" ? "setup-flow" : "other";
}

export class LessonService {
  private lessons: Lesson[] = [];
  /** 稳定规则码 → 累计出现次数（进程内；lessons 本身经 store 持久化）。 */
  private rejectionCounts = new Map<string, number>();
  private lessonSeq = 0;

  constructor(private readonly config: NarrativeConfig) {}

  /** 注入启动时从 store 载入的既有 lessons（id 序号在其之上继续）。 */
  load(existing: readonly Lesson[]): void {
    this.lessons = [...existing];
    for (const lesson of this.lessons) {
      const m = /^lesson_(\d+)$/.exec(lesson.id);
      if (m) {
        this.lessonSeq = Math.max(this.lessonSeq, Number(m[1]));
      }
    }
  }

  all(): readonly Lesson[] {
    return this.lessons;
  }

  /**
   * brief 规避清单（§7.3）：active lessons 按 occurrences 降序 + recency
   * （新 lesson 在前），上限 `lessons.brief_max`。纯内存，供 getBrief 同步取。
   */
  briefLessons(): Lesson[] {
    return this.lessons
      .filter((l) => l.active)
      .sort((a, b) => {
        if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
        return b.createdAtCheckpoint - a.createdAtCheckpoint;
      })
      .slice(0, this.config.lessons.brief_max);
  }

  /**
   * 来源 2（rejection 自动晋升）：喂入一批被拒 op，按稳定规则码计数；
   * 达阈值时晋升/累加 lesson。返回本批新晋升或累加的 lessons（调用方
   * 负责 appendLessons 落盘）。
   */
  observeRejections(ops: readonly RejectedOp[], checkpoint: number): Lesson[] {
    const touched: Lesson[] = [];
    for (const op of ops) {
      const rule = op.rule ?? rejectionRule(op.reason);
      // 无稳定规则码的拒绝（如 planner 的自由文本 reason）不参与自动晋升——
      // 无法判定「同一规则」，跨规则合并计数会误晋升。
      if (rule === "unknown") continue;
      const count = (this.rejectionCounts.get(rule) ?? 0) + 1;
      this.rejectionCounts.set(rule, count);
      if (count < this.config.lessons.auto_from_rejections) continue;

      const tag = tagForKind(op.kind);
      const existing = this.lessons.find(
        (l) => l.tag === tag && l.content === op.reason,
      );
      if (existing !== undefined) {
        existing.occurrences += 1;
        touched.push(existing);
        continue;
      }
      if (count !== this.config.lessons.auto_from_rejections) continue;
      const lesson = this.promote(tag, op.reason, "rejection", rule, checkpoint);
      touched.push(lesson);
    }
    if (touched.length > 0) this.applyWindow();
    return touched;
  }

  /**
   * 晋升一条 lesson（来源 1 audit / 来源 3 manual 也走这里；同 tag+content
   * 幂等累加）。返回受影响的 lesson；`sourceRef` 存 finding id / 规则码。
   */
  promote(
    tag: LessonTag,
    content: string,
    source: Lesson["source"],
    sourceRef: string | undefined,
    checkpoint: number,
  ): Lesson {
    const existing = this.lessons.find(
      (l) => l.tag === tag && l.content === content,
    );
    if (existing !== undefined) {
      existing.occurrences += 1;
      return existing;
    }
    this.lessonSeq += 1;
    const lesson: Lesson = {
      id: `lesson_${this.lessonSeq}`,
      tag,
      content,
      source,
      ...(sourceRef !== undefined ? { sourceRef } : {}),
      occurrences: 1,
      active: true,
      createdAtCheckpoint: checkpoint,
    };
    this.lessons.push(lesson);
    this.applyWindow();
    return lesson;
  }

  /** 滚动窗口（§7.3）：active 超过 brief_max*3 → 最旧的置 inactive。 */
  private applyWindow(): void {
    const limit = this.config.lessons.brief_max * 3;
    const active = this.lessons.filter((l) => l.active);
    if (active.length <= limit) return;
    const retire = [...active]
      .sort((a, b) => {
        if (a.createdAtCheckpoint !== b.createdAtCheckpoint) {
          return a.createdAtCheckpoint - b.createdAtCheckpoint;
        }
        return a.id.localeCompare(b.id);
      })
      .slice(0, active.length - limit);
    for (const lesson of retire) {
      lesson.active = false;
    }
  }
}
