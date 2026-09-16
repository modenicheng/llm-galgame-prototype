/**
 * SetupDirective——SetupScheduler 快照的伏笔指令。纯类型 + schema。
 *（M4.4：自 director-plan.ts 收缩而来——DirectorPlan/PlannedBeat/
 * DirectorPhase/AnchorOp 等规划契约已随 PlotPlanner 删除。）
 */

import { z } from "zod";

export interface SetupDirective {
  id: string;
  /** resolve_or_drop = 强制了断第三档（记忆 spec §8.3，MA-A）。 */
  action: "seed" | "reinforce" | "payoff" | "hold" | "resolve_or_drop";
  urgency: "now" | "soon" | "normal" | "overdue";
  /** 伏笔前提（作者预设文字）——Writer 需要知道这个 ID 具体指什么。 */
  premise?: string;
  /** 仅 action === "payoff" 时携带——避免提前把真相泄露给 Writer。 */
  payoff?: string;
  /** 该伏笔未声明 intendedPayoff（§8.2）：brief 标注「未定回收计划」。 */
  payoffMissing?: boolean;
}

export const SetupDirectiveSchema: z.ZodType<SetupDirective> = z.object({
  id: z.string().min(1),
  action: z.enum(["seed", "reinforce", "payoff", "hold", "resolve_or_drop"]),
  urgency: z.enum(["now", "soon", "normal", "overdue"]),
  premise: z.exactOptional(z.string().min(1)),
  payoff: z.exactOptional(z.string().min(1)),
  payoffMissing: z.exactOptional(z.boolean()),
});
