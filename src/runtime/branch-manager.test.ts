/**
 * Tests for the BranchManager in src/runtime/branch-manager.ts.
 *
 * BranchManager wraps BranchPrefetchGroup and tracks BranchCandidate
 * lifecycle objects.  These tests verify candidate management, status
 * transitions, metric recording, and delegate-to-prefetch behaviour.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { BranchManager } from "./branch-manager.js";
import { Metrics } from "./metrics.js";
import { RuntimeStatus } from "../status.js";
import type { BranchCandidate, BranchStatus, GeneratedEvent } from "../story/types.js";
import type { ChoiceOption, RuntimePlayableEvent, ChoiceEvent } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshManager(metrics?: Metrics): BranchManager {
  return new BranchManager(metrics);
}

function freshMetrics(): Metrics {
  return new Metrics();
}

function makeChoiceEvent(options: ChoiceOption[]): ChoiceEvent {
  return {
    type: "choice",
    prompt: "请选择：",
    options,
  };
}

function makeOptions(count: number): ChoiceOption[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `opt_${i}`,
    text: `选项 ${i}`,
  }));
}

function makeDialogueEvent(speaker: string, text: string): GeneratedEvent {
  return { type: "dialogue", speaker, text };
}

function makeNarrationEvent(text: string): GeneratedEvent {
  return { type: "narration", text };
}

/** Create a RuntimeStatus with no-op emit (avoids listener-related errors). */
function freshStatus(): RuntimeStatus {
  return new RuntimeStatus();
}

/**
 * Create a BranchManager with a started prefetch group containing the
 * given options and a trivial generate that returns canned events.
 */
function managerWithPrefetch(
  options: ChoiceOption[],
  events: RuntimePlayableEvent[] = [],
  metrics?: Metrics,
): BranchManager {
  const manager = freshManager(metrics);
  for (const opt of options) {
    manager.createCandidate(opt.id, "test_interaction", "choice");
  }

  manager.startPrefetch({
    choice: makeChoiceEvent(options),
    concurrency: 3,
    status: freshStatus(),
    generate: async (_option, _signal) => events,
  });

  return manager;
}

// ---------------------------------------------------------------------------
// createCandidate
// ---------------------------------------------------------------------------

describe("BranchManager createCandidate", () => {
  let manager: BranchManager;

  beforeEach(() => {
    manager = freshManager();
  });

  it("should create a candidate with queued status", () => {
    const candidate = manager.createCandidate("br1", "int_1", "choice");
    expect(candidate.id).toBe("br1");
    expect(candidate.interaction_id).toBe("int_1");
    expect(candidate.source).toBe("choice");
    expect(candidate.status).toBe("queued");
    expect(candidate.events).toEqual([]);
  });

  it("should store candidates in the internal map", () => {
    manager.createCandidate("br1", "int_1", "choice");
    manager.createCandidate("br2", "int_1", "choice");

    const retrieved = manager.getCandidate("br1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("br1");
    expect(retrieved!.source).toBe("choice");

    const retrieved2 = manager.getCandidate("br2");
    expect(retrieved2!.source).toBe("choice");
  });

  it("should return undefined for unknown candidates", () => {
    expect(manager.getCandidate("no_such_id")).toBeUndefined();
  });

  it("should list all candidates via getCandidates", () => {
    manager.createCandidate("a", "i1", "choice");
    manager.createCandidate("b", "i1", "choice");
    manager.createCandidate("c", "i2", "input_preview");

    const all = manager.getCandidates();
    expect(all).toHaveLength(3);
    const ids = all.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// updateCandidateStatus
// ---------------------------------------------------------------------------

describe("BranchManager updateCandidateStatus", () => {
  let manager: BranchManager;

  beforeEach(() => {
    manager = freshManager();
    manager.createCandidate("br1", "int_1", "choice");
  });

  it("should update status from queued to generating", () => {
    manager.updateCandidateStatus("br1", "generating");
    expect(manager.getCandidate("br1")!.status).toBe("generating");
  });

  it("should attach events when provided", () => {
    const events: GeneratedEvent[] = [
      makeDialogueEvent("Alice", "Hello"),
      makeNarrationEvent("The door creaks open."),
    ];
    manager.updateCandidateStatus("br1", "ready", events);
    const candidate = manager.getCandidate("br1")!;
    expect(candidate.status).toBe("ready");
    expect(candidate.events).toEqual(events);
  });

  it("should attach state_patch when provided", () => {
    const patch = {
      scene: { id: "new_scene", location: "hallway", purpose: "explore" },
    };
    manager.updateCandidateStatus("br1", "ready", undefined, patch);
    const candidate = manager.getCandidate("br1")!;
    expect(candidate.state_patch).toEqual(patch);
  });

  it("should be a no-op for unknown candidate IDs", () => {
    expect(() =>
      manager.updateCandidateStatus("no_such", "ready"),
    ).not.toThrow();
  });

  it("should preserve existing events when not provided in update", () => {
    const events: GeneratedEvent[] = [makeDialogueEvent("Bob", "Hi")];
    manager.updateCandidateStatus("br1", "ready", events);
    manager.updateCandidateStatus("br1", "selected");
    expect(manager.getCandidate("br1")!.events).toEqual(events);
  });

  it("should support all lifecycle statuses", () => {
    const statuses: BranchStatus[] = [
      "queued",
      "generating",
      "ready",
      "selected",
      "discarded",
      "failed",
    ];
    for (const status of statuses) {
      manager.updateCandidateStatus("br1", status);
      expect(manager.getCandidate("br1")!.status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// discardCandidate
// ---------------------------------------------------------------------------

describe("BranchManager discardCandidate", () => {
  let manager: BranchManager;

  beforeEach(() => {
    manager = freshManager();
    manager.createCandidate("br1", "int_1", "choice");
    manager.createCandidate("br2", "int_1", "choice");
  });

  it("should mark a single candidate as discarded", () => {
    manager.discardCandidate("br1");
    expect(manager.getCandidate("br1")!.status).toBe("discarded");
    expect(manager.getCandidate("br2")!.status).toBe("queued");
  });

  it("should be a no-op for non-existent candidates", () => {
    expect(() => manager.discardCandidate("ghost")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// discardAll
// ---------------------------------------------------------------------------

describe("BranchManager discardAll", () => {
  it("should discard all non-selected, non-failed candidates", () => {
    const manager = freshManager();
    manager.createCandidate("a", "int_1", "choice");
    manager.createCandidate("b", "int_1", "choice");
    manager.createCandidate("c", "int_1", "choice");
    manager.updateCandidateStatus("a", "selected");
    manager.updateCandidateStatus("b", "failed");

    // Snapshot before discardAll clears the map
    const candidateA = manager.getCandidate("a");
    const candidateB = manager.getCandidate("b");
    const candidateC = manager.getCandidate("c");

    manager.discardAll();

    // Selected and failed candidates are preserved in the snapshot
    expect(candidateA!.status).toBe("selected");
    expect(candidateB!.status).toBe("failed");
    expect(candidateC!.status).toBe("discarded");
    // Map is cleared after discardAll
    expect(manager.getCandidates()).toHaveLength(0);
  });

  it("should not throw when no prefetch group is active", () => {
    const manager = freshManager();
    manager.createCandidate("a", "int_1", "choice");
    expect(() => manager.discardAll()).not.toThrow();
    expect(manager.getCandidates()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isActive
// ---------------------------------------------------------------------------

describe("BranchManager isActive", () => {
  it("should return false before startPrefetch is called", () => {
    const manager = freshManager();
    expect(manager.isActive()).toBe(false);
  });

  it("should return true after startPrefetch is called", () => {
    const manager = managerWithPrefetch(makeOptions(2));
    expect(manager.isActive()).toBe(true);
  });

  it("should return false after discardAll", () => {
    const manager = managerWithPrefetch(makeOptions(2));
    manager.discardAll();
    expect(manager.isActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectCandidate
// ---------------------------------------------------------------------------

describe("BranchManager selectCandidate", () => {
  it("should throw when no prefetch group is active", async () => {
    const manager = freshManager();
    manager.createCandidate("br1", "int_1", "choice");
    await expect(manager.selectCandidate("br1")).rejects.toThrow(
      "No active prefetch group",
    );
  });

  it("should return events and mark candidate as selected", async () => {
    const events: RuntimePlayableEvent[] = [
      { type: "narration", text: "The sun rises.", line_id: "l1" },
    ];
    const manager = managerWithPrefetch(makeOptions(2), events);

    const result = await manager.selectCandidate("opt_0");
    expect(result).toEqual(events);
    expect(manager.getCandidate("opt_0")!.status).toBe("selected");
  });

  it("should mark candidate as failed when underlying prefetch fails", async () => {
    const manager = freshManager();
    manager.createCandidate("opt_0", "test", "choice");
    manager.createCandidate("opt_1", "test", "choice");

    manager.startPrefetch({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 1,
      status: freshStatus(),
      generate: async (_option, _signal) => {
        throw new Error("LLM timeout");
      },
    });

    await expect(manager.selectCandidate("opt_0")).rejects.toThrow("LLM timeout");
    expect(manager.getCandidate("opt_0")!.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Metrics integration
// ---------------------------------------------------------------------------

describe("BranchManager metrics integration", () => {
  let metrics: Metrics;

  beforeEach(() => {
    metrics = freshMetrics();
  });

  it("should record branch requests when startPrefetch is called", () => {
    const manager = freshManager(metrics);
    manager.createCandidate("a", "int_1", "choice");
    manager.createCandidate("b", "int_1", "choice");
    manager.createCandidate("c", "int_1", "choice");

    manager.startPrefetch({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 2,
      status: freshStatus(),
      generate: async () => [],
    });

    const snap = metrics.snapshot();
    expect(snap.prefetch.branches_requested).toBe(3);
  });

  it("should record prefetch hit when selectCandidate succeeds", async () => {
    const events: RuntimePlayableEvent[] = [
      { type: "dialogue", speaker: "NPC", text: "Welcome!", line_id: "l1" },
    ];
    const manager = managerWithPrefetch(makeOptions(2), events, metrics);

    await manager.selectCandidate("opt_1");

    const snap = metrics.snapshot();
    expect(snap.prefetch.branches_hit).toBe(1);
    expect(snap.prefetch.branches_missed).toBe(0);
  });

  it("should record prefetch miss when selectCandidate throws", async () => {
    const manager = freshManager(metrics);
    manager.createCandidate("opt_0", "test", "choice");

    manager.startPrefetch({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: freshStatus(),
      generate: async () => {
        throw new Error("generation failed");
      },
    });

    await expect(manager.selectCandidate("opt_0")).rejects.toThrow();

    const snap = metrics.snapshot();
    expect(snap.prefetch.branches_missed).toBe(1);
    expect(snap.prefetch.branches_hit).toBe(0);
  });

  it("should work without a Metrics instance (optional dependency)", async () => {
    const manager = freshManager(); // no metrics
    const options = makeOptions(1);
    manager.createCandidate(options[0]!.id, "int_1", "choice");
    manager.startPrefetch({
      choice: makeChoiceEvent(options),
      concurrency: 1,
      status: freshStatus(),
      generate: async () => [],
    });

    // Should not throw
    const events = await manager.selectCandidate(options[0]!.id);
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// onReady callback integration
// ---------------------------------------------------------------------------

describe("BranchManager onReady lifecycle", () => {
  it("should mark candidates as ready when prefetch completes", async () => {
    const events: RuntimePlayableEvent[] = [
      { type: "narration", text: "It was a dark night.", line_id: "l1" },
    ];

    // Use a deferred pattern to capture whether onReady was called
    let readyOptionId: string | null = null;

    const manager = freshManager();
    manager.createCandidate("opt_0", "int_1", "choice");

    manager.startPrefetch({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: freshStatus(),
      generate: async () => events,
      onReady: (option, _evts) => {
        readyOptionId = option.id;
      },
    });

    // Wait for the prefetch to settle
    await vi.waitFor(
      () => {
        const candidate = manager.getCandidate("opt_0");
        return candidate?.status === "ready";
      },
      { timeout: 2000 },
    );

    const candidate = manager.getCandidate("opt_0");
    expect(candidate!.status).toBe("ready");
    expect(candidate!.events).toEqual(events);
    expect(readyOptionId).toBe("opt_0");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("BranchManager edge cases", () => {
  it("should handle empty option list gracefully in startPrefetch", () => {
    const manager = freshManager();
    manager.startPrefetch({
      choice: makeChoiceEvent([]),
      concurrency: 1,
      status: freshStatus(),
      generate: async () => [],
    });
    expect(manager.isActive()).toBe(true);
    expect(manager.getCandidates()).toHaveLength(0);
  });

  it("should not double-count metrics with repeated startPrefetch", () => {
    const manager = freshManager();

    // First round
    manager.createCandidate("a", "i1", "choice");
    manager.createCandidate("b", "i1", "choice");
    manager.startPrefetch({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 1,
      status: freshStatus(),
      generate: async () => [],
    });

    // Second round (discard first)
    manager.discardAll();

    manager.createCandidate("c", "i2", "choice");
    manager.startPrefetch({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: freshStatus(),
      generate: async () => [],
    });

    expect(manager.getCandidates()).toHaveLength(1);
    expect(manager.getCandidate("c")!.status).toBe("queued");
  });

  it("should preserve interaction_id and source across candidate lifecycle", () => {
    const manager = freshManager();
    manager.createCandidate("br1", "interaction_42", "choice");
    manager.updateCandidateStatus("br1", "generating");
    manager.updateCandidateStatus("br1", "ready", [makeDialogueEvent("X", "Y")]);

    const c = manager.getCandidate("br1")!;
    expect(c.interaction_id).toBe("interaction_42");
    expect(c.source).toBe("choice");
    expect(c.status).toBe("ready");
  });
});
