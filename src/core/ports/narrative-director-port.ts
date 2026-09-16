/**
 * Narrative director port (Task 6).
 *
 * The narrative director is the composition root of the narrative-memory
 * layer. It owns the in-memory state, exposes a synchronous brief for the
 * model, batches committed events for background consolidation, and
 * provides a public consolidatePending() for testability.
 */

import type { MemoryProjectionRequest, MemoryProjection } from "../narrative/memory-projection.js";
import type { MemoryDigest } from "../graph/types.js";
import type { StoredEvent } from "../../schema.js";

export type NarrativeCheckpointReason =
  | "interaction_completed"
  | "segment_ended"
  | "scene_change";

export interface NarrativeDirectorPort {
  /** Synchronous per-turn memory projection for the model (剪报输入). */
  getMemoryProjection(request: MemoryProjectionRequest): MemoryProjection;

  /**
   * 当前记忆子层摘要——决策节点入口/末态快照的唯一记忆真源
   * （执行清单 M1.1 决议）。必须是纯读取：不触发整理、不改状态。
   */
  getMemoryDigest(): MemoryDigest;

  /**
   * 从决策节点快照的 digest 重建记忆态（恢复路径；替代 initialize 的
   * store.load 分支）。episodes 缓存从空重新积累。
   */
  restoreFromDigest(digest: MemoryDigest): void;

  /** Enqueue committed events and optionally schedule consolidation. */
  observeCommitted(events: readonly StoredEvent[]): void;

  /** Increment checkpointCount and optionally schedule consolidation. */
  checkpoint(reason: NarrativeCheckpointReason): void;

  /** 正常关停：整理最后的 pending 事件并确保计划落盘（幂等）。 */
  flush(): Promise<void>;
}
