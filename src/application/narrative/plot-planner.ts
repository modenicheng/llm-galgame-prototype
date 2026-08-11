/**
 * PlotPlanner — director plan orchestration (narrative director, Task 6).
 *
 * Pure orchestration only: defines the PlotPlannerPort the LLM adapter
 * (Task 7) implements, the PlannerProposal schema the adapter's raw JSON
 * must satisfy, and the PlotPlanner class that turns a proposal into a
 * validated DirectorPlan (Task 8's service consumes this class). No IO
 * happens here — the port is called, never implemented.
 *
 * Never-throw contract: a missing or failing port yields a null plan with
 * no rejections; a proposal that fails the schema yields a null plan with
 * one kind-"plan" rejection. `focusThreads` are filtered to existing
 * non-terminal threads (deduped, first-seen order; dropped ids produce one
 * aggregate kind-"plan" rejection), `revealLocks` are deduped, and
 * `anchorOps` are validated sequentially against a structured-clone shadow
 * of the anchors so prerequisite chains within one batch resolve.
 */

import { z } from "zod";

import {
  DirectorPhaseSchema,
  PlannedBeatSchema,
  AnchorOpSchema,
  MAX_PLAN_BEATS,
  MAX_FOCUS_THREADS,
  MAX_REVEAL_LOCKS,
  MAX_ANCHOR_OPS,
  MAX_CURRENT_GOAL_LENGTH,
  type DirectorPlan,
  type DirectorPhase,
  type PlannedBeat,
  type AnchorOp,
} from "../../core/narrative/director-plan.js";
import type {
  NarrativeMemoryState,
  StoryAnchorState,
} from "../../core/narrative/memory-types.js";
import type { RejectedOp } from "../../core/narrative/memory-operation.js";
import { scheduleSetups, computeCurrentAnchorId } from "./setup-scheduler.js";
import { setupPrerequisitesSatisfied } from "./memory-validator.js";
import { ACTIVE_THREAD_STATUSES } from "./memory-consolidator.js";
import type { NarrativeConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { StoredEvent } from "../../schema.js";

/** Cap on recent player events handed to the planner (adapter-side limit). */
export const PLANNER_RECENT_EVENTS_MAX = 10;

export interface PlotPlannerRequest {
  events: StoredEvent[];                 // 最近已提交事件（玩家走向，≤10）
  memory: NarrativeMemoryState;          // 含 anchors / checkpointCount / revision
  currentPlan: DirectorPlan | undefined; // 上一份计划（无则首次规划）
  location: string;
  characters: string[];
}

export interface PlannerProposal {
  phase: DirectorPhase;
  currentGoal: string;
  beats: PlannedBeat[];
  focusThreads: string[];
  revealLocks: string[];
  anchorOps: AnchorOp[];
}

/** Proposal bounds come from the director-plan Task 1 constants. */
export const PlannerProposalSchema: z.ZodType<PlannerProposal> = z.object({
  phase: DirectorPhaseSchema,
  currentGoal: z.string().min(1).max(MAX_CURRENT_GOAL_LENGTH),
  beats: z.array(PlannedBeatSchema).min(1).max(MAX_PLAN_BEATS),
  focusThreads: z.array(z.string().min(1)).max(MAX_FOCUS_THREADS),
  revealLocks: z.array(z.string().min(1)).max(MAX_REVEAL_LOCKS),
  anchorOps: z.array(AnchorOpSchema).max(MAX_ANCHOR_OPS),
});

/** LLM adapter port (implemented in Task 7). */
export interface PlotPlannerPort {
  plan(request: PlotPlannerRequest): Promise<PlannerProposal>;
}

export interface PlannerOutcome {
  plan: DirectorPlan | null;   // port 失败或提案整体非法 → null
  anchorOps: AnchorOp[];       // 通过链式前置校验的子集
  rejected: RejectedOp[];      // kind: "plan"（字段级/整体）| "anchor"（单条）
}

/**
 * Validate one anchor op against the current anchor state. Returns null
 * when the op may be applied, otherwise a human-readable rejection reason.
 * Checked in order: unknown id, pass-on-required (policy rule, independent
 * of status), non-pending status, unsatisfied prerequisites.
 */
export function validateAnchorOp(
  op: AnchorOp,
  anchors: Readonly<Record<string, StoryAnchorState>>,
): string | null {
  const anchor = anchors[op.id];
  if (anchor === undefined) {
    return `锚点 ${op.id} 不存在（未知锚点）`;
  }
  if (op.type === "pass" && anchor.required) {
    return `锚点 ${op.id} 标记为 required，不可 pass`;
  }
  if (anchor.status !== "pending") {
    return `锚点 ${op.id} 当前状态为 ${anchor.status}，非 pending 不可操作`;
  }
  for (const prereq of anchor.prerequisites) {
    const prereqAnchor = anchors[prereq];
    if (
      prereqAnchor === undefined ||
      (prereqAnchor.status !== "reached" && prereqAnchor.status !== "passed")
    ) {
      return `锚点 ${op.id} 的前置锚点 ${prereq} 缺失或未 reached/passed`;
    }
  }
  return null;
}

/**
 * Apply a validated anchor op to a memory state: set a pending anchor to
 * "reached"/"passed". Idempotent — unknown ids and non-pending anchors
 * are left untouched (validation happens upstream).
 */
export function applyAnchorOpToState(state: NarrativeMemoryState, op: AnchorOp): void {
  const anchor = state.anchors[op.id];
  if (anchor === undefined || anchor.status !== "pending") {
    return;
  }
  anchor.status = op.type === "reach" ? "reached" : "passed";
}

export class PlotPlanner {
  private readonly port: PlotPlannerPort | undefined;
  private readonly config: NarrativeConfig;
  private readonly diagnostics: DiagnosticSink;

  constructor(opts: {
    port: PlotPlannerPort | undefined;
    config: NarrativeConfig;
    diagnostics?: DiagnosticSink;
  }) {
    this.port = opts.port;
    this.config = opts.config;
    this.diagnostics = opts.diagnostics ?? silentDiagnosticSink;
  }

  /**
   * Turn a port proposal into a validated DirectorPlan.
   *
   * - No port / port failure → `{ plan: null, anchorOps: [], rejected: [] }`,
   *   never throws.
   * - Proposal failing PlannerProposalSchema → null plan + one kind-"plan"
   *   rejection carrying the zod issue detail.
   * - focusThreads filtered to existing non-terminal threads (deduped,
   *   first-seen order); dropped ids → one aggregate kind-"plan" rejection.
   * - revealLocks deduped (schema already caps at MAX_REVEAL_LOCKS).
   * - anchorOps validated sequentially against a structuredClone shadow of
   *   the anchors: each op is checked, applied to the shadow on success,
   *   then the next op is checked — so chains (reach A, then reach B whose
   *   prerequisite is A) resolve within one batch. Rejections are kind-"anchor".
   */
  async plan(request: PlotPlannerRequest): Promise<PlannerOutcome> {
    if (this.port === undefined) {
      return { plan: null, anchorOps: [], rejected: [] };
    }

    let proposal: PlannerProposal;
    try {
      proposal = await this.port.plan(request);
    } catch (err) {
      this.diagnostics.warn(
        "NarrativeDirector",
        `plan proposal failed: ${String(err)}`,
      );
      return { plan: null, anchorOps: [], rejected: [] };
    }

    const parsed = PlannerProposalSchema.safeParse(proposal);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      this.diagnostics.warn("NarrativeDirector", `plan proposal 校验失败：${detail}`);
      return {
        plan: null,
        anchorOps: [],
        rejected: [{ kind: "plan", op: proposal, reason: detail }],
      };
    }

    const { phase, currentGoal, beats, focusThreads, revealLocks, anchorOps } =
      parsed.data;

    const rejected: RejectedOp[] = [];

    // focusThreads: keep existing non-terminal threads, dedupe first-seen.
    const seenThreads = new Set<string>();
    const keptFocusThreads: string[] = [];
    const droppedFocusThreads: string[] = [];
    for (const id of focusThreads) {
      if (seenThreads.has(id)) continue;
      seenThreads.add(id);
      const thread = request.memory.threads[id];
      if (thread !== undefined && ACTIVE_THREAD_STATUSES.has(thread.status)) {
        keptFocusThreads.push(id);
      } else {
        droppedFocusThreads.push(id);
      }
    }
    if (droppedFocusThreads.length > 0) {
      rejected.push({
        kind: "plan",
        op: { focusThreads: droppedFocusThreads },
        reason: `focusThreads 引用了不存在或已终结的线程：${droppedFocusThreads.join(", ")}`,
      });
    }

    // revealLocks: dedupe preserving first-seen order (duplicates are not
    // an error — the schema already caps the pre-dedupe count).
    const keptRevealLocks = [...new Set(revealLocks)];

    // anchorOps: sequential chain on a structuredClone shadow of the
    // anchors — each op validated against the shadow, applied on pass, so
    // the next op sees it (prerequisite chains within one batch work).
    const shadow = structuredClone(request.memory.anchors);
    const appliedAnchorOps: AnchorOp[] = [];
    const shadowState: NarrativeMemoryState = {
      ...request.memory,
      anchors: shadow,
    };
    for (const op of anchorOps) {
      const reason = validateAnchorOp(op, shadow);
      if (reason !== null) {
        rejected.push({ kind: "anchor", op, reason });
        continue;
      }
      applyAnchorOpToState(shadowState, op);
      appliedAnchorOps.push(op);
    }

    const plan: DirectorPlan = {
      revision: (request.currentPlan?.revision ?? 0) + 1,
      basedOnMemoryRevision: request.memory.revision,
      phase,
      currentGoal,
      beats,
      focusThreads: keptFocusThreads,
      setupDirectives: scheduleSetups(
        Object.values(request.memory.setups),
        request.memory.checkpointCount,
        computeCurrentAnchorId(request.memory.anchors),
        (id) => {
          const setup = request.memory.setups[id];
          return (
            setup !== undefined &&
            setupPrerequisitesSatisfied(setup.prerequisites, request.memory)
          );
        },
      ),
      revealLocks: keptRevealLocks,
      expiresAfterCheckpoint:
        request.memory.checkpointCount + this.config.plan.horizon_checkpoints,
    };

    return { plan, anchorOps: appliedAnchorOps, rejected };
  }
}
