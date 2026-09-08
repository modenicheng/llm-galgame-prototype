/**
 * v2 剧情图 ID 规则与存储布局常量（设计 §3.1 / §9，v1 冻结契约的一部分）。
 *
 * ID 一律为 `<前缀><随机后缀>`，前缀承载类型语义，后缀允许
 * [A-Za-z0-9._-]（时间戳式、随机串式生成器都可满足）。
 * 本模块纯常量与纯 schema，无 IO。
 */

import { z } from "zod";

export const GAME_ID_PREFIX = "game_";
export const SCENE_ID_PREFIX = "sc_";
export const DECISION_ID_PREFIX = "dc_";
export const EDGE_ID_PREFIX = "eg_";
export const ENDING_ID_PREFIX = "end_";
export const RUN_ID_PREFIX = "run_";
export const OUTLINE_NODE_ID_PREFIX = "ol_";

const ID_SUFFIX = "[A-Za-z0-9._-]+";

const prefixedIdSchema = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}${ID_SUFFIX}$`));

export type GameId = string;
export type SceneId = string;
export type DecisionId = string;
export type EdgeId = string;
export type EndingId = string;
export type RunId = string;
export type OutlineNodeId = string;

export const GameIdSchema: z.ZodType<GameId> = prefixedIdSchema(GAME_ID_PREFIX);
export const SceneIdSchema: z.ZodType<SceneId> = prefixedIdSchema(SCENE_ID_PREFIX);
export const DecisionIdSchema: z.ZodType<DecisionId> = prefixedIdSchema(DECISION_ID_PREFIX);
export const EdgeIdSchema: z.ZodType<EdgeId> = prefixedIdSchema(EDGE_ID_PREFIX);
export const EndingIdSchema: z.ZodType<EndingId> = prefixedIdSchema(ENDING_ID_PREFIX);
export const RunIdSchema: z.ZodType<RunId> = prefixedIdSchema(RUN_ID_PREFIX);
export const OutlineNodeIdSchema: z.ZodType<OutlineNodeId> =
  prefixedIdSchema(OUTLINE_NODE_ID_PREFIX);

/**
 * 单个世界的存储布局（相对 `games/<gameId>/` 的 POSIX 风格相对路径）。
 * 宿主 adapter 负责与真实文件系统路径拼接；本模块不做任何 IO。
 */
export const GAME_STORAGE_LAYOUT = {
  worldCanon: "world/canon.json",
  worldCanonLog: "world/canon.log.jsonl",
  outline: "outline.json",
  outlineLog: "outline.log.jsonl",
  scenes: "graph/scenes.jsonl",
  decisions: "graph/decisions.jsonl",
  edges: "graph/edges.jsonl",
  endings: "graph/endings.jsonl",
  runs: "graph/runs.jsonl",
  payloadsDir: "graph/payloads",
  snapshotsDir: "graph/snapshots",
  cursor: "cursor.json",
  stats: "stats.json",
  assetsCatalog: "assets/resources.yaml",
} as const;

/** 某条边的负载事件文件（回放数据）。 */
export function edgePayloadPath(edgeId: EdgeId): string {
  return `${GAME_STORAGE_LAYOUT.payloadsDir}/${edgeId}.jsonl`;
}

/** 某个决策节点的入口状态快照。 */
export function decisionSnapshotPath(decisionId: DecisionId): string {
  return `${GAME_STORAGE_LAYOUT.snapshotsDir}/${decisionId}.json`;
}
