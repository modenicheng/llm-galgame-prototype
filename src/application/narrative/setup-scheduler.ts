/**
 * Pure setup scheduling helpers shared by NarrativeDirectorService and the
 * future PlotPlanner (Task 3 extraction).
 *
 * `computeCurrentAnchorId` was moved verbatim from the service's private
 * method; `scheduleSetups` replaces the inline getBrief directive pipeline
 * (same filter set, same classifySetup semantics, same output shape).
 */

import type { SetupPayoff, StoryAnchorState } from "../../core/narrative/memory-types.js";
import type { SetupDirective } from "../../core/narrative/director-plan.js";
import { classifySetup } from "./memory-validator.js";
import { NON_TERMINAL_SETUP_STATUSES } from "./memory-consolidator.js";

/**
 * Find the first pending anchor AFTER the most recent reached/passed
 * anchor. Returns undefined when no anchor has been reached yet.
 *
 * Anchor progression (reach/pass) is a Step-3 PlotPlanner concern; in
 * Step 1+2 no anchor can ever become reached, so this returns undefined
 * and payoffBeforeAnchor directives stay inert — the brief must not
 * claim a payoff deadline it cannot honor (audit finding 3).
 */
export function computeCurrentAnchorId(
  anchors: Readonly<Record<string, StoryAnchorState>>,
): string | undefined {
  // Sort anchors by id for determinism
  const sorted = Object.values(anchors).sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  // Find last reached/passed index
  let lastResolvedIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    const status = sorted[i]!.status;
    if (status === "reached" || status === "passed") {
      lastResolvedIdx = i;
    }
  }

  // No anchor has been reached yet → no "current" anchor exists
  // (Step 2 has no anchor-progression mechanism).
  if (lastResolvedIdx === -1) {
    return undefined;
  }

  // Look for first pending after that index
  for (let i = lastResolvedIdx + 1; i < sorted.length; i++) {
    if (sorted[i]!.status === "pending") {
      return sorted[i]!.id;
    }
  }

  return undefined;
}

/**
 * Classify every non-terminal setup into a directive, dropping setups the
 * validator does not want scheduled (paid_off/dropped). Input order is
 * preserved.
 */
export function scheduleSetups(
  setups: readonly SetupPayoff[],
  checkpoint: number,
  currentAnchorId: string | undefined,
): SetupDirective[] {
  return setups
    .filter((s) => NON_TERMINAL_SETUP_STATUSES.has(s.status))
    .map((s) => classifySetup(s, checkpoint, currentAnchorId))
    .filter((d): d is SetupDirective => d !== undefined);
}
