/**
 * Director "future plan" types and zod schemas (narrative director, Task 1).
 * Pure types + schema only — no runtime logic.
 *
 * A DirectorPlan is the model's plan for the upcoming horizon: the current
 * goal, the beats to play, the threads to keep in focus, the setup
 * directives snapshot and the reveal locks that must not be confirmed.
 * `SetupDirective` lives here (not in narrative-brief.ts) so the
 * narrative-brief <-> director-plan schema circular dependency is broken.
 */

import { z } from "zod";

export type DirectorPhase =
  | "setup"
  | "development"
  | "escalation"
  | "revelation"
  | "climax"
  | "resolution";

export interface PlannedBeat {
  purpose: string;
}

export interface AnchorOp {
  type: "reach" | "pass";
  id: string;
}

/** Migrated verbatim from narrative-brief.ts (Task 1 relocation). */
export interface SetupDirective {
  id: string;
  action: "seed" | "reinforce" | "payoff" | "hold";
  urgency: "now" | "soon" | "normal";
  /** 伏笔前提（作者预设文字）——Writer 需要知道这个 ID 具体指什么。 */
  premise?: string;
  /** 仅 action === "payoff" 时携带——避免提前把真相泄露给 Writer。 */
  payoff?: string;
}

export interface DirectorPlan {
  revision: number;               // 计划代数（服务自增，模型不输出）
  basedOnMemoryRevision: number;  // 生成时的 memory.revision 快照
  phase: DirectorPhase;
  currentGoal: string;            // ≤200 字
  beats: PlannedBeat[];           // 1..6 条，每条 purpose ≤200 字
  focusThreads: string[];         // 去重，≤6，必须引用现有非终结线程
  setupDirectives: SetupDirective[];  // SetupScheduler 快照（计划生成时）
  revealLocks: string[];          // 去重，≤8，不得确认为事实的揭示项
  expiresAfterCheckpoint: number; // = 生成时 checkpointCount + horizon（服务计算）
}

// 上限常量（zod schema 与 adapter prompt 共用同一来源）
export const MAX_PLAN_BEATS = 6;
export const MAX_FOCUS_THREADS = 6;
export const MAX_REVEAL_LOCKS = 8;
export const MAX_ANCHOR_OPS = 8;
export const MAX_CURRENT_GOAL_LENGTH = 200;
export const MAX_BEAT_PURPOSE_LENGTH = 200;

export const DirectorPhaseSchema: z.ZodType<DirectorPhase> = z.enum([
  "setup",
  "development",
  "escalation",
  "revelation",
  "climax",
  "resolution",
]);

export const PlannedBeatSchema: z.ZodType<PlannedBeat> = z.object({
  purpose: z.string().min(1).max(MAX_BEAT_PURPOSE_LENGTH),
});

export const AnchorOpSchema = z.object({
  type: z.enum(["reach", "pass"]),
  id: z.string().min(1),
});

export const SetupDirectiveSchema: z.ZodType<SetupDirective> = z.object({
  id: z.string().min(1),
  action: z.enum(["seed", "reinforce", "payoff", "hold"]),
  urgency: z.enum(["now", "soon", "normal"]),
  premise: z.exactOptional(z.string().min(1)),
  payoff: z.exactOptional(z.string().min(1)),
});

export const DirectorPlanSchema: z.ZodType<DirectorPlan> = z.object({
  revision: z.number().int().nonnegative(),
  basedOnMemoryRevision: z.number().int().nonnegative(),
  phase: DirectorPhaseSchema,
  currentGoal: z.string().min(1).max(MAX_CURRENT_GOAL_LENGTH),
  beats: z.array(PlannedBeatSchema).min(1).max(MAX_PLAN_BEATS),
  focusThreads: z.array(z.string().min(1)).max(MAX_FOCUS_THREADS),
  setupDirectives: z.array(SetupDirectiveSchema),
  revealLocks: z.array(z.string().min(1)).max(MAX_REVEAL_LOCKS),
  expiresAfterCheckpoint: z.number().int().nonnegative(),
});
