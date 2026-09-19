/**
 * Narrative-memory operation types and zod schemas (narrative director,
 * Task 1). Pure types + schemas only — no runtime logic.
 */

import { z } from "zod";

import type { EpisodeImportance, PlotThreadKind } from "./memory-types.js";

export interface ThreadOp {
  type: "touch" | "advance" | "resolve" | "abandon" | "create";
  id: string;
  progress?: string;
  /** create 专用：新线程类型（audit P1-8）。 */
  kind?: PlotThreadKind;
  /** create 专用：importance 决定预算口径（major 查 major 预算）。 */
  importance?: "major" | "minor";
}

export interface SetupOp {
  type: "seed" | "reinforce" | "payoff" | "hold" | "drop";
  id: string;
  evidenceEventIds?: string[];
}

export interface EpisodeSummaryOp {
  summary: string;
  characters: string[];
  locations: string[];
  threads: string[];
  setups: string[];
  importance: EpisodeImportance;
}

// ---------------------------------------------------------------------------
// MA-B（记忆 spec §5.2/§6.1/§9.2）：consolidator 输出契约扩展
// ---------------------------------------------------------------------------

/** 既定事实 op（§5.2）。establish 每批 ≤3；amend 不限量（纠错优先）。 */
export interface FactOp {
  type: "establish" | "amend";
  /** amend 必填：指向被修订的 fact。 */
  id?: string;
  /** 条件句式 ≤120 字。 */
  content: string;
  /** 1..3 条证据事件 seq（必须落在本批范围内）。 */
  evidenceEventSeqs: number[];
  scope?: { characters?: string[]; location?: string };
  importance?: "major" | "minor";
}

/** 角色认知 op（§6.1）。learn=获知、believe=可能错误的信念、correct=纠正。 */
export interface BeliefOp {
  type: "learn" | "believe" | "correct";
  characterId: string;
  /** 命题式 ≤80 字。 */
  content: string;
  evidenceEventSeqs: number[];
  /** correct 必填：被纠正的 belief id。 */
  replacesBeliefId?: string;
}

/** 审计发现（§9.2）。只产事实与判级，不触发回改；major+ 自动成 lesson。 */
export interface AuditFinding {
  dimension: "belief-violation" | "fact-conflict" | "character-consistency";
  severity: "critical" | "major" | "normal" | "minor";
  /** ≤120 字事实描述（不含改写建议）。 */
  content: string;
  evidenceEventSeqs: number[];
  subject?: string;
}

export const ThreadOpSchema: z.ZodType<ThreadOp> = z
  .object({
    type: z.enum(["touch", "advance", "resolve", "abandon", "create"]),
    id: z.string().min(1),
    progress: z.exactOptional(z.string().min(1)),
    kind: z.exactOptional(
      z.enum(["main", "character", "mystery", "relationship", "promise"]),
    ),
    importance: z.exactOptional(z.enum(["major", "minor"])),
  })
  .superRefine((op, ctx) => {
    if (op.type === "create") {
      if (op.kind === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["kind"],
          message: "create 必须携带 kind",
        });
      }
      if (op.importance === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["importance"],
          message: "create 必须携带 importance",
        });
      }
    }
  });

export const SetupOpSchema: z.ZodType<SetupOp> = z.object({
  type: z.enum(["seed", "reinforce", "payoff", "hold", "drop"]),
  id: z.string().min(1),
  evidenceEventIds: z.exactOptional(z.array(z.string().min(1))),
});

export const EpisodeSummaryOpSchema: z.ZodType<EpisodeSummaryOp> = z.object({
  summary: z.string().min(1),
  characters: z.array(z.string().min(1)),
  locations: z.array(z.string().min(1)),
  threads: z.array(z.string().min(1)),
  setups: z.array(z.string().min(1)),
  importance: z.enum(["major", "normal"]),
});

const EvidenceSeqsSchema = z
  .array(z.number().int().positive())
  .min(1)
  .max(3);

export const FactOpSchema: z.ZodType<FactOp> = z.object({
  type: z.enum(["establish", "amend"]),
  id: z.exactOptional(z.string().min(1)),
  content: z.string().min(1).max(120),
  evidenceEventSeqs: EvidenceSeqsSchema,
  scope: z.exactOptional(
    z.object({
      characters: z.exactOptional(z.array(z.string().min(1))),
      location: z.exactOptional(z.string().min(1)),
    }),
  ),
  importance: z.exactOptional(z.enum(["major", "minor"])),
});

export const BeliefOpSchema: z.ZodType<BeliefOp> = z.object({
  type: z.enum(["learn", "believe", "correct"]),
  characterId: z.string().min(1),
  content: z.string().min(1).max(80),
  evidenceEventSeqs: EvidenceSeqsSchema,
  replacesBeliefId: z.exactOptional(z.string().min(1)),
});

export const AuditFindingSchema: z.ZodType<AuditFinding> = z.object({
  dimension: z.enum(["belief-violation", "fact-conflict", "character-consistency"]),
  severity: z.enum(["critical", "major", "normal", "minor"]),
  content: z.string().min(1).max(120),
  evidenceEventSeqs: EvidenceSeqsSchema,
  subject: z.exactOptional(z.string().min(1)),
});

/** A rejected narrative operation, recorded for diagnostics/feedback. */
export interface RejectedOp {
  // plan = plan proposal rejected as a whole / field-level rejection,
  // anchor = anchor op rejected, finding = audit finding 留痕（§9.2），
  // fact/belief = 对应 op 被拒（MA-B）。
  kind: "thread" | "setup" | "episode" | "plan" | "anchor" | "finding" | "fact" | "belief";
  op: unknown;
  reason: string;
  /**
   * 稳定拒绝规则码（如 SETUP_SEED_WITHOUT_INTENDED_PAYOFF，MA-A §7.2 来源 2
   * 的 lesson 自动晋升计数键）。由 `[CODE] reason` 前缀解析，无码为 undefined。
   */
  rule?: string;
  /**
   * §6.2 结构化身份/引用问题（C8）：身份/引用非法的拒绝携带 code/path/value，
   * 供定向修复与审计；纯规则拒绝（预算、状态机、形状）不携带。
   */
  issues?: readonly IdentityValidationIssue[];
}

// ---------------------------------------------------------------------------
// §6.2 显式提案校验结果（campus / main 双分支共用，字段与计划 §6.2 逐字一致）
// ---------------------------------------------------------------------------

/**
 * 身份/引用校验问题。code 四值逐字取自计划 §6.2：
 * - UNKNOWN_CHARACTER_ID：标签不是注册表稳定 ID（含显示名误填、未知 ID、危险键）；
 * - EVIDENCE_OUT_OF_RANGE：证据引用不在已提交事件区间内；
 * - KNOWLEDGE_NOT_SUPPORTED：角色已注册但既不在允许集合也无证据登场（campus）；
 *   main 的 belief 获知校验（M2）复用本 code；
 * - INVALID_REFERENCE：引用了权威集合之外的 id（threads/setups/locations 标签）。
 */
export interface IdentityValidationIssue {
  code:
    | "UNKNOWN_CHARACTER_ID"
    | "EVIDENCE_OUT_OF_RANGE"
    | "KNOWLEDGE_NOT_SUPPORTED"
    | "INVALID_REFERENCE";
  /** 字段路径，如 `episode.characters[1]`、`setupOps[0].evidenceEventIds[2]`。 */
  path: string;
  /** 违规原值（字符串化；证据引用本身即字符串 seq）。 */
  value: string;
}

/**
 * 提案校验的显式结果：accepted（value + 空 issues）或 rejected（非空
 * issues）。合法空提案 = accepted no-op；身份/引用非法 = rejected——绝不
 * 用过滤后的空数组伪装成功。
 */
export type ValidatedProposal<T> =
  | { status: "accepted"; value: T; issues: [] }
  | { status: "rejected"; issues: IdentityValidationIssue[] };
