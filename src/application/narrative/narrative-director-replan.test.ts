/**
 * NarrativeDirectorService tests - replan seam (post-M4.4): the planner
 * is deleted; only consolidation scheduling thresholds remain here.
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
import type { MemoryConsolidatorPort, ConsolidationResult } from "./narrative-director-service.js";
import { makeEvent, makeConfig, FakeStore, emptyState, RecordingDiagnostics, makeThread, makeSetup, makeAnchor, makePlan } from "./narrative-director-test-kit.js";

describe("NarrativeDirectorService replan", () => {
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
factOps: [],
beliefOps: [],
findings: [],
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
factOps: [],
beliefOps: [],
findings: [],
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
factOps: [],
beliefOps: [],
findings: [],
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
factOps: [],
beliefOps: [],
findings: [],
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
factOps: [],
beliefOps: [],
findings: [],
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
factOps: [],
beliefOps: [],
findings: [],
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
factOps: [],
beliefOps: [],
findings: [],
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
      const brief1 = svc.getMemoryProjection({ turn: 1, eventSeq: 10, location: "", characters: [] });
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
      const brief2 = svc.getMemoryProjection({ turn: 1, eventSeq: 10, location: "", characters: [] });
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
      const brief3 = svc.getMemoryProjection({ turn: 1, eventSeq: 10, location: "", characters: [] });
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
        factOps: [],
        beliefOps: [],
        findings: [],
      });
      const result1 = await p1;
      const result2 = await p2;

      expect(result1.applied).toBeGreaterThanOrEqual(1);
      expect(result2).toEqual(result1);
      expect(consolidator.consolidate).toHaveBeenCalledTimes(1);
    });
  });
});

