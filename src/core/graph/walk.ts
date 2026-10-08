/**
 * 剧情图边集上的共享纯函数（路径行走 / seq 统计 / 快照投影）。
 * RunGraphCoordinator 与 ConfluenceChecker 共用——置入 core 以免两个
 * 应用层模块互相依赖。
 */
import type { PlotEdge, StateSnapshot } from "./types.js";
import { SNAPSHOT_VERSION } from "./types.js";
import type { DecisionId } from "./ids.js";
import type { RuntimeMoment } from "../ports/run-graph-port.js";

/** 运行时结局快照投影（moment → 持久化契约形状）。 */
export function toStateSnapshot(moment: RuntimeMoment): StateSnapshot {
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    storyState: moment.storyState,
    visualState: moment.visualState,
    memoryDigest: moment.memoryDigest,
    outlineRevision: moment.outlineRevision,
  };
}

/**
 * 世界最大已落盘事件 seq（各边负载统计的 lastSeq 取最大）。开局段事件不
 * 入图、孤儿 payload 恢复时删除，故 recorded edges 的统计即存活事件的全集。
 */
export function worldMaxSeq(edges: readonly PlotEdge[]): number {
  return edges.reduce((max, edge) => Math.max(max, edge.payload.lastSeq), 0);
}

/** 指向 `nodeId` 的入边中最近走过的一条（payload.lastSeq 最大）。 */
export function pickLatestInEdge(edges: readonly PlotEdge[], nodeId: DecisionId): PlotEdge | undefined {
  let best: PlotEdge | undefined;
  for (const edge of edges) {
    if (edge.to.kind !== "decision" || edge.to.id !== nodeId) continue;
    if (best === undefined || edge.payload.lastSeq > best.payload.lastSeq) best = edge;
  }
  return best;
}

/**
 * 根 → `start` 的当前路径节点集（含 start）：沿「最近走过」的入边回溯。
 * 汇流候选排除该集合——把边指回自己正在走的路径即成环。
 */
export function pathAncestors(edges: readonly PlotEdge[], start: DecisionId): Set<DecisionId> {
  const visited = new Set<DecisionId>();
  let nodeId: DecisionId | null = start;
  while (nodeId !== null && !visited.has(nodeId)) {
    visited.add(nodeId);
    const inEdge = pickLatestInEdge(edges, nodeId);
    nodeId = inEdge?.from ?? null;
  }
  return visited;
}
