/**
 * Narrative-memory store port (narrative director, Task 4).
 *
 * The narrative-memory layer depends on this interface, never on a concrete
 * filesystem layout. Implementations own all persistence concerns for the
 * three artifacts: the consolidated state snapshot, the episode log, and the
 * rejected-op log.
 */

import type { EpisodeMemory, NarrativeMemoryState } from "../narrative/memory-types.js";
import type { RejectedOp } from "../narrative/memory-operation.js";
import type { DirectorPlan } from "../narrative/director-plan.js";

export interface NarrativeMemoryStorePort {
  /** Human-readable location of the store (directory or file path). */
  readonly location: string;

  /**
   * Load the persisted state and episodes. Missing or corrupt files degrade
   * to empty values — this never throws for storage problems.
   */
  load(): Promise<{ state: NarrativeMemoryState; episodes: EpisodeMemory[] }>;

  /** Persist the full consolidated state snapshot (atomic where supported). */
  saveState(state: NarrativeMemoryState): Promise<void>;

  /** Append episodes to the episode log. */
  appendEpisodes(episodes: EpisodeMemory[]): Promise<void>;

  /** Append rejected narrative operations to the diagnostics log. */
  appendOps(ops: RejectedOp[]): Promise<void>;

  /**
   * Load the persisted director plan, or null when no plan is stored yet or
   * the stored file is missing/corrupt. This never throws for storage
   * problems.
   */
  loadPlan(): Promise<DirectorPlan | null>;

  /** Persist the director plan (atomic where supported). */
  savePlan(plan: DirectorPlan): Promise<void>;
}
