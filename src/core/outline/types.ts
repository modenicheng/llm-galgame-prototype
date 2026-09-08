/**
 * v2 大纲图契约 ——
 * docs/superpowers/specs/2026-09-09-game-graph-architecture-design.md §4。
 *
 * 大纲节点粒度为幕级，与剧情图的场景节点 1:1（SceneNode.outlineRef）。
 * 状态机：planned → active → realized（正向）；realized 与 pruned 为终态
 * （已实现即冻结，剪枝不可逆——修订留痕在 outline 修订日志，不改写历史）。
 * 纯类型、纯 schema 与纯迁移谓词，无 IO。
 */

import { z } from "zod";
import type { SceneId } from "../graph/ids.js";
import { OutlineNodeIdSchema } from "../graph/ids.js";

export type OutlineNodeStatus = "planned" | "active" | "realized" | "pruned";

export interface OutlineNode {
  id: string;
  /** 节拍目的，≤200 字；禁写台词（冰山原则）。 */
  purpose: string;
  kind: "act" | "ending";
  status: OutlineNodeStatus;
  /** realized 时回填：实例化它的场景节点。 */
  instantiatedBy?: SceneId;
}

export const OUTLINE_PURPOSE_MAX_LENGTH = 200;

export const OutlineNodeSchema: z.ZodType<OutlineNode> = z.object({
  id: OutlineNodeIdSchema,
  purpose: z.string().min(1).max(OUTLINE_PURPOSE_MAX_LENGTH),
  kind: z.enum(["act", "ending"]),
  status: z.enum(["planned", "active", "realized", "pruned"]),
  instantiatedBy: z.exactOptional(z.string()),
});

export const OUTLINE_TERMINAL_STATUSES: ReadonlySet<OutlineNodeStatus> = new Set([
  "realized",
  "pruned",
]);

/**
 * 大纲节点状态迁移谓词（纯函数）。非法迁移一律 false：
 * - planned → active | pruned
 * - active  → realized | pruned
 * - realized / pruned → 终态，不可迁移
 */
export function canTransitionOutlineStatus(
  from: OutlineNodeStatus,
  to: OutlineNodeStatus,
): boolean {
  switch (from) {
    case "planned":
      return to === "active" || to === "pruned";
    case "active":
      return to === "realized" || to === "pruned";
    case "realized":
    case "pruned":
      return false;
  }
}

/**
 * 迁移并返回新节点（不可变更新）；非法迁移返回 undefined，由调用方决定
 * 记诊断或拒绝。realized 迁移必须提供 instantiatedBy。
 */
export function transitionOutlineNode(
  node: OutlineNode,
  to: OutlineNodeStatus,
  instantiatedBy?: SceneId,
): OutlineNode | undefined {
  if (!canTransitionOutlineNode(node, to, instantiatedBy)) return undefined;
  return {
    ...node,
    status: to,
    ...(to === "realized" && instantiatedBy !== undefined ? { instantiatedBy } : {}),
  };
}

function canTransitionOutlineNode(
  node: OutlineNode,
  to: OutlineNodeStatus,
  instantiatedBy?: SceneId,
): boolean {
  if (!canTransitionOutlineStatus(node.status, to)) return false;
  if (to === "realized" && instantiatedBy === undefined) return false;
  return true;
}
