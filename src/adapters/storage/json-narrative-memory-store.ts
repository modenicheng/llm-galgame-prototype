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
 *
 * `load()` degrades missing or corrupt files to empty values instead of
 * throwing: corrupt state file → empty state; corrupt episode line → that
 * line is skipped.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NarrativeMemoryStorePort } from "../../core/ports/narrative-memory-store-port.js";
import type {
  EpisodeMemory,
  NarrativeMemoryState,
} from "../../core/narrative/memory-types.js";
import type { RejectedOp } from "../../core/narrative/memory-operation.js";

const STATE_FILE = "narrative-state.json";
const EPISODES_FILE = "episodes.jsonl";
const OPS_FILE = "narrative-ops.jsonl";

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

  constructor(sessionDir: string) {
    this.dir = path.resolve(sessionDir);
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

  async load(): Promise<{ state: NarrativeMemoryState; episodes: EpisodeMemory[] }> {
    let state: NarrativeMemoryState = EMPTY_STATE;
    try {
      const raw = await readFile(this.statePath, "utf8");
      if (raw.trim().length > 0) {
        state = JSON.parse(raw) as NarrativeMemoryState;
      }
    } catch {
      // Missing or corrupt state file → empty state, never throw.
      state = EMPTY_STATE;
    }

    const episodes: EpisodeMemory[] = [];
    try {
      const raw = await readFile(this.episodesPath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          episodes.push(JSON.parse(trimmed) as EpisodeMemory);
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
}
