/**
 * Narrative-memory store port (narrative director, Task 4).
 *
 * The narrative-memory layer depends on this interface, never on a concrete
 * filesystem layout. Implementations own all persistence concerns for the
 * three artifacts: the consolidated state snapshot, the episode log, and the
 * rejected-op log.
 */

import type {
  EpisodeMemory,
  FactRecord,
  Lesson,
  NarrativeMemoryState,
  EndingReport,
} from "../narrative/memory-types.js";
import type { RejectedOp } from "../narrative/memory-operation.js";

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

  // ---------------------------------------------------------------------
  // MA-A 存储通道（记忆 spec §5.3/§7.3/§8.4）：lessons.jsonl / facts.jsonl /
  // ending-report.json。Phase A 建通道，rejection 晋升已是 lessons 写入者，
  // facts/ending-report 的写入者随 MA-B/本卡 ending 路径落地。
  // ---------------------------------------------------------------------

  /** Append lessons to the append-only lesson log. */
  appendLessons(lessons: Lesson[]): Promise<void>;

  /** Load the lesson log; corrupt lines are skipped, never throws. */
  loadLessons(): Promise<Lesson[]>;

  /** Append fact records to the append-only facts log. */
  appendFacts(records: FactRecord[]): Promise<void>;

  /** Load the facts log; corrupt lines are skipped, never throws. */
  loadFacts(): Promise<FactRecord[]>;

  /** Persist the ending report (atomic write); overwrite on each ending. */
  writeEndingReport(report: EndingReport): Promise<void>;
}
