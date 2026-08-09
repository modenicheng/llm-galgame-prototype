/**
 * Tests for MemoryConsolidator (Task 8).
 *
 * The consolidation pipeline extracted from Task 6's
 * NarrativeDirectorService.consolidatePending(): truncation to
 * max_events_per_call, port invocation, validator filtering, episode id
 * generation (`ep_{revision+1}_{fromSeq}`), and rejection recording.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  NarrativeMemoryState,
  PlotThread,
  SetupPayoff,
} from "../../core/narrative/memory-types.js";
import type {
  ThreadOp,
  SetupOp,
  EpisodeSummaryOp,
} from "../../core/narrative/memory-operation.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { NarrativeConfig } from "../../config.js";
import type { StoredEvent } from "../../schema.js";
import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";

import { MemoryConsolidator } from "./memory-consolidator.js";
import type {
  MemoryConsolidatorPort,
  ConsolidationRequest,
  ConsolidationResult,
} from "./memory-consolidator.js";

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

function makeThread(overrides: Partial<PlotThread> & { id: string }): PlotThread {
  return {
    kind: "main",
    summary: `${overrides.id} summary`,
    status: "open",
    importance: "major",
    introducedAtCheckpoint: 0,
    lastTouchedAtCheckpoint: 0,
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

/** A valid episode summary op. */
function makeEpisodeOp(
  overrides: Partial<EpisodeSummaryOp> = {},
): EpisodeSummaryOp {
  return {
    summary: "An episode",
    characters: ["aiko"],
    locations: ["study"],
    threads: [],
    setups: [],
    importance: "normal",
    ...overrides,
  };
}

function makeResult(
  overrides: Partial<ConsolidationResult> = {},
): ConsolidationResult {
  return {
    episode: makeEpisodeOp(),
    threadOps: [],
    setupOps: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MemoryConsolidator tests
// ---------------------------------------------------------------------------

describe("MemoryConsolidator", () => {
  let diag: RecordingDiagnostics;

  beforeEach(() => {
    diag = new RecordingDiagnostics();
  });

  function makeConsolidator(
    port: MemoryConsolidatorPort | undefined,
    config: NarrativeConfig = makeConfig(),
  ): MemoryConsolidator {
    return new MemoryConsolidator({
      port,
      config,
      diagnostics: diag,
    });
  }

  // -----------------------------------------------------------------------
  // Success path
  // -----------------------------------------------------------------------
  describe("consolidate — success path", () => {
    it("calls the port with events, active threads, non-terminal setups, and state", async () => {
      const consolidate = vi.fn().mockResolvedValue(makeResult());
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.revision = 2;
      memory.threads = {
        t1: makeThread({ id: "t1", status: "open" }),
        t2: makeThread({ id: "t2", status: "resolved" }), // terminal → excluded
      };
      memory.setups = {
        s1: makeSetup({ id: "s1", status: "planned" }),
        s2: makeSetup({ id: "s2", status: "paid_off" }), // terminal → excluded
      };

      const outcome = await consolidator.consolidate(
        [makeEvent(10), makeEvent(11)],
        memory,
        "study",
        ["aiko"],
      );

      expect(consolidate).toHaveBeenCalledTimes(1);
      const request: ConsolidationRequest = consolidate.mock
        .calls[0]![0] as ConsolidationRequest;
      expect(request.events.map((e) => e.seq)).toEqual([10, 11]);
      expect(request.threads.map((t) => t.id)).toEqual(["t1"]);
      expect(request.setups.map((s) => s.id)).toEqual(["s1"]);
      expect(request.stateLocation).toBe("study");
      expect(request.stateCharacters).toEqual(["aiko"]);
    });

    it("returns the raw result and builds a validated episode with the generated id", async () => {
      const result = makeResult({
        episode: makeEpisodeOp({
          summary: "A new episode",
          characters: ["aiko"],
          locations: ["study"],
          threads: ["t1"],
          setups: ["s1"],
          importance: "major",
        }),
      });
      const consolidate = vi.fn().mockResolvedValue(result);
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.revision = 2;

      const outcome = await consolidator.consolidate(
        [makeEvent(10), makeEvent(11), makeEvent(12)],
        memory,
        "",
        [],
      );

      // Raw result passes through unchanged
      expect(outcome.result).toBe(result);
      // Episode id = `ep_{revision+1}_{fromSeq}`, from/to from the batch
      expect(outcome.episode).not.toBeNull();
      expect(outcome.episode!.id).toBe("ep_3_10");
      expect(outcome.episode!.fromEventSeq).toBe(10);
      expect(outcome.episode!.toEventSeq).toBe(12);
      expect(outcome.episode!.summary).toBe("A new episode");
      expect(outcome.episode!.characters).toEqual(["aiko"]);
      expect(outcome.episode!.locations).toEqual(["study"]);
      expect(outcome.episode!.threads).toEqual(["t1"]);
      expect(outcome.episode!.setups).toEqual(["s1"]);
      expect(outcome.episode!.importance).toBe("major");
      // Nothing rejected
      expect(outcome.rejected).toEqual([]);
    });

    it("passes validated thread/setup ops through to the outcome", async () => {
      const threadOps: ThreadOp[] = [
        { type: "touch", id: "t1", progress: "new summary" },
        { type: "advance", id: "t1" },
      ];
      const setupOps: SetupOp[] = [
        { type: "seed", id: "s1" },
        { type: "hold", id: "s1" },
      ];
      const consolidate = vi
        .fn()
        .mockResolvedValue(makeResult({ threadOps, setupOps }));
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.threads = { t1: makeThread({ id: "t1", status: "open" }) };
      memory.setups = { s1: makeSetup({ id: "s1", status: "planned" }) };

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        memory,
        "",
        [],
      );

      expect(outcome.threadOps).toEqual(threadOps);
      expect(outcome.setupOps).toEqual(setupOps);
      expect(outcome.rejected).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Rejection paths
  // -----------------------------------------------------------------------
  describe("consolidate — rejection paths", () => {
    it("moves invalid threadOps into rejected and keeps valid ones", async () => {
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          threadOps: [
            { type: "touch", id: "t1" }, // valid
            { type: "touch", id: "ghost" }, // invalid: does not exist
          ],
        }),
      );
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.threads = { t1: makeThread({ id: "t1", status: "open" }) };

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        memory,
        "",
        [],
      );

      expect(outcome.threadOps).toEqual([{ type: "touch", id: "t1" }]);
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]!.kind).toBe("thread");
      expect(outcome.rejected[0]!.op).toEqual({ type: "touch", id: "ghost" });
      expect(outcome.rejected[0]!.reason).toContain("ghost");
    });

    it("moves invalid setupOps into rejected and keeps valid ones", async () => {
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          setupOps: [
            { type: "seed", id: "s1" }, // valid
            { type: "seed", id: "ghost-s" }, // invalid: does not exist
          ],
        }),
      );
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.setups = { s1: makeSetup({ id: "s1", status: "planned" }) };

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        memory,
        "",
        [],
      );

      expect(outcome.setupOps).toEqual([{ type: "seed", id: "s1" }]);
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]!.kind).toBe("setup");
      expect(outcome.rejected[0]!.op).toEqual({ type: "seed", id: "ghost-s" });
      expect(outcome.rejected[0]!.reason).toContain("ghost-s");
    });

    it("validates ops transactionally against a shadow: same-batch state changes are visible (audit finding 4)", async () => {
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          // Two creates in ONE batch. With max_minor_active: 3 and 2 active
          // minor threads already, only the first may pass — the second
          // must see the first's shadow application.
          threadOps: [
            { type: "create", id: "rt1" },
            { type: "create", id: "rt2" },
          ],
          // Two seeds of the SAME setup: the second must be rejected
          // (status is seeded after the first applied to the shadow).
          setupOps: [
            { type: "seed", id: "s1" },
            { type: "seed", id: "s1" },
          ],
        }),
      );
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.threads = {
        existing1: makeThread({ id: "existing1", status: "open", importance: "minor" }),
        existing2: makeThread({ id: "existing2", status: "open", importance: "minor" }),
      };
      memory.setups = { s1: makeSetup({ id: "s1", status: "planned" }) };

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        memory,
        "",
        [],
      );

      // First create passes (2 + 1 = 3, at the cap); second rejected.
      expect(outcome.threadOps).toEqual([{ type: "create", id: "rt1" }]);
      expect(outcome.rejected).toHaveLength(2);
      expect(outcome.rejected[0]!.op).toEqual({ type: "create", id: "rt2" });
      expect(outcome.rejected[0]!.reason).toContain("上限");
      // First seed passes; second rejected (s1 is already seeded in shadow).
      expect(outcome.setupOps).toEqual([{ type: "seed", id: "s1" }]);
      expect(outcome.rejected[1]!.op).toEqual({ type: "seed", id: "s1" });
      expect(outcome.rejected[1]!.reason).toContain("只有 planned 可以 seed");
    });

    it("rejects a setup budget overflow across same-batch seeds", async () => {
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          setupOps: [
            { type: "seed", id: "s1" },
            { type: "seed", id: "s2" },
          ],
        }),
      );
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      // max_active: 6; 5 already active → s1 fits (6), s2 must be rejected.
      memory.setups = {
        s1: makeSetup({ id: "s1", status: "planned" }),
        s2: makeSetup({ id: "s2", status: "planned" }),
      };
      for (let i = 0; i < 5; i++) {
        memory.setups[`active_${i}`] = makeSetup({
          id: `active_${i}`,
          status: "seeded",
        });
      }

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        memory,
        "",
        [],
      );

      expect(outcome.setupOps).toEqual([{ type: "seed", id: "s1" }]);
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]!.op).toEqual({ type: "seed", id: "s2" });
      expect(outcome.rejected[0]!.reason).toContain("上限");
    });

    it("rejects an invalid episode op and records it", async () => {
      const badEpisode = makeEpisodeOp({ summary: "" });
      const consolidate = vi
        .fn()
        .mockResolvedValue(makeResult({ episode: badEpisode }));
      const consolidator = makeConsolidator({ consolidate });

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        emptyState(),
        "",
        [],
      );

      // Result still returned; episode filtered out and recorded as rejected
      expect(outcome.result).toBeDefined();
      expect(outcome.episode).toBeNull();
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]!.kind).toBe("episode");
      expect(outcome.rejected[0]!.op).toBe(badEpisode);
      expect(outcome.rejected[0]!.reason).toContain("episode summary");
    });

    it("records rejections in Task 6 order: episode, thread, setup", async () => {
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          episode: makeEpisodeOp({ summary: "" }), // rejected
          threadOps: [{ type: "touch", id: "ghost" }], // rejected
          setupOps: [{ type: "seed", id: "ghost-s" }], // rejected
        }),
      );
      const consolidator = makeConsolidator({ consolidate });

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        emptyState(),
        "",
        [],
      );

      expect(outcome.rejected.map((r) => r.kind)).toEqual([
        "episode",
        "thread",
        "setup",
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Port failure
  // -----------------------------------------------------------------------
  describe("consolidate — port failure", () => {
    it("returns a null result without throwing and emits a warning", async () => {
      const consolidate = vi
        .fn()
        .mockRejectedValue(new Error("LLM timeout"));
      const consolidator = makeConsolidator({ consolidate });

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        emptyState(),
        "",
        [],
      );

      expect(outcome.result).toBeNull();
      expect(outcome.episode).toBeNull();
      expect(outcome.threadOps).toEqual([]);
      expect(outcome.setupOps).toEqual([]);
      expect(outcome.rejected).toEqual([]);
      // Diagnostic warning emitted (same pipeline behavior as Task 6)
      expect(diag.warns.length).toBeGreaterThanOrEqual(1);
      expect(diag.warns[0]!.message).toContain("consolidation failed");
    });
  });

  // -----------------------------------------------------------------------
  // Truncation
  // -----------------------------------------------------------------------
  describe("consolidate — event truncation", () => {
    it("sends at most max_events_per_call events to the port, keeping the OLDEST N (FIFO)", async () => {
      const consolidate = vi.fn().mockResolvedValue(makeResult());
      // Cap of 4; 10 events → only seqs 1..4 reach the port
      const consolidator = makeConsolidator({ consolidate }, makeConfig({
        consolidation: {
          batch_min_events: 4,
          max_events_per_call: 4,
          min_checkpoint_gap_ms: 0,
        },
      }));

      const events = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seq) =>
        makeEvent(seq),
      );
      const outcome = await consolidator.consolidate(
        events,
        emptyState(),
        "",
        [],
      );

      expect(consolidate).toHaveBeenCalledTimes(1);
      const request = consolidate.mock.calls[0]![0] as ConsolidationRequest;
      expect(request.events).toHaveLength(4);
      expect(request.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      // Overflow drop is reported via diagnostics (Task 6 behavior)
      expect(diag.infos.some((i) => i.message.includes("Dropping 6 newer overflow"))).toBe(true);
      // Episode fromSeq is the first seq of the CAPPED batch
      expect(outcome.episode!.fromEventSeq).toBe(1);
      expect(outcome.episode!.toEventSeq).toBe(4);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("consolidate — edge cases", () => {
    it("returns an empty outcome without calling anything when port is undefined", async () => {
      const consolidator = makeConsolidator(undefined);

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        emptyState(),
        "",
        [],
      );

      expect(outcome.result).toBeNull();
      expect(outcome.episode).toBeNull();
      expect(outcome.threadOps).toEqual([]);
      expect(outcome.setupOps).toEqual([]);
      expect(outcome.rejected).toEqual([]);
      // Nothing logged (no truncation, no failure)
      expect(diag.infos).toEqual([]);
      expect(diag.warns).toEqual([]);
    });

    it("returns an empty outcome without calling the port when events are empty", async () => {
      const consolidate = vi.fn();
      const consolidator = makeConsolidator({ consolidate });

      const outcome = await consolidator.consolidate([], emptyState(), "", []);

      expect(outcome.result).toBeNull();
      expect(outcome.episode).toBeNull();
      expect(outcome.rejected).toEqual([]);
      expect(consolidate).not.toHaveBeenCalled();
    });
  });
});
