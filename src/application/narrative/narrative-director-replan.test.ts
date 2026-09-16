/**
 * NarrativeDirectorService tests - replan
 * scheduling thresholds and the director plan lifecycle.
 *
 * Split from the former narrative-director-service.test.ts along the
 * subsystem seams (MA-A hygiene prerequisite). Shared fakes live in
 * narrative-director-test-kit.ts.
 */

import { describe, it, expect, vi } from "vitest";

import type { NarrativeMemoryState, PlotThread, SetupPayoff, StoryAnchorState, EpisodeMemory } from "../../core/narrative/memory-types.js";
import type { RejectedOp } from "../../core/narrative/memory-operation.js";
import type { DirectorPlan } from "../../core/narrative/director-plan.js";
import type { NarrativeMemoryStorePort } from "../../core/ports/narrative-memory-store-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { StoryPlan } from "../../adapters/static/story-plan-loader.js";
import type { NarrativeConfig } from "../../config.js";
import type { StoredEvent } from "../../schema.js";
import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";
import { NarrativeDirectorService } from "./narrative-director-service.js";
import type { MemoryConsolidatorPort, ConsolidationResult } from "./narrative-director-service.js";
import type { PlotPlannerPort, PlannerProposal } from "./plot-planner.js";

import { makeEvent, makeConfig, FakeStore, emptyState, RecordingDiagnostics, makeThread, makeSetup, makeAnchor, makePlan } from "./narrative-director-test-kit.js";

describe("NarrativeDirectorService replan", () => {

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

    it("consolidates FIFO: oldest events first, watermark advances continuously", async () => {
      // max_events_per_call: 4, observe 10 events (seq 1..10)
      // → first consolidatePending: port receives the OLDEST 4 (seq 1-4)
      // → episode from=1 to=4; watermark=4; newer 6 (seq 5-10) requeued
      // → second consolidatePending: port receives seq 5-8; episode from=5 to=8
      // → watermark=8
      // → third consolidatePending: port receives seq 9-10; episode from=9 to=10
      // → watermark=10 (continuous: every batch's last seq == new watermark)
      const consolidateFn = vi.fn()
        .mockResolvedValueOnce({
          episode: {
            summary: "Batch 1 (seq 1-4)",
            characters: [],
            locations: [],
            threads: [],
            setups: [],
            importance: "normal",
          },
          threadOps: [],
          setupOps: [],
        } satisfies ConsolidationResult)
        .mockResolvedValueOnce({
          episode: {
            summary: "Batch 2 (seq 5-8)",
            characters: [],
            locations: [],
            threads: [],
            setups: [],
            importance: "normal",
          },
          threadOps: [],
          setupOps: [],
        } satisfies ConsolidationResult)
        .mockResolvedValueOnce({
          episode: {
            summary: "Batch 3 (seq 9-10)",
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

      const store = new FakeStore(emptyState());
      const diag = new RecordingDiagnostics();
      const svc = new NarrativeDirectorService({
        config: makeConfig({
          consolidation: {
            batch_min_events: 999, // suppress auto-schedule
            max_events_per_call: 4,
            min_checkpoint_gap_ms: 0,
          },
        }),
        store,
        consolidator,
        plan: makePlan(),
        diagnostics: diag,
      });
      await svc.initialize();

      // Observe 10 events (seq 1..10)
      const events = Array.from({ length: 10 }, (_, i) => makeEvent(i + 1));
      svc.observeCommitted(events);

      // First consolidation
      const result1 = await svc.consolidatePending();
      expect(result1.applied).toBeGreaterThanOrEqual(1);

      // Port must have received exactly events seq 1-4 (oldest 4, FIFO)
      expect(consolidateFn).toHaveBeenCalledTimes(1);
      const batch1Events = consolidateFn.mock.calls[0]![0]!.events as StoredEvent[];
      expect(batch1Events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);

      // Episode from=1 to=4
      const ep1 = store.appendEpisodesCalls[0]![0]!;
      expect(ep1.fromEventSeq).toBe(1);
      expect(ep1.toEventSeq).toBe(4);

      // Watermark = 4 (continuous front)
      const brief1 = svc.getBrief({ turn: 1, eventSeq: 10, location: "", characters: [] });
      expect(brief1.consolidatedThroughEventSeq).toBe(4);

      // Deferral diagnostic info
      // The consolidator's "Dropping ... overflow" must NOT fire (batch is
      // already capped by the director). The director's deferral diagnostic
      // SHOULD fire.
      expect(diag.infos.some(
        (i) => i.message.toLowerCase().includes("dropping"),
      )).toBe(false);
      expect(diag.infos.some(
        (i) => i.message.includes("deferred"),
      )).toBe(true);

      // Second consolidation: the 6 requeued events are also capped to
      // max_events_per_call=4, so seq 5-8 go out; seq 9-10 requeued again.
      const result2 = await svc.consolidatePending();
      expect(result2.applied).toBeGreaterThanOrEqual(1);
      expect(consolidateFn).toHaveBeenCalledTimes(2);
      const batch2Events = consolidateFn.mock.calls[1]![0]!.events as StoredEvent[];
      expect(batch2Events.map((e) => e.seq)).toEqual([5, 6, 7, 8]);

      // Episode from=5 to=8
      const ep2 = store.appendEpisodesCalls[1]![0]!;
      expect(ep2.fromEventSeq).toBe(5);
      expect(ep2.toEventSeq).toBe(8);

      // Watermark advances to 8 (continuous front)
      const brief2 = svc.getBrief({ turn: 1, eventSeq: 10, location: "", characters: [] });
      expect(brief2.consolidatedThroughEventSeq).toBe(8);

      // Third consolidation: remaining seq 9-10
      const result3 = await svc.consolidatePending();
      expect(result3.applied).toBeGreaterThanOrEqual(1);
      expect(consolidateFn).toHaveBeenCalledTimes(3);
      const batch3Events = consolidateFn.mock.calls[2]![0]!.events as StoredEvent[];
      expect(batch3Events.map((e) => e.seq)).toEqual([9, 10]);

      // Episode from=9 to=10
      const ep3 = store.appendEpisodesCalls[2]![0]!;
      expect(ep3.fromEventSeq).toBe(9);
      expect(ep3.toEventSeq).toBe(10);

      // Watermark advances to 10 (continuous front)
      const brief3 = svc.getBrief({ turn: 1, eventSeq: 10, location: "", characters: [] });
      expect(brief3.consolidatedThroughEventSeq).toBe(10);

      // No more pending events
      const result4 = await svc.consolidatePending();
      expect(result4.applied).toBe(0);
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
      // Second call while the first is in flight must NOT start a second
      // consolidation; it shares the SAME in-flight promise (single-flight,
      // audit P1-7 flush waits on it) and settles with the same outcome.
      const p2 = svc.consolidatePending();
      expect(consolidator.consolidate).toHaveBeenCalledTimes(1);

      // Resolve the blocked consolidator: both callers settle together.
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
      const result1 = await p1;
      const result2 = await p2;

      expect(result1.applied).toBeGreaterThanOrEqual(1);
      expect(result2).toEqual(result1);
      expect(consolidator.consolidate).toHaveBeenCalledTimes(1);
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

  function makeFakePlanner(proposal: PlannerProposal): PlotPlannerPort {
    return { plan: vi.fn().mockResolvedValue(proposal) };
  }
  const FAKE_PROPOSAL: PlannerProposal = {
    phase: "development",
    currentGoal: "推进对苏遥的怀疑",
    beats: [{ purpose: "侧面证据" }],
    focusThreads: ["t1"],
    revealLocks: ["reveal_x"],
    anchorOps: [{ type: "reach", id: "a2" }],
  };


  describe("director plan lifecycle", () => {
    /** Access the private in-memory state (test seam). */
    function serviceMemory(svc: NarrativeDirectorService): NarrativeMemoryState {
      return (svc as unknown as { memory: NarrativeMemoryState }).memory;
    }

    /** Access the private active director plan (test seam). */
    function servicePlan(
      svc: NarrativeDirectorService,
    ): DirectorPlan | undefined {
      return (svc as unknown as { plan: DirectorPlan | undefined }).plan;
    }

    /** Anchor fixture: a1 reached, a2 pending behind a1 (matches the
     * plot-planner.test.ts makeMemory shape). */
    function anchorPlan(): StoryPlan {
      return makePlan(
        [makeThread({ id: "t1", status: "open" })],
        [],
        [
          makeAnchor({ id: "a1", status: "reached" }),
          makeAnchor({ id: "a2", prerequisites: ["a1"], status: "pending" }),
        ],
      );
    }

    it("loads a persisted plan on initialize", async () => {
      const store = new FakeStore(emptyState());
      store.seedPlan({
        revision: 2,
        basedOnMemoryRevision: 1,
        phase: "escalation",
        currentGoal: "查明真相",
        beats: [{ purpose: "逼问苏遥" }],
        focusThreads: [],
        setupDirectives: [],
        revealLocks: ["reveal_x"],
        expiresAfterCheckpoint: 5,
      });
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
        location: "",
        characters: [],
      });
      expect(brief.phase).toBe("escalation");
      expect(brief.currentGoal).toBe("查明真相");
      expect(brief.revealLocks).toEqual(["reveal_x"]);
    });

    it("creates the first plan after the first checkpoint when planner is present", async () => {
      const store = new FakeStore(emptyState());
      const planner = makeFakePlanner(FAKE_PROPOSAL);
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan: anchorPlan(),
        planner,
      });
      await svc.initialize();

      svc.checkpoint("interaction_completed");
      await vi.waitFor(() => expect(planner.plan).toHaveBeenCalledTimes(1));
      // The anchor apply + plan swap happen after the planner resolves.
      await vi.waitFor(() => expect(servicePlan(svc)).toBeDefined());

      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.phase).toBe("development");
      expect(brief.currentGoal).toBe(FAKE_PROPOSAL.currentGoal);
      expect(brief.beats).toEqual(FAKE_PROPOSAL.beats);
      expect(brief.revealLocks).toEqual(["reveal_x"]);

      // Plan persisted with revision 1 (first generation).
      expect(store.savePlanCalls).toHaveLength(1);
      expect(store.savePlanCalls[0]!.revision).toBe(1);

      // Anchor a2 progressed inside the memory-write mutex and persisted.
      const mem = serviceMemory(svc);
      expect(mem.anchors["a2"]!.status).toBe("reached");
      expect(mem.revision).toBe(1);
      expect(store.saveStateCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("does not replan without planner, without memory progress, or while running", async () => {
      // (a) No planner: checkpoints never create or refresh a plan.
      const storeNoPlanner = new FakeStore(emptyState());
      const svcNoPlanner = new NarrativeDirectorService({
        config: makeConfig(),
        store: storeNoPlanner,
        consolidator: undefined,
        plan: makePlan(),
      });
      await svcNoPlanner.initialize();
      svcNoPlanner.checkpoint("interaction_completed");
      svcNoPlanner.checkpoint("interaction_completed");
      expect(servicePlan(svcNoPlanner)).toBeUndefined();

      // (b) Plan exists and checkpointCount is far below expiry → no replan.
      const storeFar = new FakeStore(emptyState());
      storeFar.seedPlan({
        revision: 1,
        basedOnMemoryRevision: 0,
        phase: "development",
        currentGoal: "g",
        beats: [{ purpose: "p" }],
        focusThreads: [],
        setupDirectives: [],
        revealLocks: [],
        expiresAfterCheckpoint: 10,
      });
      const plannerFar = makeFakePlanner(FAKE_PROPOSAL);
      const svcFar = new NarrativeDirectorService({
        config: makeConfig(),
        store: storeFar,
        consolidator: undefined,
        plan: makePlan(),
        planner: plannerFar,
      });
      await svcFar.initialize();
      svcFar.checkpoint("interaction_completed");
      expect(plannerFar.plan).not.toHaveBeenCalled();

      // (c) Plan exists and checkpoints crossed the ahead-window, but
      // memory.revision never advanced → no replan.
      const storeNoProgress = new FakeStore(emptyState());
      storeNoProgress.seedPlan({
        revision: 1,
        basedOnMemoryRevision: 1, // memory.revision stays 0 → no progress
        phase: "development",
        currentGoal: "g",
        beats: [{ purpose: "p" }],
        focusThreads: [],
        setupDirectives: [],
        revealLocks: [],
        expiresAfterCheckpoint: 5,
      });
      const plannerNoProgress = makeFakePlanner(FAKE_PROPOSAL);
      const svcNoProgress = new NarrativeDirectorService({
        config: makeConfig(),
        store: storeNoProgress,
        consolidator: undefined,
        plan: makePlan(),
        planner: plannerNoProgress,
      });
      await svcNoProgress.initialize();
      for (let i = 0; i < 4; i++) {
        svcNoProgress.checkpoint("interaction_completed"); // count → 4 ≥ 5-1
      }
      expect(plannerNoProgress.plan).not.toHaveBeenCalled();

      // (d) A replan in flight (pending planner promise) suppresses further
      // checkpoints from starting a second planner call (single-flight).
      let resolvePlanner!: (v: PlannerProposal) => void;
      const deferred = new Promise<PlannerProposal>((resolve) => {
        resolvePlanner = resolve;
      });
      const plannerBusy: PlotPlannerPort = {
        plan: vi.fn().mockReturnValue(deferred),
      };
      const storeBusy = new FakeStore(emptyState());
      const svcBusy = new NarrativeDirectorService({
        config: makeConfig(),
        store: storeBusy,
        consolidator: undefined,
        plan: anchorPlan(),
        planner: plannerBusy,
      });
      await svcBusy.initialize();
      svcBusy.checkpoint("interaction_completed"); // starts replan (pending)
      svcBusy.checkpoint("interaction_completed"); // must be suppressed
      expect(plannerBusy.plan).toHaveBeenCalledTimes(1);
      resolvePlanner(FAKE_PROPOSAL);
      await vi.waitFor(() => expect(servicePlan(svcBusy)).toBeDefined());
    });

    it("replans ahead of expiry with memory progress and slides the horizon", async () => {
      const store = new FakeStore(emptyState());
      const consolidateFn = vi.fn().mockResolvedValue({
        episode: {
          summary: "Progress episode",
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
      const planner = makeFakePlanner(FAKE_PROPOSAL);
      const svc = new NarrativeDirectorService({
        config: makeConfig({
          consolidation: {
            batch_min_events: 999, // suppress auto-schedule
            max_events_per_call: 80,
            min_checkpoint_gap_ms: 0,
          },
        }),
        store,
        consolidator,
        plan: anchorPlan(),
        planner,
      });
      await svc.initialize();

      // First checkpoint → first plan. Horizon 3 → expires = 1 + 3 = 4.
      svc.checkpoint("interaction_completed");
      await vi.waitFor(() =>
        expect(servicePlan(svc)?.expiresAfterCheckpoint).toBe(4),
      );
      expect(servicePlan(svc)!.revision).toBe(1);

      // Advance memory.revision via one consolidation. Note: replan #1's
      // anchor progression already bumped revision 0 → 1, so consolidation
      // lands on 2 — the delta is what matters for replan scheduling.
      svc.observeCommitted([makeEvent(1)]);
      await svc.consolidatePending();
      expect(serviceMemory(svc).revision).toBe(2);

      // Two more checkpoints → count 3 ≥ 4 - 1 (ahead) with revision
      // progress → replan. New plan slides the horizon: 3 + 3 = 6.
      svc.checkpoint("interaction_completed");
      svc.checkpoint("interaction_completed");
      await vi.waitFor(() => expect(planner.plan).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(servicePlan(svc)?.revision).toBe(2));
      expect(servicePlan(svc)!.expiresAfterCheckpoint).toBe(6);
      expect(servicePlan(svc)!.basedOnMemoryRevision).toBe(2);
    });

    it("omits the plan section from the brief when the plan has hard-expired", async () => {
      const store = new FakeStore(emptyState());
      store.seedPlan({
        revision: 1,
        basedOnMemoryRevision: 0,
        phase: "development",
        currentGoal: "旧目标",
        beats: [{ purpose: "旧节拍" }],
        focusThreads: [],
        setupDirectives: [],
        revealLocks: ["reveal_x"],
        expiresAfterCheckpoint: 4,
      });
      const planner: PlotPlannerPort = {
        plan: vi.fn().mockRejectedValue(new Error("LLM down")),
      };
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan: makePlan(),
        planner,
      });
      await svc.initialize();

      // 5 checkpoints → count 5 > 4 (hard expiry); every replan attempt
      // fails so the old (expired) plan stays.
      for (let i = 0; i < 5; i++) {
        svc.checkpoint("interaction_completed");
      }
      await vi.waitFor(() => expect(planner.plan).toHaveBeenCalled());

      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.currentGoal).toBeUndefined();
      expect(brief.phase).toBeUndefined();
      expect(brief.beats).toBeUndefined();
      expect(brief.revealLocks).toEqual([]);
    });

    it("keeps the old plan when replan fails and records rejected ops", async () => {
      // (a) Port throws → replan() resolves, old plan kept, no savePlan.
      const store = new FakeStore(emptyState());
      const oldPlan: DirectorPlan = {
        revision: 1,
        basedOnMemoryRevision: 0,
        phase: "escalation",
        currentGoal: "旧计划",
        beats: [{ purpose: "逼问" }],
        focusThreads: [],
        setupDirectives: [],
        revealLocks: [],
        expiresAfterCheckpoint: 100,
      };
      store.seedPlan(oldPlan);
      const failingPlanner: PlotPlannerPort = {
        plan: vi.fn().mockRejectedValue(new Error("LLM down")),
      };
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan: makePlan(),
        planner: failingPlanner,
      });
      await svc.initialize();

      await expect(svc.replan()).resolves.toBeUndefined();
      expect(servicePlan(svc)).toBe(oldPlan);
      expect(store.savePlanCalls).toHaveLength(0);

      // (b) Schema-invalid proposal (beats: []) → kind "plan" rejection
      // recorded via store.appendOps.
      const storeBad = new FakeStore(emptyState());
      const badPlanner: PlotPlannerPort = {
        plan: vi.fn().mockResolvedValue({ ...FAKE_PROPOSAL, beats: [] }),
      };
      const svcBad = new NarrativeDirectorService({
        config: makeConfig(),
        store: storeBad,
        consolidator: undefined,
        plan: anchorPlan(),
        planner: badPlanner,
      });
      await svcBad.initialize();

      await expect(svcBad.replan()).resolves.toBeUndefined();
      expect(storeBad.appendOpsCalls.length).toBeGreaterThanOrEqual(1);
      const recorded = storeBad.appendOpsCalls.flat();
      expect(recorded.some((op) => op.kind === "plan")).toBe(true);
      expect(servicePlan(svcBad)).toBeUndefined();
    });

    it("applies anchor ops inside the memory-write mutex without losing consolidation changes", async () => {
      // Both consolidatePending and replan are in flight at the same time;
      // their apply/persist/swap sections serialize through the mutex and
      // each re-reads the latest memory inside the chain.
      //
      // Discrimination: without the chain, the second writer's callback
      // clones `this.memory` BEFORE the first writer's swap lands — the
      // first writer is blocked at the saveState gate, so it has cloned and
      // applied but not yet committed. Both then commit their shadows and
      // the later swap clobbers the earlier one (revision stays 1 and one
      // of the two changes — thread advance / anchor reached — is lost).
      // With the chain, the second callback only starts after the first has
      // fully committed, so it clones the post-swap state and both changes
      // survive (final revision 2).
      let resolveConsolidator!: (value: ConsolidationResult) => void;
      const deferredConsolidation = new Promise<ConsolidationResult>((resolve) => {
        resolveConsolidator = resolve;
      });
      const consolidateFn = vi.fn().mockReturnValue(deferredConsolidation);
      const consolidator: MemoryConsolidatorPort = { consolidate: consolidateFn };

      let resolvePlanner!: (v: PlannerProposal) => void;
      const deferredPlan = new Promise<PlannerProposal>((resolve) => {
        resolvePlanner = resolve;
      });
      const planner: PlotPlannerPort = { plan: vi.fn().mockReturnValue(deferredPlan) };

      const store = new FakeStore(emptyState());
      const svc = new NarrativeDirectorService({
        config: makeConfig({
          consolidation: {
            batch_min_events: 999, // suppress auto-schedule
            max_events_per_call: 80,
            min_checkpoint_gap_ms: 0,
          },
        }),
        store,
        consolidator,
        plan: anchorPlan(),
        planner,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(1)]);

      // Gate the next saveState: the first writer to reach its commit point
      // blocks mid-critical-section (cloned + applied, not yet swapped).
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      store.saveStateGate = gate;

      const consolidationRun = svc.consolidatePending();
      const replanRun = svc.replan();

      // Resolve BOTH in-flight calls before awaiting either run, so both
      // write callbacks are enqueued on the chain while the first is
      // blocked at the gate. (Which callback lands first is irrelevant: it
      // blocks, and the other is chained behind it.)
      resolvePlanner(FAKE_PROPOSAL);
      resolveConsolidator({
        episode: {
          summary: "Mutex episode",
          characters: [],
          locations: [],
          threads: ["t1"],
          setups: [],
          importance: "normal",
        },
        threadOps: [{ type: "advance", id: "t1" }],
        setupOps: [],
      });

      // No timers: the two resolves each schedule one continuation (both
      // mutateMemory callbacks get enqueued), and one more microtask turn
      // lets the first callback actually reach — and block at — the gate.
      await Promise.resolve();
      await Promise.resolve();
      releaseGate();

      await Promise.all([replanRun, consolidationRun]);

      // Final memory: revision 2 (replan + consolidation), with BOTH the
      // consolidation's thread advance and the replan's anchor reached.
      const mem = serviceMemory(svc);
      expect(mem.revision).toBe(2); // 1 (replan) + 1 (consolidation)
      expect(mem.anchors["a2"]!.status).toBe("reached"); // replan kept
      expect(mem.threads["t1"]!.status).toBe("developing"); // consolidation kept
      expect(mem.consolidatedThroughEventSeq).toBe(1);
      expect(mem.recentEpisodeIds).toHaveLength(1);
      const appended = store.appendEpisodesCalls.flat();
      expect(appended).toHaveLength(1);
      expect(mem.recentEpisodeIds[0]).toBe(appended[0]!.id);

      // Persisted state matches the in-memory swap: both writes committed
      // through the gate, none clobbered.
      expect(store.saveStateCalls).toHaveLength(2);
      const persisted = store.saveStateCalls[store.saveStateCalls.length - 1]!;
      expect(persisted.revision).toBe(2);
      expect(persisted.anchors["a2"]!.status).toBe("reached");
      expect(persisted.threads["t1"]!.status).toBe("developing");
    });

    it("anchors plan expiry to the chain-latest live memory at activation (final review P2)", async () => {
      // Consolidation and replan both fire from checkpoint #1; the
      // consolidation apply SWAPS this.memory while the planner call is
      // still in flight. The planner (PlotPlanner class) builds the plan
      // from request.memory — the pre-swap object, frozen at count N —
      // so a checkpoint landing after the swap advances the NEW live
      // object without touching the planner's snapshot. Without the
      // service-side re-anchor, the stored plan expires at N + horizon
      // even though the live count is already N+1.
      //
      // Discrimination: without the fix, replan() stores outcome.plan
      // as-is → expiresAfterCheckpoint 1 + 3 = 4 and
      // basedOnMemoryRevision 0 (the detached request-time snapshot).
      // With the fix, activation re-reads the chain-latest memory after
      // the anchor apply/swap → 2 + 3 = 5 and revision 2 — matching the
      // last saveStateCalls entry (the fake's persisted activation state).
      let resolvePlanner!: (v: PlannerProposal) => void;
      const deferredPlan = new Promise<PlannerProposal>((resolve) => {
        resolvePlanner = resolve;
      });
      const planner: PlotPlannerPort = {
        plan: vi.fn().mockReturnValue(deferredPlan),
      };

      const consolidateFn = vi.fn().mockResolvedValue({
        episode: {
          summary: "Mid-flight episode",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
      } satisfies ConsolidationResult);
      const consolidator: MemoryConsolidatorPort = {
        consolidate: consolidateFn,
      };

      const store = new FakeStore(emptyState());
      const svc = new NarrativeDirectorService({
        config: makeConfig({
          consolidation: {
            batch_min_events: 999, // suppress auto-schedule
            max_events_per_call: 80,
            min_checkpoint_gap_ms: 0,
          },
        }),
        store,
        consolidator,
        plan: anchorPlan(),
        planner,
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(1)]);
      svc.checkpoint("interaction_completed"); // count → 1 (N); replan starts, planner deferred

      // Consolidation's apply must COMPLETE (swap) while the planner is
      // still deferred: that detaches the planner's request.memory (count
      // N) from the live object. `await consolidationRun` guarantees the
      // swap landed before we advance the live counter below — no gate
      // needed, the planner's deferral provides the ordering.
      const consolidationRun = svc.consolidatePending();
      await consolidationRun;

      svc.checkpoint("interaction_completed"); // live count N → N+1 (2), replan still in flight
      expect(planner.plan).toHaveBeenCalledTimes(1); // single-flight held

      resolvePlanner(FAKE_PROPOSAL);
      await vi.waitFor(() => expect(servicePlan(svc)).toBeDefined());

      const plan = servicePlan(svc)!;
      // N + 1 + horizon = 2 + 3 (request-time snapshot would give 1 + 3).
      expect(plan.expiresAfterCheckpoint).toBe(2 + 3);
      // Activation-time revision: 1 (consolidation) + 1 (anchor apply).
      expect(plan.basedOnMemoryRevision).toBe(2);

      // The fake's saveStateCalls confirm the activation-time live state:
      // the last persisted shadow is the replan's anchor apply.
      expect(store.saveStateCalls).toHaveLength(2);
      const persisted = store.saveStateCalls[store.saveStateCalls.length - 1]!;
      expect(persisted.revision).toBe(2);
      expect(persisted.checkpointCount).toBe(2);
      expect(plan.basedOnMemoryRevision).toBe(persisted.revision);
    });

    it("preserves a checkpoint increment landing between clone and swap (final review P3)", async () => {
      // checkpoint() mutates the live object synchronously. The
      // consolidation mutateMemory callback clones the chain-latest state
      // and swaps the persisted shadow in after saveState — a checkpoint
      // landing after the clone but before the swap increments the OLD
      // live object, and the swap would otherwise discard it (counter
      // permanently one lower).
      //
      // Discrimination: without the fix, the swap restores
      // checkpointCount 0 → the increment is lost and the next getBrief
      // reports 0. With the fix, the callback copies the live count onto
      // the shadow right before the swap → the brief reports
      // pre-increment + 1.
      const consolidateFn = vi.fn().mockResolvedValue({
        episode: {
          summary: "Gate episode",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
      } satisfies ConsolidationResult);
      const consolidator: MemoryConsolidatorPort = {
        consolidate: consolidateFn,
      };

      const store = new FakeStore(emptyState());
      const svc = new NarrativeDirectorService({
        config: makeConfig({
          consolidation: {
            batch_min_events: 999, // suppress auto-schedule
            max_events_per_call: 80,
            min_checkpoint_gap_ms: 0,
          },
        }),
        store,
        consolidator,
        plan: makePlan(),
      });
      await svc.initialize();

      svc.observeCommitted([makeEvent(1)]);

      // Block the writer at its commit point: cloned + applied, not yet
      // swapped.
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      store.saveStateGate = gate;

      const consolidationRun = svc.consolidatePending();
      // No timers: flush microtasks until the writer's saveState consumes
      // the gate — i.e. it has cloned + applied and is blocked at its
      // commit point, not yet swapped. The loop exits as soon as the gate
      // is consumed (bounded only so a regression fails loudly instead of
      // hanging).
      for (let i = 0; i < 16 && store.saveStateGate !== undefined; i++) {
        await Promise.resolve();
      }
      expect(store.saveStateGate).toBeUndefined(); // writer blocked at gate

      svc.checkpoint("interaction_completed"); // live count 0 → 1, writer blocked
      releaseGate();
      await consolidationRun;

      // The increment survived the swap: the next brief reports count 1.
      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      expect(brief.checkpointCount).toBe(1);
      expect(serviceMemory(svc).checkpointCount).toBe(1);
    });
  });
});
