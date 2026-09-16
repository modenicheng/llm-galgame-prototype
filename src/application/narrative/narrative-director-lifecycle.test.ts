/**
 * NarrativeDirectorService tests - lifecycle
 * initialize plan-seed merging, observeCommitted queuing, checkpoint counting.
 *
 * Split from the former narrative-director-service.test.ts along the
 * subsystem seams (MA-A hygiene prerequisite). Shared fakes live in
 * narrative-director-test-kit.ts.
 */

import { describe, it, expect } from "vitest";

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

import { makeEvent, makeConfig, FakeStore, emptyState, RecordingDiagnostics, makeThread, makeSetup, makeAnchor, makePlan } from "./narrative-director-test-kit.js";

describe("NarrativeDirectorService lifecycle", () => {
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

    it("loaded state wins over plan seeds for same ids (restart does not roll back runtime lifecycle)", async () => {
      const sharedState = emptyState();
      sharedState.threads["t-conflict"] = makeThread({
        id: "t-conflict",
        summary: "runtime summary",
        status: "resolved", // runtime pushed it to a terminal state
        source: "runtime",
      });
      sharedState.setups["s-conflict"] = makeSetup({
        id: "s-conflict",
        status: "paid_off", // runtime paid it off
        source: "runtime",
      });
      const store = new FakeStore(sharedState);

      // The plan still carries the ORIGINAL authored values.
      const plan = makePlan(
        [makeThread({ id: "t-conflict", summary: "plan summary", status: "developing", source: "author" })],
        [makeSetup({ id: "s-conflict", status: "planned", source: "author" })],
      );
      const svc = new NarrativeDirectorService({
        config: makeConfig(),
        store,
        consolidator: undefined,
        plan,
      });
      await svc.initialize();

      // The runtime lifecycle survives the restart — the plan must only
      // create MISSING entries, never overwrite persisted state.
      const brief = svc.getBrief({
        turn: 1,
        eventSeq: 10,
        location: "",
        characters: [],
      });
      const t = brief.activeThreads.find((th: { id: string }) => th.id === "t-conflict");
      expect(t).toBeUndefined(); // resolved → not active
      // paid_off is terminal — no directive for s-conflict.
      expect(brief.setupDirectives.some((d: { id: string }) => d.id === "s-conflict")).toBe(false);
      // And the stored summary/status were NOT reset to plan values:
      const mem = (svc as unknown as { memory: NarrativeMemoryState }).memory;
      expect(mem.threads["t-conflict"]!.status).toBe("resolved");
      expect(mem.threads["t-conflict"]!.summary).toBe("runtime summary");
      expect(mem.setups["s-conflict"]!.status).toBe("paid_off");
    });
  });


  // -----------------------------------------------------------------------
  // observeCommitted — queuing
  // -----------------------------------------------------------------------
  describe("observeCommitted", () => {
    it("does not requeue events already covered by the restored memory watermark", async () => {
      const store = new FakeStore({
        ...emptyState(),
        consolidatedThroughEventSeq: 10,
      });
      const svc = new NarrativeDirectorService({
        config: makeConfig({ consolidation: { batch_min_events: 80, max_events_per_call: 80, min_checkpoint_gap_ms: 0 } }),
        store,
        consolidator: undefined,
        plan: makePlan(),
      });
      await svc.initialize();
      svc.observeCommitted([makeEvent(5), makeEvent(11)]);
      const pending = (svc as unknown as { pendingEvents: StoredEvent[] }).pendingEvents;
      expect(pending.map((event) => event.seq)).toEqual([11]);
    });

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
});
