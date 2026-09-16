/**
 * JSON narrative-memory store (narrative director, Task 4).
 *
 * Owns all filesystem concerns for the narrative-memory layer within one
 * session directory (the same dir that holds `events.jsonl`):
 *
 * - `narrative-state.json` — full consolidated state snapshot, written
 *   atomically (write tmp file, then rename).
 * - `episodes.jsonl` — one `EpisodeMemory` JSON per line.
 * - `narrative-ops.jsonl` — one `RejectedOp` JSON per line.
 * - `director-plan.json` — the director's future plan, kept out of the
 *   consolidated state by design; written atomically like the state file.
 *
 * `load()` degrades missing or corrupt files to empty values instead of
 * throwing: corrupt state file → empty state; corrupt episode line → that
 * line is skipped. `loadPlan()` degrades the same way to `null`.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NarrativeMemoryStorePort } from "../../core/ports/narrative-memory-store-port.js";
import { DirectorPlanSchema } from "../../core/narrative/director-plan.js";
import type { DirectorPlan } from "../../core/narrative/director-plan.js";
import {
  EpisodeMemorySchema,
  FactRecordSchema,
  LessonSchema,
  NarrativeMemoryStateSchema,
} from "../../core/narrative/memory-types.js";
import type {
  EpisodeMemory,
  FactRecord,
  Lesson,
  NarrativeMemoryState,
  EndingReport,
} from "../../core/narrative/memory-types.js";
import type { RejectedOp } from "../../core/narrative/memory-operation.js";

const STATE_FILE = "narrative-state.json";
const EPISODES_FILE = "episodes.jsonl";
const OPS_FILE = "narrative-ops.jsonl";
const PLAN_FILE = "director-plan.json";
const FACTS_FILE = "facts.jsonl";
const LESSONS_FILE = "lessons.jsonl";
const ENDING_REPORT_FILE = "ending-report.json";

const EMPTY_STATE: NarrativeMemoryState = {
  revision: 0,
  consolidatedThroughEventSeq: 0,
  checkpointCount: 0,
  threads: {},
  setups: {},
  anchors: {},
  recentEpisodeIds: [],
};

export class JsonNarrativeMemoryStore implements NarrativeMemoryStorePort {
  private readonly dir: string;

  /**
   * Narrative memory is bound to ONE session: files live under
   * `<sessionDir>/<sessionId>/` (spec §6) so a new session starts with a
   * clean memory and a resumed session restores its own. Session-bound
   * event seqs can never collide with the persisted watermark.
   */
  constructor(sessionDir: string, sessionId: string) {
    this.dir = path.join(path.resolve(sessionDir), sessionId);
  }

  get location(): string {
    return this.dir;
  }

  private get statePath(): string {
    return path.join(this.dir, STATE_FILE);
  }

  private get episodesPath(): string {
    return path.join(this.dir, EPISODES_FILE);
  }

  private get opsPath(): string {
    return path.join(this.dir, OPS_FILE);
  }

  private get planPath(): string {
    return path.join(this.dir, PLAN_FILE);
  }

  async load(): Promise<{ state: NarrativeMemoryState; episodes: EpisodeMemory[] }> {
    let state: NarrativeMemoryState = EMPTY_STATE;
    try {
      const raw = await readFile(this.statePath, "utf8");
      if (raw.trim().length > 0) {
        const parsed: unknown = JSON.parse(raw);
        // Structural corruption (valid JSON, wrong shape) must degrade the
        // same way as syntax corruption: only a zod-valid state is used.
        const checked = NarrativeMemoryStateSchema.safeParse(parsed);
        if (checked.success) {
          state = checked.data;
        }
      }
    } catch {
      // Missing or corrupt state file → empty state, never throw.
      state = EMPTY_STATE;
    }

    const episodes: EpisodeMemory[] = [];
    const seenIds = new Set<string>();
    try {
      const raw = await readFile(this.episodesPath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          const checked = EpisodeMemorySchema.safeParse(parsed);
          if (checked.success) {
            // Dedupe by id: a failed persist retry may append the same
            // episode id twice (id is revision-derived and idempotent).
            if (!seenIds.has(checked.data.id)) {
              seenIds.add(checked.data.id);
              episodes.push(checked.data);
            }
          }
        } catch {
          // Corrupt single episode line → skip it, keep the rest.
        }
      }
    } catch {
      // Missing episodes file → empty list.
    }

    return { state, episodes };
  }

  async saveState(state: NarrativeMemoryState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(state), "utf8");
    await rename(tmpPath, this.statePath);
  }

  async appendEpisodes(episodes: EpisodeMemory[]): Promise<void> {
    if (episodes.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const lines = episodes.map((ep) => JSON.stringify(ep)).join("\n");
    await appendFile(this.episodesPath, `${lines}\n`, "utf8");
  }

  async appendOps(ops: RejectedOp[]): Promise<void> {
    if (ops.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const lines = ops.map((op) => JSON.stringify(op)).join("\n");
    await appendFile(this.opsPath, `${lines}\n`, "utf8");
  }

  async loadPlan(): Promise<DirectorPlan | null> {
    try {
      const raw = await readFile(this.planPath, "utf8");
      if (raw.trim().length > 0) {
        const parsed: unknown = JSON.parse(raw);
        // Structural corruption (valid JSON, wrong shape) degrades the same
        // way as syntax corruption: only a zod-valid plan is returned.
        const checked = DirectorPlanSchema.safeParse(parsed);
        if (checked.success) {
          return checked.data;
        }
      }
    } catch {
      // Missing or corrupt plan file → no plan, never throw.
    }
    return null;
  }

  async savePlan(plan: DirectorPlan): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.planPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(plan), "utf8");
    await rename(tmpPath, this.planPath);
  }

  // ---------------------------------------------------------------------
  // MA-A 通道（facts.jsonl / lessons.jsonl / ending-report.json）。
  // jsonl 与 episodes 同模式：append-only、损坏行跳过、去重按 id。
  // ---------------------------------------------------------------------

  private get factsPath(): string {
    return path.join(this.dir, FACTS_FILE);
  }

  private get lessonsPath(): string {
    return path.join(this.dir, LESSONS_FILE);
  }

  private get endingReportPath(): string {
    return path.join(this.dir, ENDING_REPORT_FILE);
  }

  /** 泛化的 jsonl 追加（episodes/ops/facts/lessons 共用形状）。 */
  private async appendJsonl(
    filePath: string,
    rows: readonly unknown[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const lines = rows.map((row) => JSON.stringify(row)).join("\n");
    await appendFile(filePath, `${lines}\n`, "utf8");
  }

  /** 泛化的 jsonl 读取：损坏行跳过、按 id 去重、缺文件降级为空。 */
  private async loadJsonl<T>(
    filePath: string,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  ): Promise<T[]> {
    const out: T[] = [];
    const seenIds = new Set<string>();
    try {
      const raw = await readFile(filePath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          const checked = schema.safeParse(parsed);
          if (checked.success && checked.data !== undefined) {
            const id = (checked.data as { id?: string }).id;
            if (typeof id !== "string" || !seenIds.has(id)) {
              if (typeof id === "string") seenIds.add(id);
              out.push(checked.data);
            }
          }
        } catch {
          // Corrupt single line → skip it, keep the rest.
        }
      }
    } catch {
      // Missing file → empty list.
    }
    return out;
  }

  async appendFacts(records: FactRecord[]): Promise<void> {
    await this.appendJsonl(this.factsPath, records);
  }

  async loadFacts(): Promise<FactRecord[]> {
    return this.loadJsonl(this.factsPath, FactRecordSchema);
  }

  async appendLessons(lessons: Lesson[]): Promise<void> {
    await this.appendJsonl(this.lessonsPath, lessons);
  }

  async loadLessons(): Promise<Lesson[]> {
    return this.loadJsonl(this.lessonsPath, LessonSchema);
  }

  async writeEndingReport(report: EndingReport): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.endingReportPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(report, null, 2), "utf8");
    await rename(tmpPath, this.endingReportPath);
  }
}
