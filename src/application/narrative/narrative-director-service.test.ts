/**
 * Tests for NarrativeDirectorService (Task 6).
 *
 * Covers: initialize merging plan seeds, observeCommitted queuing,
 * getBrief with no consolidation, checkpoint counting, consolidatePending
 * apply/reject pipelines, consolidator failure safety, getBrief content,
 * and scheduling thresholds.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  NarrativeMemoryState,
  PlotThread,
  SetupPayoff,
  StoryAnchorState,
  EpisodeMemory,
} from "../../core/narrative/memory-types.js";
import type {
  ThreadOp,
  SetupOp,
  EpisodeSummaryOp,
  RejectedOp,
} from "../../core/narrative/memory-operation.js";
import type { NarrativeBriefRequest } from "../../core/narrative/narrative-brief.js";
import type { NarrativeMemoryStorePort } from "../../core/ports/narrative-memory-store-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { StoryPlan } from "../../adapters/static/story-plan-loader.js";
import type { NarrativeConfig } from "../../config.js";
import type { StoredEvent } from "../../schema.js";
import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";

// The service and port we are testing
import { NarrativeDirectorService } from "./narrative-director-service.js";
import type {
  NarrativeDirectorPort,
  NarrativeCheckpointReason,
} from "../../core/ports/narrative-director-port.js";
import type {
  MemoryConsolidatorPort,
  ConsolidationRequest,
  ConsolidationResult,
} from "./narrative-director-service.js";

// ---------------------------------------------------------------------------
// Fakes / fixtures
// ---------------------------------------------------------------------------

/** Minimal narration StoredEvent for tests. */
function makeEvent(seq: number, turn = 1): StoredEvent {
  return {
    seq,
    turn,
    timestamp: new Date().toISOString(),
    source: "model",
    type: "narration",
    text: `Event ${seq}`,
    line_id: `line-${seq}`,
  } as StoredEvent;
}

function makeConfig(
  overrides: Partial<NarrativeConfig> = {},
): NarrativeConfig {
  return { ...DEFAULT_NARRATIVE_CONFIG, ...overrides };
}

/** Recording in-memory NarrativeMemoryStorePort. */
class FakeStore implements NarrativeMemoryStorePort {
  location = "test-memory";

  private state: NarrativeMemoryState = emptyState();
  private episodes: EpisodeMemory[] = [];

  // recording
  saveStateCalls: NarrativeMemoryState[] = [];
  appendEpisodesCalls: EpisodeMemory[][] = [];
  appendOpsCalls: RejectedOp[][] = [];

  constructor(initialState?: NarrativeMemoryState, episodes?: EpisodeMemory[]) {
    if (initialState) this.state = initialState;
    if (episodes) this.episodes = episodes;
  }

  async load(): Promise<{ state: NarrativeMemoryState; episodes: EpisodeMemory[] }> {
    return { state: this.state, episodes: [...this.episodes] };
  }

  async saveState(state: NarrativeMemoryState): Promise<void> {
    this.saveStateCalls.push(state);
    this.state = state;
  }

  async appendEpisodes(episodes: EpisodeMemory[]): Promise<void> {
    this.appendEpisodesCalls.push(episodes);
  }

  async appendOps(ops: RejectedOp[]): Promise<void> {
    this.appendOpsCalls.push(ops);
  }
}

/** Empty state factory (returns a fresh object every time). */
function emptyState(): NarrativeMemoryState {
  return {
    revision: 0,
    consolidatedThroughEventSeq: 0,
    checkpointCount: 0,
    threads: {},
    setups: {},
    anchors: {},
    recentEpisodeIds: [],
  };
}

/** Recording DiagnosticSink. */
class RecordingDiagnostics implements DiagnosticSink {
  infos: Array<{ scope: string; message: string }> = [];
  warns: Array<{ scope: string; message: string }> = [];

  info(scope: string, message: string): void {
    this.infos.push({ scope, message });
  }
  warn(scope: string, message: string): void {
    this.warns.push({ scope, message });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeThread(overrides: Partial<PlotThread> & { id: string }): PlotThread {
  return {
    kind: "main",
    summary: `${overrides.id} summary`,
    status: "open",
    importance: "major",
    introducedAt: 0,
    lastTouchedAt: 0,
    source: "author",
    ...overrides,
  };
}

function makeSetup(overrides: Partial<SetupPayoff> & { id: string }): SetupPayoff {
  return {
    kind: "object",
    setup: `${overrides.id} setup`,
    status: "planned",
    reinforcementCount: 0,
    prerequisites: [],
    source: "author",
    ...overrides,
  };
}

function makeAnchor(overrides: Partial<StoryAnchorState> & { id: string }): StoryAnchorState {
  return {
    purpose: `${overrides.id} purpose`,
    prerequisites: [],
    required: false,
    status: "pending",
    ...overrides,
  };
}

function makePlan(
  threads: PlotThread[] = [],
  setups: SetupPayoff[] = [],
  anchors: StoryAnchorState[] = [],
): StoryPlan {
  return { threads, setups, anchors };
}

// ---------------------------------------------------------------------------
// NarrativeDirectorService tests
// ---------------------------------------------------------------------------

describe("NarrativeDirectorService", () => {
  // -----------------------------------------------------------------------
  // initialize — plan seed merging
  // -----------------------------------------------------------------------
  describe("initialize", () => {
    it("merges plan threads into the loaded state", async () => {
      const plan = makePlan([makeThread({ id: "t1", status: "open" })]);
      const store = new FakeStore();
      const diag = new RecordingDiagnostics();
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan,
        diagnostics: diag,
      });
      await svc.initialize();

      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.activeThreads).toHaveLength(1);
      expect(brief.activeThreads[0]!.id).toBe("t1");
    });

    it("merges plan setups into the loaded state", async () => {
      const plan = makePlan([], [makeSetup({ id: "s1" })]);
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan,
      });
      await svc.initialize();

      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.setupDirectives.length).toBeGreaterThanOrEqual(1);
      expect(brief.setupDirectives.some((d: { id: string }) => d.id === "s1")).toBe(true);
    });

    it("merges plan anchors into the loaded state", async () => {
      const plan = makePlan([], [], [makeAnchor({ id: "a1" })]);
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan,
      });
      await svc.initialize();

      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.anchors).toHaveLength(1);
      expect(brief.anchors[0]!.id).toBe("a1");
    });

    it("does NOT mutate the loaded store state object in place (reference safety)", async () => {
      // Simulate a store whose load() returns a shared EMPTY_STATE object
      const sharedState = emptyState();
      // Pre-populate shared with a runtime thread to verify it stays untouched
      sharedState.threads["existing"] = makeThread({ id: "existing", source: "runtime" });
      const store = new FakeStore(sharedState);

      const plan = makePlan([makeThread({ id: "t-plan" })]);
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan,
      });
      await svc.initialize();

      // sharedState must not have the plan thread added to it
      expect(sharedState.threads["t-plan"]).toBeUndefined();
      // sharedState must still have its original thread
      expect(sharedState.threads["existing"]).toBeDefined();
    });

    it("plan threads with same id as runtime threads take precedence (plan wins)", async () => {
      const sharedState = emptyState();
      sharedState.threads["t-conflict"] = makeThread({
        id: "t-conflict",
        summary: "runtime summary",
        source: "runtime",
      });
      const store = new FakeStore(sharedState);

      const plan = makePlan([
        makeThread({ id: "t-conflict", summary: "plan summary", source: "author" }),
      ]);
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan,
      });
      await svc.initialize();

      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      const t = brief.activeThreads.find((th: { id: string }) => th.id === "t-conflict");
      expect(t).toBeDefined();
      expect(t!.summary).toBe("plan summary");
    });
  });

  // -----------------------------------------------------------------------
  // observeCommitted — queuing
  // -----------------------------------------------------------------------
  describe("observeCommitted", () => {
    it("queues events without calling consolidator when consolidator is undefined", async () => {
      const store = new FakeStore();
      const diag = new RecordingDiagnostics();
      const svc = new NarrativeDirectorService({
        config: makeConfig({ consolidation: { batch_min_events: 1, max_events_per_call: 80, min_checkpoint_gap_ms: 0 } }),
        store,
        consolidator: undefined,
        plan: makePlan(),
        diagnostics: diag,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(1), makeEvent(2)]);

      // No consolidator → consolidatePending returns { applied: 0, rejected: [] }
      const result = await svc.consolidatePending();
      expect(result.applied).toBe(0);
      expect(result.rejected).toEqual([]);
    });

    it("getBrief does not trigger consolidation", async () => {
      // getBrief is synchronous and must never call consolidatePending
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan: makePlan(),
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(1)]);

      // getBrief works fine without consolidation
      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 5,
        location: "study",
        characters: ["aiko"],
      });
      expect(brief.currentEventSeq).toBe(5);
      expect(brief.location).toBe("study");
    });
  });

  // -----------------------------------------------------------------------
  // checkpoint
  // -----------------------------------------------------------------------
  describe("checkpoint", () => {
    it("increments checkpointCount and is visible in brief", async () => {
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan: makePlan(),
      });
      await svc.initialize();

      svc.checkpoint("scene_change");
      let brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.checkpointCount).toBe(1);

      svc.checkpoint("interaction_completed");
      brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.checkpointCount).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // consolidatePending — apply/reject pipelines
  // -----------------------------------------------------------------------
  describe("consolidatePending", () => {
    /** Create a fake consolidator that returns a fixed result. */
    function fakeConsolidator(
      result: ConsolidationResult,
    ): MemoryConsolidatorPort {
      return {
        consolidate: vi.fn().mockResolvedValue(result),
      };
    }

    it("applies valid thread ops: touch updates lastTouchedAt + summary", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan([
        makeThread({ id: "t1", status: "open", lastTouchedAt: 5 }),
      ]);
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: fakeConsolidator({
          episode: {
            summary: "Touched thread",
            characters: [],
            locations: [],
            threads: ["t1"],
            setups: [],
            importance: "normal",
          },
          threadOps: [{ type: "touch", id: "t1", progress: "new summary" }],
          setupOps: [],
        }),
        plan,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(10)]);
      const result = await svc.consolidatePending();
      expect(result.applied).toBeGreaterThan(0);

      // Check that store.saveState was called with updated state
      expect(store.saveStateCalls.length).toBeGreaterThanOrEqual(1);
      const saved = store.saveStateCalls[store.saveStateCalls.length - 1]!;
      expect(saved.threads["t1"]!.lastTouchedAt).toBe(10);
      expect(saved.threads["t1"]!.summary).toBe("new summary");
    });

    it("applies advance: advances thread to next status", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan([
        makeThread({ id: "t1", status: "open", lastTouchedAt: 0 }),
      ]);
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: fakeConsolidator({
          episode: {
            summary: "Advanced thread",
            characters: [],
            locations: [],
            threads: ["t1"],
            setups: [],
            importance: "normal",
          },
          threadOps: [{ type: "advance", id: "t1" }],
          setupOps: [],
        }),
        plan,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(20)]);
      await svc.consolidatePending();

      const saved = store.saveStateCalls[store.saveStateCalls.length - 1]!;
      expect(saved.threads["t1"]!.status).toBe("developing");
    });

    it("applies resolve: marks thread resolved", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan([
        makeThread({ id: "t1", status: "developing" }),
      ]);
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: fakeConsolidator({
          episode: {
            summary: "Resolved",
            characters: [],
            locations: [],
            threads: ["t1"],
            setups: [],
            importance: "major",
          },
          threadOps: [{ type: "resolve", id: "t1" }],
          setupOps: [],
        }),
        plan,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(30)]);
      await svc.consolidatePending();

      const saved = store.saveStateCalls[store.saveStateCalls.length - 1]!;
      expect(saved.threads["t1"]!.status).toBe("resolved");
    });

    it("applies abandon: marks thread abandoned", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan([
        makeThread({ id: "t1", status: "open" }),
      ]);
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: fakeConsolidator({
          episode: {
            summary: "Abandoned",
            characters: [],
            locations: [],
            threads: [],
            setups: [],
            importance: "normal",
          },
          threadOps: [{ type: "abandon", id: "t1" }],
          setupOps: [],
        }),
        plan,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(40)]);
      await svc.consolidatePending();

      const saved = store.saveStateCalls[store.saveStateCalls.length - 1]!;
      expect(saved.threads["t1"]!.status).toBe("abandoned");
    });

    it("applies create: creates a new runtime thread", async () => {
      const store = new FakeStore(emptyState());
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: fakeConsolidator({
          episode: {
            summary: "Created thread",
            characters: [],
            locations: [],
            threads: ["t-new"],
            setups: [],
            importance: "normal",
          },
          threadOps: [
            {
              type: "create",
              id: "t-new",
              progress: "A new mystery emerges",
            },
          ],
          setupOps: [],
        }),
        plan: makePlan(),
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(50)]);
      await svc.consolidatePending();

      const saved = store.saveStateCalls[store.saveStateCalls.length - 1]!;
      expect(saved.threads["t-new"]).toBeDefined();
      expect(saved.threads["t-new"]!.id).toBe("t-new");
      expect(saved.threads["t-new"]!.source).toBe("runtime");
    });

    it("applies valid setup ops: seed/reinforce/payoff/hold/drop", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan(
        [],
        [
          makeSetup({ id: "s1", status: "planned" }),
          makeSetup({ id: "s2", status: "seeded", reinforcementCount: 0 }),
          makeSetup({ id: "s3", status: "reinforced" }),
          makeSetup({ id: "s4", status: "seeded" }),
          makeSetup({ id: "s5", status: "planned" }),
        ],
      );
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: fakeConsolidator({
          episode: {
            summary: "Setup ops",
            characters: [],
            locations: [],
            threads: [],
            setups: ["s1", "s2", "s3", "s4", "s5"],
            importance: "normal",
          },
          threadOps: [],
          setupOps: [
            { type: "seed", id: "s1" },
            { type: "reinforce", id: "s2" },
            { type: "payoff", id: "s3" },
            { type: "hold", id: "s4" },
            { type: "drop", id: "s5" },
          ],
        }),
        plan,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(60)]);
      await svc.consolidatePending();

      const saved = store.saveStateCalls[store.saveStateCalls.length - 1]!;
      expect(saved.setups["s1"]!.status).toBe("seeded");
      expect(saved.setups["s2"]!.reinforcementCount).toBe(1);
      expect(saved.setups["s2"]!.status).toBe("reinforced");
      expect(saved.setups["s3"]!.status).toBe("paid_off");
      // hold: no status change
      expect(saved.setups["s4"]!.status).toBe("seeded");
      expect(saved.setups["s5"]!.status).toBe("dropped");
    });

    it("episode is appended and revision + consolidatedThroughEventSeq advance", async () => {
      const store = new FakeStore(emptyState());
      const svc = new NarrativeDirectorService({
        config: makeConfig({ consolidation: { batch_min_events: 999, max_events_per_call: 80, min_checkpoint_gap_ms: 0 } }),
        store,
        consolidator: fakeConsolidator({
          episode: {
            summary: "A new episode",
            characters: ["aiko"],
            locations: ["study"],
            threads: [],
            setups: [],
            importance: "major",
          },
          threadOps: [],
          setupOps: [],
        }),
        plan: makePlan(),
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(10), makeEvent(11), makeEvent(12), makeEvent(13)]);
      await svc.consolidatePending();

      const saved = store.saveStateCalls[store.saveStateCalls.length - 1]!;
      expect(saved.revision).toBe(1);
      expect(saved.consolidatedThroughEventSeq).toBe(13); // last event seq
      expect(saved.recentEpisodeIds.length).toBe(1);

      // Episode was appended to store
      expect(store.appendEpisodesCalls.length).toBeGreaterThanOrEqual(1);
      const appended = store.appendEpisodesCalls[store.appendEpisodesCalls.length - 1]!;
      expect(appended).toHaveLength(1);
      expect(appended[0]!.summary).toBe("A new episode");

      // CRITICAL: recentEpisodeIds[0] must match the appended episode's id
      expect(saved.recentEpisodeIds[0]).toBe(appended[0]!.id);
    });

    it("rejects invalid ops and records them via appendOps", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan([
        makeThread({ id: "t1", status: "resolved" }), // terminal
      ]);
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: fakeConsolidator({
          episode: {
            summary: "Will reject",
            characters: [],
            locations: [],
            threads: [],
            setups: [],
            importance: "normal",
          },
          threadOps: [
            { type: "resolve", id: "t1" }, // invalid: already resolved
            { type: "touch", id: "ghost" }, // invalid: does not exist
          ],
          setupOps: [
            { type: "seed", id: "ghost-s" }, // invalid: does not exist
          ],
        }),
        plan,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(70)]);
      const result = await svc.consolidatePending();

      // All ops were rejected
      expect(result.rejected).toHaveLength(3);
      // appendOps called with rejected
      expect(store.appendOpsCalls.length).toBeGreaterThanOrEqual(1);
      const rejectedOps = store.appendOpsCalls[store.appendOpsCalls.length - 1]!;
      expect(rejectedOps).toHaveLength(3);

      // State was still saved (episode + rejected ops → save happens)
      expect(store.saveStateCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("applies ops in order: episode first, then threadOps, then setupOps; rejects don't apply", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan([
        makeThread({ id: "t-valid", status: "open" }),
      ], [
        makeSetup({ id: "s-valid", status: "planned" }),
      ]);
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: fakeConsolidator({
          episode: {
            summary: "Mixed",
            characters: [],
            locations: [],
            threads: ["t-valid"],
            setups: ["s-valid"],
            importance: "normal",
          },
          threadOps: [
            { type: "advance", id: "t-valid" }, // valid
            { type: "touch", id: "ghost" }, // invalid - rejected
          ],
          setupOps: [
            { type: "seed", id: "s-valid" }, // valid
            { type: "payoff", id: "ghost-s" }, // invalid - rejected
          ],
        }),
        plan,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(80)]);
      const result = await svc.consolidatePending();

      expect(result.rejected).toHaveLength(2);
      expect(result.applied).toBe(3); // 1 episode + 1 thread + 1 setup

      const saved = store.saveStateCalls[store.saveStateCalls.length - 1]!;
      expect(saved.threads["t-valid"]!.status).toBe("developing");
      expect(saved.setups["s-valid"]!.status).toBe("seeded");
      // ghosts were never created
      expect(saved.threads["ghost"]).toBeUndefined();
      expect(saved.setups["ghost-s"]).toBeUndefined();
    });

    it("consolidator failure does NOT throw, does NOT advance watermark, and RETAINS events for retry", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan();
      const consolidateFn = vi.fn()
        .mockRejectedValueOnce(new Error("LLM timeout"))
        .mockResolvedValueOnce({
          episode: {
            summary: "Recovered episode",
            characters: [],
            locations: [],
            threads: [],
            setups: [],
            importance: "normal",
          },
          threadOps: [],
          setupOps: [],
        } satisfies ConsolidationResult);
      const consolidator: MemoryConsolidatorPort = { consolidate: consolidateFn };
      const diag = new RecordingDiagnostics();
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator,
        plan,
        diagnostics: diag,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(10)]);
      const result1 = await svc.consolidatePending();

      // First call: does not throw
      expect(result1.applied).toBe(0);
      expect(result1.rejected).toEqual([]);
      // Watermark unchanged
      let brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.revision).toBe(0);
      expect(brief.consolidatedThroughEventSeq).toBe(0);
      // Diagnostic warning emitted
      expect(diag.warns.length).toBeGreaterThanOrEqual(1);

      // Second call: events must still be pending and get processed
      const result2 = await svc.consolidatePending();
      expect(result2.applied).toBeGreaterThanOrEqual(1);
      expect(consolidator.consolidate).toHaveBeenCalledTimes(2);

      // Watermark now advanced from the retried batch
      brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.revision).toBe(1);
      expect(brief.consolidatedThroughEventSeq).toBe(10);
    });
  });

  // -----------------------------------------------------------------------
  // getBrief — content
  // -----------------------------------------------------------------------
  describe("getBrief", () => {
    it("returns relevantEpisodes via retriever rules", async () => {
      const store = new FakeStore(emptyState(), [
        {
          id: "ep-1",
          fromEventSeq: 0,
          toEventSeq: 10,
          summary: "Episode about aiko",
          characters: ["aiko"],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        {
          id: "ep-2",
          fromEventSeq: 5,
          toEventSeq: 15,
          summary: "Episode about kenji",
          characters: ["kenji"],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
      ]);
      const svc = new NarrativeDirectorService({
        config: makeConfig({ brief: { max_relevant_episodes: 2, max_recent_raw_events: 40 } }),
        store,
        consolidator: undefined,
        plan: makePlan(),
      });
      await svc.initialize();

      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 20,
        location: "",
        characters: ["aiko"],
      });
      // Only ep-1 matches aiko
      expect(brief.relevantEpisodes).toHaveLength(1);
      expect(brief.relevantEpisodes[0]!.id).toBe("ep-1");
    });

    it("returns setupDirectives with classifySetup decisions", async () => {
      const plan = makePlan(
        [],
        [
          makeSetup({ id: "s-paid", status: "paid_off" }),
          makeSetup({ id: "s-active", status: "seeded", lastTouchedAt: 0 }),
        ],
        [makeAnchor({ id: "anchor-x", status: "pending" })],
      );
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan,
      });
      await svc.initialize();

      // Checkpoint a few times to make s-active stale
      svc.checkpoint("scene_change");
      svc.checkpoint("scene_change");

      const brief = svc.getBrief({
        turn: 2,
        eventSeq: 20,
        location: "",
        characters: [],
      });
      // s-paid should NOT appear (terminal), s-active should be reinforce/soon
      expect(brief.setupDirectives.some((d: { id: string }) => d.id === "s-paid")).toBe(false);
      const activeDirective = brief.setupDirectives.find((d: { id: string }) => d.id === "s-active");
      expect(activeDirective).toBeDefined();
      expect(activeDirective!.action).toBe("reinforce");
      expect(activeDirective!.urgency).toBe("soon");
    });

    it("revealLocks is always empty array", async () => {
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan: makePlan(),
      });
      await svc.initialize();

      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "anywhere",
        characters: ["anyone"],
      });
      expect(brief.revealLocks).toEqual([]);
    });

    it("activeThreads only includes non-terminal threads", async () => {
      const plan = makePlan([
        makeThread({ id: "t-open", status: "open" }),
        makeThread({ id: "t-resolved", status: "resolved" }),
      ]);
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan,
      });
      await svc.initialize();

      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.activeThreads.some((t: { id: string }) => t.id === "t-open")).toBe(true);
      expect(brief.activeThreads.some((t: { id: string }) => t.id === "t-resolved")).toBe(false);
    });

    it("anchors are sorted by status (pending first, then reached, then passed)", async () => {
      const plan = makePlan([], [], [
        makeAnchor({ id: "a-passed", status: "passed" }),
        makeAnchor({ id: "a-pending", status: "pending" }),
        makeAnchor({ id: "a-reached", status: "reached" }),
      ]);
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan,
      });
      await svc.initialize();

      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.anchors[0]!.id).toBe("a-pending");
      expect(brief.anchors[1]!.id).toBe("a-reached");
      expect(brief.anchors[2]!.id).toBe("a-passed");
    });
  });

  // -----------------------------------------------------------------------
  // config normalization — defense against shallow-merge callers
  // -----------------------------------------------------------------------
  describe("config normalization", () => {
    it("survives a partial config where nested sections are undefined", async () => {
      // Simulate the shallow-merge bug: only mode is set, everything else
      // (threads, setups, consolidation, brief) is undefined.
      const partial = { mode: "longform" as const } as NarrativeConfig;
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: partial,
        store,
        consolidator: undefined,
        plan: makePlan(),
      });
      await svc.initialize();

      // getBrief must not throw TypeError (e.g. "Cannot read
      // properties of undefined (reading 'max_relevant_episodes')").
      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.revision).toBe(0);
      expect(brief.activeThreads).toEqual([]);
    });

    it("partial sub-objects merge with defaults (caller overrides only some keys)", async () => {
      const partial = {
        mode: "longform" as const,
        story_plan_path: "/custom/path.yaml",
        brief: { max_relevant_episodes: 3 },
      } as NarrativeConfig;
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: partial,
        store,
        consolidator: undefined,
        plan: makePlan(),
      });
      await svc.initialize();

      // Caller override wins where specified
      expect((svc as any).config.story_plan_path).toBe("/custom/path.yaml");
      expect((svc as any).config.brief.max_relevant_episodes).toBe(3);
      // Unspecified sub-keys fall back to defaults
      expect((svc as any).config.brief.max_recent_raw_events).toBe(
        DEFAULT_NARRATIVE_CONFIG.brief.max_recent_raw_events,
      );
      // Unspecified sections fall back to defaults entirely
      expect((svc as any).config.threads.max_major_active).toBe(
        DEFAULT_NARRATIVE_CONFIG.threads.max_major_active,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Scheduling thresholds
  // -----------------------------------------------------------------------
  describe("scheduling thresholds", () => {
    it("does NOT call consolidator when pending < batch_min_events", async () => {
      const consolidateFn = vi.fn().mockResolvedValue({
        episode: {
          summary: "should not be called",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
      } satisfies ConsolidationResult);
      const consolidator: MemoryConsolidatorPort = { consolidate: consolidateFn };
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: makeConfig({
          consolidation: {
            batch_min_events: 4,
            max_events_per_call: 80,
            min_checkpoint_gap_ms: 0,
          },
        }),
        store,
        consolidator,
        plan: makePlan(),
      });
      await svc.initialize();

      // Only 2 events — below batch_min_events of 4
      svc.observeCommitted([makeEvent(1), makeEvent(2)]);
      // maybeSchedule is fire-and-forget; wait briefly then check
      await new Promise((r) => setTimeout(r, 50));

      expect(consolidateFn).not.toHaveBeenCalled();
    });

    it("calls consolidator when pending >= batch_min_events", async () => {
      const consolidateFn = vi.fn().mockResolvedValue({
        episode: {
          summary: "should be called",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
      } satisfies ConsolidationResult);
      const consolidator: MemoryConsolidatorPort = { consolidate: consolidateFn };
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: makeConfig({
          consolidation: {
            batch_min_events: 4,
            max_events_per_call: 80,
            min_checkpoint_gap_ms: 0,
          },
        }),
        store,
        consolidator,
        plan: makePlan(),
      });
      await svc.initialize();

      // Exactly 4 events = batch_min_events
      svc.observeCommitted([
        makeEvent(1),
        makeEvent(2),
        makeEvent(3),
        makeEvent(4),
      ]);
      // maybeSchedule fires async; wait a tick
      await new Promise((r) => setTimeout(r, 100));

      expect(consolidateFn).toHaveBeenCalled();
    });

    it("does not lose events observed during in-flight consolidation (atomic drain)", async () => {
      // Use a deferred consolidator so we can inject observeCommitted
      // while consolidatePending is still running. Set batch_min_events
      // high so maybeSchedule never fires — only direct calls matter.
      let resolveConsolidator!: (value: ConsolidationResult) => void;
      const deferred = new Promise<ConsolidationResult>((resolve) => {
        resolveConsolidator = resolve;
      });

      const consolidateFn = vi.fn().mockReturnValue(deferred);
      const consolidator: MemoryConsolidatorPort = { consolidate: consolidateFn };
      const store = new FakeStore(emptyState());
      const svc = new NarrativeDirectorService({
        config: makeConfig({ consolidation: { batch_min_events: 999, max_events_per_call: 80, min_checkpoint_gap_ms: 0 } }),
        store,
        consolidator,
        plan: makePlan(),
      });
      await svc.initialize();

      // Queue events (maybeSchedule suppressed by high batch_min_events)
      svc.observeCommitted([makeEvent(1), makeEvent(2)]);

      // Directly start consolidation — it will block on the deferred
      const p1 = svc.consolidatePending();

      // While in-flight, observe more events
      svc.observeCommitted([makeEvent(3)]);

      // Resolve the blocking consolidator
      const batch1Result: ConsolidationResult = {
        episode: {
          summary: "Batch 1",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
      };
      resolveConsolidator(batch1Result);
      await p1;

      // The events from observeCommitted(3) during flight must NOT be lost.
      // Reset consolidator mock and run again.
      consolidateFn.mockResolvedValue({
        episode: {
          summary: "Batch 2",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
      } satisfies ConsolidationResult);

      const result2 = await svc.consolidatePending();
      // Should process the event observed during flight
      expect(result2.applied).toBeGreaterThanOrEqual(1);
      expect(consolidator.consolidate).toHaveBeenCalledTimes(2);
    });

    it("guards against concurrent consolidatePending calls", async () => {
      let resolveConsolidator!: (value: ConsolidationResult) => void;
      const deferred = new Promise<ConsolidationResult>((resolve) => {
        resolveConsolidator = resolve;
      });

      const consolidateFn = vi.fn().mockReturnValue(deferred);
      const consolidator: MemoryConsolidatorPort = { consolidate: consolidateFn };
      const store = new FakeStore(emptyState());
      const svc = new NarrativeDirectorService({
        config: makeConfig({ consolidation: { batch_min_events: 1, max_events_per_call: 80, min_checkpoint_gap_ms: 0 } }),
        store,
        consolidator,
        plan: makePlan(),
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(1)]);

      const p1 = svc.consolidatePending();
      // Second call while first is running should early-return
      const result2 = await svc.consolidatePending();

      expect(result2.applied).toBe(0);
      expect(result2.rejected).toEqual([]);
      expect(consolidator.consolidate).toHaveBeenCalledTimes(1);

      // Cleanup: resolve the first call
      resolveConsolidator({
        episode: {
          summary: "Done",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
      });
      await p1;
    });

    it("checkpoint triggers maybeSchedule after incrementing count", async () => {
      const consolidateFn = vi.fn().mockResolvedValue({
        episode: {
          summary: "checkpoint triggered",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
      } satisfies ConsolidationResult);
      const consolidator: MemoryConsolidatorPort = { consolidate: consolidateFn };
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: makeConfig({
          consolidation: {
            batch_min_events: 4,
            max_events_per_call: 80,
            min_checkpoint_gap_ms: 0,
          },
        }),
        store,
        consolidator,
        plan: makePlan(),
      });
      await svc.initialize();

      // Queue events and checkpoint
      svc.observeCommitted([
        makeEvent(1),
        makeEvent(2),
        makeEvent(3),
        makeEvent(4),
      ]);
      svc.checkpoint("interaction_completed");
      await new Promise((r) => setTimeout(r, 100));

      expect(consolidateFn).toHaveBeenCalled();
    });
  });
});
