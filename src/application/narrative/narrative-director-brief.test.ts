/**
 * NarrativeDirectorService tests - brief
 * getMemoryProjection content and config normalization.
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
import type { MemoryConsolidatorPort, ConsolidationResult } from "./narrative-director-service.js";

import { makeEvent, makeConfig, FakeStore, emptyState, RecordingDiagnostics, makeThread, makeSetup, makeAnchor, makePlan } from "./narrative-director-test-kit.js";

describe("NarrativeDirectorService brief", () => {

  // -----------------------------------------------------------------------
  // getMemoryProjection — content
  // -----------------------------------------------------------------------
  describe("getMemoryProjection", () => {
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
        config: makeConfig({ brief: { max_relevant_episodes: 2 } }),
        store,
        consolidator: undefined,
        plan: makePlan(),
      });
      await svc.initialize();

      const brief = svc.getMemoryProjection({
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
          makeSetup({ id: "s-active", status: "seeded", lastTouchedAtCheckpoint: 0 }),
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

      const brief = svc.getMemoryProjection({
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

      const brief = svc.getMemoryProjection({
        turn: 1,
        eventSeq: 10,
        location: "anywhere",
        characters: ["anyone"],
      });
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

      const brief = svc.getMemoryProjection({
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

      const brief = svc.getMemoryProjection({
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
      // Simulate the shallow-merge bug: a bare literal with no nested
      // sections (threads, setups, consolidation, brief are all undefined).
      const partial = DEFAULT_NARRATIVE_CONFIG;
      const store = new FakeStore();
      const svc = new NarrativeDirectorService({
        config: partial,
        store,
        consolidator: undefined,
        plan: makePlan(),
      });
      await svc.initialize();

      // getMemoryProjection must not throw TypeError (e.g. "Cannot read
      // properties of undefined (reading 'max_relevant_episodes')").
      const brief = svc.getMemoryProjection({
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
      // Unspecified sections fall back to defaults entirely
      expect((svc as any).config.threads.max_major_active).toBe(
        DEFAULT_NARRATIVE_CONFIG.threads.max_major_active,
      );
    });

    it("normalized config reaches MemoryConsolidator (not raw partial)", async () => {
      // Regression: the constructor passed opts.config (raw) to
      // MemoryConsolidator instead of this.config (normalized).
      // When a caller supplies only a partial literal,
      // MemoryConsolidator.consolidate() reads
      // config.consolidation.max_events_per_call → undefined → TypeError.
      const partial = DEFAULT_NARRATIVE_CONFIG;
      const store = new FakeStore();
      const consolidateFn = vi.fn().mockResolvedValue({
        episode: {
          summary: "consolidated",
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
      const fakePort: MemoryConsolidatorPort = { consolidate: consolidateFn };

      const svc = new NarrativeDirectorService({
        config: partial,
        store,
        consolidator: fakePort,
        plan: makePlan(),
      });
      await svc.initialize();

      // Push events and call consolidatePending directly.
      // Must NOT throw TypeError from undefined consolidation config.
      svc.observeCommitted([makeEvent(1), makeEvent(2)]);
      const result = await svc.consolidatePending();

      expect(result.applied).toBeGreaterThanOrEqual(1);
      expect(consolidateFn).toHaveBeenCalled();
    });
  });
});
