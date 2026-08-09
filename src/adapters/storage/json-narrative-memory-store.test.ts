/**
 * Tests for the JSON narrative-memory store (Task 4).
 *
 * All files are written to a mkdtemp tmp dir per test, so the suite never
 * touches real session data.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonNarrativeMemoryStore } from "./json-narrative-memory-store.js";
import type {
  EpisodeMemory,
  NarrativeMemoryState,
} from "../../core/narrative/memory-types.js";
import type { RejectedOp } from "../../core/narrative/memory-operation.js";

const EMPTY_STATE: NarrativeMemoryState = {
  revision: 0,
  consolidatedThroughEventSeq: 0,
  checkpointCount: 0,
  threads: {},
  setups: {},
  anchors: {},
  recentEpisodeIds: [],
};

function makeState(): NarrativeMemoryState {
  return {
    revision: 3,
    consolidatedThroughEventSeq: 42,
    checkpointCount: 1,
    threads: {
      main_a: {
        id: "main_a",
        kind: "main",
        summary: "主角追寻终端背后的真相。",
        status: "developing",
        importance: "major",
        introducedAt: 10,
        lastTouchedAt: 42,
        source: "runtime",
      },
    },
    setups: {},
    anchors: {
      an_1: {
        id: "an_1",
        purpose: "抵达天台",
        prerequisites: [],
        required: true,
        status: "pending",
      },
    },
    recentEpisodeIds: ["ep_1"],
  };
}

function makeEpisode(id: string, fromEventSeq: number): EpisodeMemory {
  return {
    id,
    fromEventSeq,
    toEventSeq: fromEventSeq + 4,
    summary: `第 ${id} 话：教室里的相遇。`,
    characters: ["林晓"],
    locations: ["教室"],
    threads: ["main_a"],
    setups: [],
    importance: "normal",
  };
}

describe("JsonNarrativeMemoryStore", () => {
  let dir: string;
  let store: JsonNarrativeMemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nar-mem-"));
    store = new JsonNarrativeMemoryStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("load returns empty state and episodes when files are missing (no throw)", async () => {
    const loaded = await store.load();
    expect(loaded).toEqual({ state: EMPTY_STATE, episodes: [] });
  });

  it("round-trips state via saveState -> load", async () => {
    const state = makeState();
    await store.saveState(state);
    const loaded = await store.load();
    expect(loaded.state).toEqual(state);
    expect(loaded.episodes).toEqual([]);
  });

  it("round-trips episodes via appendEpisodes -> load", async () => {
    const episodes = [makeEpisode("ep_1", 1), makeEpisode("ep_2", 10)];
    await store.appendEpisodes(episodes);
    const loaded = await store.load();
    expect(loaded.state).toEqual(EMPTY_STATE);
    expect(loaded.episodes).toEqual(episodes);
  });

  it("writes narrative-state.json atomically with the last saved state", async () => {
    await store.saveState(makeState());
    await store.saveState({ ...makeState(), revision: 9 });

    // Only the state file exists — no stray tmp files left behind.
    expect((await readdir(dir)).sort()).toEqual(["narrative-state.json"]);

    const raw = await readFile(path.join(dir, "narrative-state.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ ...makeState(), revision: 9 });
    const loaded = await store.load();
    expect(loaded.state.revision).toBe(9);
  });

  it("returns empty state without throwing on corrupt state.json", async () => {
    await appendFile(path.join(dir, "narrative-state.json"), "{ not json !!!", "utf8");
    const loaded = await store.load();
    expect(loaded.state).toEqual(EMPTY_STATE);
  });

  it("skips corrupt episode lines and keeps valid ones", async () => {
    await store.appendEpisodes([makeEpisode("ep_1", 1), makeEpisode("ep_2", 10)]);
    await appendFile(
      path.join(dir, "episodes.jsonl"),
      '{"broken": line without closing\n',
      "utf8",
    );
    await store.appendEpisodes([makeEpisode("ep_3", 20)]);
    const loaded = await store.load();
    expect(loaded.episodes).toEqual([
      makeEpisode("ep_1", 1),
      makeEpisode("ep_2", 10),
      makeEpisode("ep_3", 20),
    ]);
  });

  it("accumulates rejected ops across appendOps calls", async () => {
    const first: RejectedOp[] = [
      { kind: "thread", op: { type: "advance", id: "t_1" }, reason: "thread already resolved" },
    ];
    const second: RejectedOp[] = [
      { kind: "episode", op: { summary: "空话" }, reason: "summary too short" },
      { kind: "setup", op: { type: "payoff", id: "s_1" }, reason: "setup not ready" },
    ];
    await store.appendOps(first);
    await store.appendOps(second);

    const raw = await readFile(path.join(dir, "narrative-ops.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l))).toEqual([...first, ...second]);
  });
});
