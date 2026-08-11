/**
 * Pure setup scheduling helpers shared by NarrativeDirectorService and the
 * future PlotPlanner (Task 3 extraction).
 *
 * `computeCurrentAnchorId` was extracted from the service's private
 * method and reworked for prerequisites-DAG ordering (audit P1-5);
 * `scheduleSetups` replaces the inline getBrief directive pipeline
 * (same filter set, same classifySetup semantics, same output shape).
 */

import type { SetupPayoff, StoryAnchorState } from "../../core/narrative/memory-types.js";
import type { SetupDirective } from "../../core/narrative/director-plan.js";
import { classifySetup } from "./memory-validator.js";
import { NON_TERMINAL_SETUP_STATUSES } from "./memory-consolidator.js";

/**
 * 当前剧情路标 = 前置全部满足的 pending 锚点，按作者声明顺序取最先
 * （audit P1-5）。顺序由 prerequisites DAG + 声明顺序决定——ID 字典序
 * 不携带叙事时序语义，不能作为排序依据。
 *
 * 无声明顺序（orderById 未提供，例如测试或旧持久化数据）时退回 id 字典序，
 * 保证确定性。
 */
export function computeCurrentAnchorId(
  anchors: Readonly<Record<string, StoryAnchorState>>,
  orderById?: ReadonlyMap<string, number>,
): string | undefined {
  const sorted = Object.values(anchors).sort((a, b) => {
    const oa = orderById?.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const ob = orderById?.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.id.localeCompare(b.id);
  });

  for (const anchor of sorted) {
    if (anchor.status !== "pending") continue;
    const ready = anchor.prerequisites.every((prereq) => {
      const resolved = anchors[prereq];
      return (
        resolved !== undefined &&
        (resolved.status === "reached" || resolved.status === "passed")
      );
    });
    if (ready) return anchor.id;
  }
  return undefined;
}

/**
 * Classify every non-terminal setup into a directive, dropping setups the
 * validator does not want scheduled (paid_off/dropped). `satisfied` decides
 * whether a setup's prerequisites are met (fed to classifySetup's gate).
 * Input order is preserved.
 */
export function scheduleSetups(
  setups: readonly SetupPayoff[],
  checkpoint: number,
  currentAnchorId: string | undefined,
  satisfied: (id: string) => boolean,
): SetupDirective[] {
  return setups
    .filter((s) => NON_TERMINAL_SETUP_STATUSES.has(s.status))
    .map((s) => classifySetup(s, checkpoint, currentAnchorId, satisfied(s.id)))
    .filter((d): d is SetupDirective => d !== undefined);
}
