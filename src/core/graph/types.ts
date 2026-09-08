/**
 * v2 剧情图契约（v1 冻结）——
 * docs/superpowers/specs/2026-09-09-game-graph-architecture-design.md §3。
 *
 * 本模块是图结构的唯一类型与 schema 来源。字段集属于冻结契约：增删字段
 * 必须修订 snapshotVersion 并记录契约变更，不允许静默改动。
 * 纯类型与纯 schema，无 IO。
 */

import { z } from "zod";
import { StoryStateSchema } from "../../story/types.js";
import {
  PlotThreadSchema,
  SetupPayoffSchema,
  StoryAnchorStateSchema,
} from "../narrative/memory-types.js";
import { VisualStateSchema } from "../presentation/types.js";
import {
  DecisionIdSchema,
  EdgeIdSchema,
  EndingIdSchema,
  OutlineNodeIdSchema,
  RunIdSchema,
  SceneIdSchema,
} from "./ids.js";

/** 快照契约版本。字段集变更时递增，读取方按版本拒绝不认识的快照。 */
export const SNAPSHOT_VERSION = 1;

// ---------------------------------------------------------------------------
// 交互表单快照 — 决策节点上"当时呈现给玩家的表单"
// ---------------------------------------------------------------------------

export const InteractionFormSnapshotSchema = z
  .object({
    mode: z.enum(["choice", "input", "hybrid"]),
    /** choice/hybrid 的选项文本（运行时生成的 id 不入契约，文本即语义）。 */
    options: z.array(z.string().min(1)).optional(),
    /** input/hybrid 的输入框提示语。 */
    placeholder: z.string().optional(),
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
  // facts / beliefs（memory-audit Phase B）落地后加入；加入即 SNAPSHOT_VERSION 修订。
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

export const PlotEdgeSchema = z.object({
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
});
export type PlotEdge = z.infer<typeof PlotEdgeSchema>;

export const EndingNodeSchema = z.object({
  id: EndingIdSchema,
  outlineRef: OutlineNodeIdSchema.optional(),
});
export type EndingNode = z.infer<typeof EndingNodeSchema>;

// ---------------------------------------------------------------------------
// 周目（设计 §6）：游标 + 统计 + 流水，非记忆容器
// ---------------------------------------------------------------------------

export const RunRecordSchema = z.object({
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
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const ActiveCursorSchema = z.object({
  runId: RunIdSchema,
  position: DecisionIdSchema,
});
export type ActiveCursor = z.infer<typeof ActiveCursorSchema>;
