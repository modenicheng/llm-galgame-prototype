/**
 * v2 剧情图契约（v1 冻结）——
 * docs/superpowers/specs/2026-09-09-game-graph-architecture-design.md §3。
 *
 * 本模块是图结构的唯一类型与 schema 来源。字段集属于冻结契约，修订规则：
 * **删除字段、类型变更、新增必填字段**必须递增 snapshotVersion 并记录契约
 * 变更（读取方按版本拒绝或走显式升级适配器）；**新增可选字段**（读取端
 * 容忍缺省、语义向后兼容）不翻版本，但必须在本文件注释中登记（如
 * MemoryDigest.consolidationFailedIntervals 在 v3 内追加为可选、v4 转必填
 * 的先例）。不允许任何静默的字段语义改动。
 * 纯类型与纯 schema，无 IO。
 */

import { z } from "zod";
import { StoryStateSchema } from "../../story/types.js";
import {
  BeliefStateSchema,
  ConsolidationFailedIntervalSchema,
  FactRecordSchema,
  PlotThreadSchema,
  SetupPayoffSchema,
  StoryAnchorStateSchema,
} from "../narrative/memory-types.js";
import { VisualStateSchema } from "../presentation/types.js";
import {
  DANGEROUS_ID_KEYS,
  CharacterLabelSchema,
  isDangerousKey,
  isValidCharacterKey,
} from "../characters/types.js";
import { SNAPSHOT_IDENTITY_SCHEMA_VERSION } from "../ports/identity-snapshot-port.js";
import {
  DecisionIdSchema,
  EdgeIdSchema,
  EndingIdSchema,
  OutlineNodeIdSchema,
  RunIdSchema,
  SceneIdSchema,
} from "./ids.js";

/** 快照契约版本。字段集变更时递增，读取方按版本拒绝不认识的快照。
 * v2（决议 D4，MA-B）：MemoryDigest 增 facts/beliefs 全文嵌入（D6）；
 * v3（决议 D10，MA-A2）：StoryState 瘦身（删 canon/open_threads/
 * player_profile/角色富字段）；
 * v4（M3，身份 DSL）：快照增身份块 SnapshotIdentityState（身份/协议版本、
 * roster scope/revision 引用、名牌状态、cast），共享不可变 roster blob 按
 * revision 落盘、快照只引用；MemoryDigest.consolidationFailedIntervals 由
 * v3 的可选追加转必填。v3 → v4 由 reader 的显式升级适配器
 * （core/graph/snapshot-upcast.ts）在内存完成，原文件字节不动；v1/v2 沿用
 * 读取即拒策略（dev 存档废弃不做迁移）。 */
export const SNAPSHOT_VERSION = 4;

// ---------------------------------------------------------------------------
// 快照身份块（M3 v4）——身份/协议版本、roster 引用、名牌状态与 cast
// ---------------------------------------------------------------------------

/** 原型链安全的名牌记录（键 = 稳定 CharacterId；危险键预处理后仍走 record）。 */
const characterLabelsRecord = z.preprocess(
  (input, ctx) => {
    if (typeof input === "object" && input !== null) {
      for (const key of Object.keys(input)) {
        if (isDangerousKey(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `名牌键不允许使用对象原型危险键：${DANGEROUS_ID_KEYS.join("/")}`,
          });
        }
      }
    }
    return input;
  },
  z.record(
    z.string().refine(isValidCharacterKey, {
      message: "名牌键必须是合法角色 ID（字母开头，禁空白/冒号/括号）",
    }),
    CharacterLabelSchema,
  ),
);

/**
 * 快照身份块：写入时「这局用什么身份契约在演」。roster 只引用
 * {scopeId, revision}——完整人设是共享不可变 blob（按 revision 落盘于
 * world/rosters/，见 GAME_STORAGE_LAYOUT），不随每条边/快照重复。
 */
export const SnapshotIdentityStateSchema = z.object({
  /** 身份契约版本（identity-snapshot-port；与校园 F3 对齐）。 */
  identitySchemaVersion: z.literal(SNAPSHOT_IDENTITY_SCHEMA_VERSION),
  /**
   * 写入时的会话实际 DSL 协议版本（C7 wire；campus 84a68ee 终审
   * protocol-version fixity：记录落盘时 live config 生效值，非格式常量）。
   * 只接受 1|2（域外值 = 契约损坏，拒绝解析——不改写存档会话的协议版本）；
   * 跨旋钮漂移由 Game 恢复路径对照当前配置响亮诊断（路由按当前配置，
   * 不按存档重路由）。
   */
  dslProtocolVersion: z.union([z.literal(1), z.literal(2)]),
  /** roster 作用域引用（内容包/世界 id；legacy 兼容会话为 "legacy"）。 */
  rosterScopeId: z.string().min(1),
  /** roster revision 引用（blob 文件名/身份契约指纹）。 */
  rosterRevision: z.string().min(1),
  /** 名牌状态（CharacterId → 当前名牌；恢复按节点快照还原，不读当前游标）。 */
  characterLabels: characterLabelsRecord,
  /** cast 快照：允许说话人/场景参与者（汇流比较的前置条件之一）。 */
  cast: z.object({
    allowedSpeakerIds: z.array(z.string().min(1)),
    sceneParticipantIds: z.array(z.string().min(1)),
  }),
});
export type SnapshotIdentityState = z.infer<typeof SnapshotIdentityStateSchema>;

// ---------------------------------------------------------------------------
// 交互表单快照 — 决策节点上"当时呈现给玩家的表单"
// ---------------------------------------------------------------------------

export const InteractionFormSnapshotSchema = z
  .object({
    mode: z.enum(["choice", "input", "hybrid"]),
    /** 当时呈现给玩家的表单提示语（恢复重放表单时原样还原）。 */
    prompt: z.string().min(1),
    /** choice/hybrid 的选项文本（运行时生成的 id 不入契约，文本即语义）。 */
    options: z.exactOptional(z.array(z.string().min(1))),
    /** input/hybrid 的输入框提示语。 */
    placeholder: z.exactOptional(z.string().min(1)),
  })
  .refine(
    (form) =>
      form.mode === "choice"
        ? (form.options?.length ?? 0) >= 1 && form.placeholder === undefined
        : form.mode === "input"
          ? form.options === undefined && form.placeholder !== undefined
          : (form.options?.length ?? 0) >= 1 && form.placeholder !== undefined,
    { message: "form snapshot fields must match mode" },
  );

export type InteractionFormSnapshot = z.infer<typeof InteractionFormSnapshotSchema>;

// ---------------------------------------------------------------------------
// 记忆摘要 — 决策节点入口快照中嵌入的记忆子层状态（真源，见 M1.1）
// ---------------------------------------------------------------------------

export const MemoryDigestSchema = z.object({
  revision: z.number().int().nonnegative(),
  consolidatedThroughEventSeq: z.number().int().nonnegative(),
  checkpointCount: z.number().int().nonnegative(),
  threads: z.array(PlotThreadSchema),
  setups: z.array(SetupPayoffSchema),
  anchors: z.array(StoryAnchorStateSchema),
  // MA-B（v2）：facts/beliefs 全文嵌入（决议 D6）——恢复不得依赖 canon 或
  // 会话工作缓存的可用性。
  facts: z.array(FactRecordSchema),
  beliefs: z.array(BeliefStateSchema),
  // §6.2 M2：失败整理区间随摘要入盘——恢复后成功水位仍不越过缺口，已降级
  // 区间不再重试。v3 内为可选追加（旧快照缺省 = 无失败区间）；v4 起必填
  // （快照版本是新鲜契约，v3→v4 升级适配器为旧摘要补 []）。
  consolidationFailedIntervals: z.array(ConsolidationFailedIntervalSchema),
});
export type MemoryDigest = z.infer<typeof MemoryDigestSchema>;

// ---------------------------------------------------------------------------
// 状态快照 — 回溯恢复、汇流比较、结算统计的共同货币（设计 §3.2）
// ---------------------------------------------------------------------------

export const StateSnapshotSchema = z.object({
  snapshotVersion: z.literal(SNAPSHOT_VERSION),
  storyState: StoryStateSchema,
  visualState: VisualStateSchema,
  memoryDigest: MemoryDigestSchema,
  outlineRevision: z.number().int().nonnegative(),
  /** M3（v4）：身份块——见 SnapshotIdentityStateSchema。 */
  identity: SnapshotIdentityStateSchema,
});
export type StateSnapshot = z.infer<typeof StateSnapshotSchema>;

// ---------------------------------------------------------------------------
// 图节点与边（设计 §3.1）
// ---------------------------------------------------------------------------

export const SceneNodeSchema = z.object({
  id: SceneIdSchema,
  outlineRef: OutlineNodeIdSchema,
  status: z.enum(["active", "realized"]),
});
export type SceneNode = z.infer<typeof SceneNodeSchema>;

export const DecisionNodeSchema = z.object({
  id: DecisionIdSchema,
  sceneId: SceneIdSchema,
  entryState: StateSnapshotSchema,
  form: InteractionFormSnapshotSchema,
});
export type DecisionNode = z.infer<typeof DecisionNodeSchema>;

/** 边负载统计：payloads/<edgeId>.jsonl 内恰好 eventCount 条 seq 单调的已提交事件。 */
export const EdgePayloadStatsSchema = z
  .object({
    eventCount: z.number().int().nonnegative(),
    firstSeq: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
  })
  .refine(
    (stats) =>
      stats.eventCount === 0
        ? stats.firstSeq === 0 && stats.lastSeq === 0
        : stats.firstSeq >= 1 && stats.firstSeq <= stats.lastSeq,
    { message: "payload stats must describe a non-empty seq range or be all-zero" },
  );
export type EdgePayloadStats = z.infer<typeof EdgePayloadStatsSchema>;

export const EdgeEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("decision"), id: DecisionIdSchema }),
  z.object({ kind: z.literal("ending"), id: EndingIdSchema }),
]);
export type EdgeEndpoint = z.infer<typeof EdgeEndpointSchema>;

export const ConfluenceEvidenceSchema = z.object({
  matchedNode: DecisionIdSchema,
  judgedBy: z.string().min(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
});
export type ConfluenceEvidence = z.infer<typeof ConfluenceEvidenceSchema>;

/** 汇流凭据与终点的一致性：命中哪个节点，边就指向哪个节点（§3.3）。 */
export const PlotEdgeSchema = z
  .object({
    id: EdgeIdSchema,
    from: DecisionIdSchema,
    choice: z.object({
      kind: z.enum(["option", "free_input"]),
      text: z.string().min(1),
    }),
    payload: EdgePayloadStatsSchema,
    endState: StateSnapshotSchema,
    to: EdgeEndpointSchema,
    /** 汇流成立时的判定凭据（指向既有后继节点即为汇流，见设计 §3.3）。 */
    confluence: ConfluenceEvidenceSchema.optional(),
  })
  .refine(
    (edge) =>
      edge.confluence === undefined ||
      (edge.to.kind === "decision" && edge.to.id === edge.confluence.matchedNode),
    { message: "confluence evidence must target the edge's own successor node" },
  );
export type PlotEdge = z.infer<typeof PlotEdgeSchema>;

export const EndingNodeSchema = z.object({
  id: EndingIdSchema,
  outlineRef: OutlineNodeIdSchema.optional(),
});
export type EndingNode = z.infer<typeof EndingNodeSchema>;

// ---------------------------------------------------------------------------
// 周目（设计 §6）：游标 + 统计 + 流水，非记忆容器
// ---------------------------------------------------------------------------

export const RunRecordSchema = z
  .object({
    id: RunIdSchema,
    origin: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("root") }),
      z.object({ kind: z.literal("retrace"), from: DecisionIdSchema }),
    ]),
    startedAt: z.string().min(1),
    endedAt: z.string().optional(),
    ending: EndingIdSchema.optional(),
    /** 中止游玩的所在节点；图上节点如实存在，不另设弃局标记。 */
    abandonedAt: DecisionIdSchema.optional(),
  })
  .refine((run) => run.ending === undefined || run.endedAt !== undefined, {
    message: "a run that reached an ending must record endedAt",
  })
  .refine(
    (run) => run.abandonedAt === undefined || (run.endedAt === undefined && run.ending === undefined),
    { message: "an abandoned run must not also be recorded as ended" },
  );
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const ActiveCursorSchema = z.object({
  runId: RunIdSchema,
  position: DecisionIdSchema,
});
export type ActiveCursor = z.infer<typeof ActiveCursorSchema>;
