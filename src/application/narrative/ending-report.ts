/**
 * 终局报告聚合（记忆 spec §8.4，MA-A）——确定性纯函数，无 LLM。
 *
 * 触发：EndEvent（type "end"）经 observeCommitted 到达导演时异步聚合，
 * 产物写 `sessions/<id>/ending-report.json`。它是成就/收集系统（TODO 第 5
 * 条）与 M5.4 结算页的现成数据源；M5.4 复用本聚合，不另建第二套。
 */

import type {
  EndingReport,
  Lesson,
  NarrativeMemoryState,
} from "../../core/narrative/memory-types.js";

/**
 * 聚合终局报告：
 * - 伏笔回收率 = paid_off / (paid_off + dropped + 结算时仍 active 含 planned)；
 * - threads 终态分布 + 仍开放数；
 * - active lessons 摘要附后（occurrences 降序）。
 */
export function buildEndingReport(
  memory: NarrativeMemoryState,
  lessons: readonly Lesson[],
  generatedAt: string,
): EndingReport {
  let paidOff = 0;
  let dropped = 0;
  let active = 0;
  for (const setup of Object.values(memory.setups)) {
    if (setup.status === "paid_off") paidOff += 1;
    else if (setup.status === "dropped") dropped += 1;
    else active += 1;
  }
  const denominator = paidOff + dropped + active;

  let resolved = 0;
  let abandoned = 0;
  let openThreads = 0;
  for (const thread of Object.values(memory.threads)) {
    if (thread.status === "resolved") resolved += 1;
    else if (thread.status === "abandoned") abandoned += 1;
    else openThreads += 1;
  }

  return {
    generatedAt,
    setups: {
      paidOff,
      dropped,
      active,
      payoffRate: denominator === 0 ? 0 : paidOff / denominator,
    },
    threads: {
      resolved,
      abandoned,
      active: openThreads,
    },
    lessons: lessons
      .filter((l) => l.active)
      .sort((a, b) => b.occurrences - a.occurrences)
      .map((l) => ({
        id: l.id,
        tag: l.tag,
        content: l.content,
        occurrences: l.occurrences,
      })),
  };
}
