/**
 * Tests for the JSON narrative-memory store (Task 4).
 *
 * All files are written to a mkdtemp tmp dir per test, so the suite never
 * touches real session data.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonNarrativeMemoryStore } from "./json-narrative-memory-store.js";
import type {
  EpisodeMemory,
  FactRecord,
  EndingReport,
  Lesson,
  NarrativeMemoryState,
} from "../../core/narrative/memory-types.js";
import type { RejectedOp } from "../../core/narrative/memory-operation.js";
import type { DirectorPlan } from "../../core/narrative/director-plan.js";

const EMPTY_STATE: NarrativeMemoryState = {
  revision: 0,
  consolidatedThroughEventSeq: 0,
  checkpointCount: 0,
  threads: {},
  setups: {},
  anchors: {},
  recentEpisodeIds: [],
    beliefs: [],
    facts: [],
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
        introducedAtCheckpoint: 10,
        lastTouchedAtCheckpoint: 42,
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
    beliefs: [],
    facts: [],
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
    store = new JsonNarrativeMemoryStore(dir, "test-session");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes narrative files under <sessionDir>/<sessionId>/", async () => {
    await store.saveState(makeState());
    // The session directory nests under the base dir.
    const sessionDirPath = path.join(dir, "test-session");
    expect((await readdir(sessionDirPath)).sort()).toEqual([
      "narrative-state.json",
    ]);
    // The base dir itself only contains the session directory.
    expect((await readdir(dir)).sort()).toEqual(["test-session"]);
    const loaded = await store.load();
    expect(loaded.state.revision).toBe(3);
  });

  it("isolates sessions: a different session id sees empty state", async () => {
    await store.saveState({ ...makeState(), revision: 7 });
    const other = new JsonNarrativeMemoryStore(dir, "other-session");
    const loaded = await other.load();
    expect(loaded.state).toEqual(EMPTY_STATE);
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
    expect((await readdir(path.join(dir, "test-session"))).sort()).toEqual(["narrative-state.json"]);

    const raw = await readFile(path.join(dir, "test-session", "narrative-state.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ ...makeState(), revision: 9 });
    const loaded = await store.load();
    expect(loaded.state.revision).toBe(9);
  });

  it("returns empty state without throwing on corrupt state.json", async () => {
    await mkdir(path.join(dir, "test-session"), { recursive: true });
    await appendFile(path.join(dir, "test-session", "narrative-state.json"), "{ not json !!!", "utf8");
    const loaded = await store.load();
    expect(loaded.state).toEqual(EMPTY_STATE);
  });

  it("degrades structurally-corrupt state (valid JSON, wrong shape) to empty state", async () => {
    // Valid JSON that fails the zod schema (revision is a string).
    await mkdir(path.join(dir, "test-session"), { recursive: true });
    await appendFile(
      path.join(dir, "test-session", "narrative-state.json"),
      JSON.stringify({ revision: "oops", threads: {} }),
      "utf8",
    );
    const loaded = await store.load();
    expect(loaded.state).toEqual(EMPTY_STATE);
  });

  it("skips corrupt episode lines and keeps valid ones", async () => {
    await store.appendEpisodes([makeEpisode("ep_1", 1), makeEpisode("ep_2", 10)]);
    await appendFile(
      path.join(dir, "test-session", "episodes.jsonl"),
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

  it("skips structurally-corrupt episode lines and dedupes by id", async () => {
    // Valid JSON failing the zod schema — skipped like a syntax error.
    await store.appendEpisodes([makeEpisode("ep_1", 1)]);
    await appendFile(
      path.join(dir, "test-session", "episodes.jsonl"),
      JSON.stringify({ id: 42, fromEventSeq: "x" }) + "\n",
      "utf8",
    );
    // Same id twice (a failed persist retry re-appends) — deduped.
    await store.appendEpisodes([makeEpisode("ep_1", 1), makeEpisode("ep_2", 10)]);
    const loaded = await store.load();
    expect(loaded.episodes).toEqual([makeEpisode("ep_1", 1), makeEpisode("ep_2", 10)]);
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

    const raw = await readFile(path.join(dir, "test-session", "narrative-ops.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l))).toEqual([...first, ...second]);
  });

  it("persists and loads a director plan", async () => {
    const plan: DirectorPlan = {
      revision: 2,
      basedOnMemoryRevision: 7,
      phase: "development",
      currentGoal: "推进对苏遥的怀疑",
      beats: [{ purpose: "侧面证据" }],
      focusThreads: ["terminal_origin"],
      setupDirectives: [],
      revealLocks: ["suyao_memory_origin"],
      expiresAfterCheckpoint: 4,
    };
    await store.savePlan(plan);
    const reloaded = await store.loadPlan();
    expect(reloaded).toEqual(plan);
    // 文件存在：<store.location>/director-plan.json
    const raw = await readFile(path.join(dir, "test-session", "director-plan.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(plan);
  });

  it("loadPlan returns null for a missing or corrupt plan file", async () => {
    expect(await store.loadPlan()).toBeNull();
    await mkdir(path.join(dir, "test-session"), { recursive: true });
    await writeFile(path.join(dir, "test-session", "director-plan.json"), "{corrupt", "utf8");
    expect(await store.loadPlan()).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// MA-A 存储通道：facts.jsonl / lessons.jsonl / ending-report.json
// ---------------------------------------------------------------------------

describe("JsonNarrativeMemoryStore MA-A channels", () => {
  let dir: string;
  let store: JsonNarrativeMemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nar-mem-maa-"));
    store = new JsonNarrativeMemoryStore(dir, "test-session");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips lessons and dedupes by id", async () => {
    const lesson: Lesson = {
      id: "lesson_1",
      tag: "setup-flow",
      content: "没有回收计划的伏笔不许下场",
      source: "rejection",
      sourceRef: "SETUP_SEED_WITHOUT_INTENDED_PAYOFF",
      occurrences: 2,
      active: true,
      createdAtCheckpoint: 3,
    };
    await store.appendLessons([lesson]);
    await store.appendLessons([{ ...lesson, occurrences: 3 }]); // 重试重复同 id
    const loaded = await store.loadLessons();
    // 与 episodes 同模式：按 id 去重、保留首条（spec §5.3）
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.occurrences).toBe(2);
  });

  it("round-trips facts and skips corrupt or invalid lines", async () => {
    const fact: FactRecord = {
      id: "fact_1",
      content: "地下室第 4 号门已焊死",
      evidenceEventSeqs: [3, 4],
      checkpoint: 2,
      superseded: false,
    };
    await store.appendFacts([fact]);
    const sessionDir = path.join(dir, "test-session");
    await appendFile(
      path.join(sessionDir, "facts.jsonl"),
      "{corrupt\n",
      "utf8",
    );
    const loaded = await store.loadFacts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.content).toBe("地下室第 4 号门已焊死");
  });

  it("loadLessons/loadFacts return empty arrays when files are missing", async () => {
    expect(await store.loadLessons()).toEqual([]);
    expect(await store.loadFacts()).toEqual([]);
  });

  it("writes the ending report atomically and overwrites on re-trigger", async () => {
    const report: EndingReport = {
      generatedAt: "2026-09-17T00:00:00Z",
      setups: { paidOff: 1, dropped: 0, active: 1, payoffRate: 0.5 },
      threads: { resolved: 1, abandoned: 0, active: 1 },
      lessons: [],
    };
    await store.writeEndingReport(report);
    const second = { ...report, setups: { ...report.setups, paidOff: 2 } };
    await store.writeEndingReport(second);
    const raw = await readFile(
      path.join(dir, "test-session", "ending-report.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as EndingReport;
    expect(parsed.setups.paidOff).toBe(2);
    expect(parsed.setups.payoffRate).toBe(0.5);
  });
});
