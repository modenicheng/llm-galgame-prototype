/**
 * NarrativeDirectorService tests - consolidation
 * consolidatePending apply/reject pipeline, failure safety, flush drain.
 *
 * Split from the former narrative-director-service.test.ts along the
 * subsystem seams (MA-A hygiene prerequisite). Shared fakes live in
 * narrative-director-test-kit.ts.
 */

import { describe, it, expect, vi } from "vitest";

import type { NarrativeMemoryState, PlotThread, SetupPayoff, StoryAnchorState, EpisodeMemory } from "../../core/narrative/memory-types.js";
import type { RejectedOp } from "../../core/narrative/memory-operation.js";
import type { NarrativeMemoryStorePort } from "../../core/ports/narrative-memory-store-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { StoryPlan } from "../../adapters/static/story-plan-loader.js";
import type { NarrativeConfig } from "../../config.js";
import type { StoredEvent } from "../../schema.js";
import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";
import { NarrativeDirectorService } from "./narrative-director-service.js";
import type { MemoryConsolidatorPort, ConsolidationRequest, ConsolidationResult } from "./narrative-director-service.js";

import { makeEvent, makeConfig, FakeStore, emptyState, RecordingDiagnostics, makeThread, makeSetup, makeAnchor, makePlan } from "./narrative-director-test-kit.js";

describe("NarrativeDirectorService consolidation", () => {

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

    it("passes the latest brief location/characters to consolidation", async () => {
      const consolidateFn = vi.fn().mockResolvedValue({
        episode: {
          summary: "An episode",
          characters: ["suyao"],
          locations: ["clubroom"],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
        factOps: [],
        beliefOps: [],
        findings: [],
      });
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store: new FakeStore(emptyState()),
        consolidator: { consolidate: consolidateFn },
        plan: makePlan(),
      });
      await svc.initialize();

      svc.getMemoryProjection({
        turn: 1,
        eventSeq: 1,
        location: "clubroom",
        characters: ["suyao"],
      });
      svc.observeCommitted([makeEvent(1)]);
      await svc.consolidatePending();

      const request = consolidateFn.mock.calls[0]?.[0] as ConsolidationRequest;
      expect(request.stateLocation).toBe("clubroom");
      expect(request.stateCharacters).toEqual(["suyao"]);
    });

    it("applies valid thread ops: touch updates lastTouchedAtCheckpoint + summary", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan([
        makeThread({ id: "t1", status: "open", lastTouchedAtCheckpoint: 5 }),
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
          factOps: [],
          beliefOps: [],
          findings: [],
        }),
        plan,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(10)]);
      // Timeline fields are checkpoint units: advance the beat first.
      svc.checkpoint("interaction_completed");
      const result = await svc.consolidatePending();
      expect(result.applied).toBeGreaterThan(0);

      // Check that store.saveState was called with updated state
      expect(store.saveStateCalls.length).toBeGreaterThanOrEqual(1);
      const saved = store.saveStateCalls[store.saveStateCalls.length - 1]!;
      // checkpointCount was 0 → 1 by the checkpoint above.
      expect(saved.threads["t1"]!.lastTouchedAtCheckpoint).toBe(1);
      expect(saved.threads["t1"]!.summary).toBe("new summary");
    });

    it("applies advance: advances thread to next status", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan([
        makeThread({ id: "t1", status: "open", lastTouchedAtCheckpoint: 0 }),
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
          factOps: [],
          beliefOps: [],
          findings: [],
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
          factOps: [],
          beliefOps: [],
          findings: [],
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
          factOps: [],
          beliefOps: [],
          findings: [],
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
              kind: "mystery",
              importance: "minor",
              progress: "A new mystery emerges",
            },
          ],
          setupOps: [],
          factOps: [],
          beliefOps: [],
          findings: [],
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
      expect(saved.threads["t-new"]!).toMatchObject({
        kind: "mystery",
        importance: "minor",
      });
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
          factOps: [],
          beliefOps: [],
          findings: [],
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
          factOps: [],
          beliefOps: [],
          findings: [],
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
          factOps: [],
          beliefOps: [],
          findings: [],
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
          factOps: [],
          beliefOps: [],
          findings: [],
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
          factOps: [],
          beliefOps: [],
          findings: [],
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
      let brief = svc.getMemoryProjection({
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
      brief = svc.getMemoryProjection({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.revision).toBe(1);
      expect(brief.consolidatedThroughEventSeq).toBe(10);
    });

    it("persist failure (saveState) is atomic: memory untouched, batch requeued (audit finding 6)", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan();
      const consolidateFn = vi.fn().mockResolvedValue({
        episode: {
          summary: "Ep",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
        factOps: [],
        beliefOps: [],
        findings: [],
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
      store.failNextSaveState = true;
      const result1 = await svc.consolidatePending();

      // Failure: nothing applied, memory untouched, warning emitted.
      expect(result1.applied).toBe(0);
      let brief = svc.getMemoryProjection({ turn: 1, eventSeq: 10, location: "", characters: [] });
      expect(brief.revision).toBe(0);
      expect(brief.consolidatedThroughEventSeq).toBe(0);
      // appendEpisodes must NOT have been called.
      expect(store.appendEpisodesCalls).toHaveLength(0);
      expect(diag.warns.some((w) => w.message.includes("persist failed"))).toBe(true);

      // Retry succeeds (same revision → same episode id → idempotent).
      const result2 = await svc.consolidatePending();
      expect(result2.applied).toBeGreaterThanOrEqual(1);
      expect(consolidateFn).toHaveBeenCalledTimes(2);
      brief = svc.getMemoryProjection({ turn: 1, eventSeq: 10, location: "", characters: [] });
      expect(brief.revision).toBe(1);
      expect(brief.consolidatedThroughEventSeq).toBe(10);
      // Exactly one episode appended across both attempts (idempotent id).
      const allEpisodes = store.appendEpisodesCalls.flat();
      expect(allEpisodes).toHaveLength(1);
      expect(allEpisodes[0]!.id).toBe("ep_1_10");
    });

    it("persist failure (appendEpisodes) is atomic: memory rolled back, batch requeued (audit finding 6)", async () => {
      const store = new FakeStore(emptyState());
      const plan = makePlan();
      const consolidateFn = vi.fn().mockResolvedValue({
        episode: {
          summary: "Ep",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
        factOps: [],
        beliefOps: [],
        findings: [],
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
      store.failNextAppendEpisodes = true;
      const result1 = await svc.consolidatePending();

      // Failure after saveState: in-memory state must still be rolled back.
      expect(result1.applied).toBe(0);
      let brief = svc.getMemoryProjection({ turn: 1, eventSeq: 10, location: "", characters: [] });
      expect(brief.revision).toBe(0);
      expect(brief.consolidatedThroughEventSeq).toBe(0);
      expect(brief.relevantEpisodes).toHaveLength(0);

      // Retry converges: same episode id, single append.
      const result2 = await svc.consolidatePending();
      expect(result2.applied).toBeGreaterThanOrEqual(1);
      brief = svc.getMemoryProjection({ turn: 1, eventSeq: 10, location: "", characters: [] });
      expect(brief.revision).toBe(1);
      const allEpisodes = store.appendEpisodesCalls.flat();
      expect(allEpisodes).toHaveLength(1);
      expect(allEpisodes[0]!.id).toBe("ep_1_10");
    });
  });


  // -----------------------------------------------------------------------
  // flush — normal shutdown drain (audit P1-7)
  // -----------------------------------------------------------------------
  describe("flush", () => {
    it("drains pending events and persists the plan", async () => {
      const store = new FakeStore(emptyState());
      const consolidateFn = vi.fn().mockResolvedValue({
        episode: {
          summary: "Flush episode",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
        factOps: [],
        beliefOps: [],
        findings: [],
      } satisfies ConsolidationResult);
      const consolidator: MemoryConsolidatorPort = {
        consolidate: consolidateFn,
      };
      const svc = new NarrativeDirectorService({
        // batch_min_events 999 suppresses auto-schedule: flush is the only
        // trigger, so the assertion really is about flush draining.
        config: makeConfig({
          consolidation: {
            batch_min_events: 999,
            max_events_per_call: 80,
            min_checkpoint_gap_ms: 0,
          },
        }),
        store,
        consolidator,
        plan: makePlan(),
      });
      await svc.initialize();

      svc.observeCommitted([
        makeEvent(1),
        makeEvent(2),
        makeEvent(3),
        makeEvent(4),
      ]);
      await svc.flush();

      expect(consolidateFn).toHaveBeenCalled();
      expect(store.saveStateCalls.length).toBeGreaterThanOrEqual(1);
      expect(store.saveStateCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("is a no-op without a consolidator and without pending events", async () => {
      const store = new FakeStore(emptyState());
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan: makePlan(),
      });
      await svc.initialize();

      await expect(svc.flush()).resolves.toBeUndefined();
      expect(store.saveStateCalls).toHaveLength(0);
      expect(store.saveStateCalls).toHaveLength(0);
    });

    it("awaits an in-flight consolidation whose pending events are already drained (C6)", async () => {
      const store = new FakeStore(emptyState());
      let releaseConsolidation!: () => void;
      const consolidationGate = new Promise<void>((resolve) => {
        releaseConsolidation = resolve;
      });
      const consolidateFn = vi.fn().mockImplementation(
        (_request: ConsolidationRequest) =>
          consolidationGate.then(
            () =>
              ({
                episode: {
                  summary: "Flush episode",
                  characters: [],
                  locations: [],
                  threads: [],
                  setups: [],
                  importance: "normal",
                },
                threadOps: [],
                setupOps: [],
                factOps: [],
                beliefOps: [],
                findings: [],
              }) satisfies ConsolidationResult,
          ),
      );
      const consolidator: MemoryConsolidatorPort = { consolidate: consolidateFn };
      const svc = new NarrativeDirectorService({
        // batch_min_events 999 suppresses auto-schedule: the test starts the
        // consolidation explicitly so the in-flight window is deterministic.
        config: makeConfig({
          consolidation: {
            batch_min_events: 999,
            max_events_per_call: 80,
            min_checkpoint_gap_ms: 0,
          },
        }),
        store,
        consolidator,
        plan: makePlan(),
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(1), makeEvent(2), makeEvent(3)]);
      const inFlight = svc.consolidatePending();
      // Wait until the batch is drained and the consolidator call is in
      // flight: pendingEvents is empty again while consolidateRunning is
      // still true — the C6 race window.
      await vi.waitFor(() => expect(consolidateFn).toHaveBeenCalledTimes(1));

      const flushPromise = svc.flush();
      // flush must await the in-flight consolidation (single-flight), not
      // return while the write is still gated behind the consolidator.
      let flushResolved = false;
      void flushPromise.then(() => {
        flushResolved = true;
      });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(flushResolved).toBe(false);

      releaseConsolidation();
      await flushPromise;
      await inFlight;
      expect(flushResolved).toBe(true);
      // The consolidation's write landed before flush returned.
      expect(store.saveStateCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
