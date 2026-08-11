/**
 * Narrative director port (Task 6).
 *
 * The narrative director is the composition root of the narrative-memory
 * layer. It owns the in-memory state, exposes a synchronous brief for the
 * model, batches committed events for background consolidation, and
 * provides a public consolidatePending() for testability.
 */

import type { NarrativeBriefRequest, NarrativeBrief } from "../narrative/narrative-brief.js";
import type { StoredEvent } from "../../schema.js";

export type NarrativeCheckpointReason =
  | "interaction_completed"
  | "segment_ended"
  | "scene_change";

export interface NarrativeDirectorPort {
  /** Synchronous per-turn digest for the model. */
  getBrief(request: NarrativeBriefRequest): NarrativeBrief;

  /** Enqueue committed events and optionally schedule consolidation. */
  observeCommitted(events: readonly StoredEvent[]): void;

  /** Increment checkpointCount and optionally schedule consolidation. */
  checkpoint(reason: NarrativeCheckpointReason): void;

  /** 正常关停：整理最后的 pending 事件并确保计划落盘（幂等）。 */
  flush(): Promise<void>;
}
