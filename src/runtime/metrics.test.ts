/**
 * Tests for the Metrics class in src/runtime/metrics.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Metrics } from "./metrics.js";

import type { MetricsSnapshot } from "./metrics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshMetrics(): Metrics {
  return new Metrics();
}

// ---------------------------------------------------------------------------
// Recording LLM requests
// ---------------------------------------------------------------------------

describe("Metrics LLM request recording", () => {
  let m: Metrics;

  beforeEach(() => {
    m = freshMetrics();
  });

  it("should increment opening request counter", () => {
    m.recordLLMRequest("opening", { input: 100, output: 200 }, 1500);
    const snap = m.snapshot();
    expect(snap.llm.requests.opening).toBe(1);
    expect(snap.llm.requests.branch_prefetch).toBe(0);
    expect(snap.llm.requests.continuation).toBe(0);
  });

  it("should increment branch_prefetch request counter", () => {
    m.recordLLMRequest("branch_prefetch", { input: 50, output: 80 }, 900);
    const snap = m.snapshot();
    expect(snap.llm.requests.branch_prefetch).toBe(1);
  });

  it("should increment continuation request counter", () => {
    m.recordLLMRequest("continuation", { input: 300, output: 500 }, 2000);
    const snap = m.snapshot();
    expect(snap.llm.requests.continuation).toBe(1);
  });

  it("should increment autocomplete request counter", () => {
    m.recordLLMRequest("autocomplete", { input: 20, output: 10 }, 200);
    const snap = m.snapshot();
    expect(snap.llm.requests.autocomplete).toBe(1);
  });

  it("should increment speculative request counter", () => {
    m.recordLLMRequest("speculative", { input: 40, output: 60 }, 400);
    const snap = m.snapshot();
    expect(snap.llm.requests.speculative).toBe(1);
  });

  it("should correctly track multiple request types independently", () => {
    m.recordLLMRequest("opening", { input: 10, output: 20 }, 100);
    m.recordLLMRequest("opening", { input: 10, output: 20 }, 100);
    m.recordLLMRequest("branch_prefetch", { input: 5, output: 8 }, 50);
    m.recordLLMRequest("continuation", { input: 30, output: 50 }, 300);

    const snap = m.snapshot();
    expect(snap.llm.requests.opening).toBe(2);
    expect(snap.llm.requests.branch_prefetch).toBe(1);
    expect(snap.llm.requests.continuation).toBe(1);
    expect(snap.llm.requests.autocomplete).toBe(0);
    expect(snap.llm.requests.speculative).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Token accumulation
// ---------------------------------------------------------------------------

describe("Metrics token accumulation", () => {
  let m: Metrics;

  beforeEach(() => {
    m = freshMetrics();
  });

  it("should start with zero tokens", () => {
    const snap = m.snapshot();
    expect(snap.llm.tokens.input).toBe(0);
    expect(snap.llm.tokens.output).toBe(0);
  });

  it("should accumulate input and output tokens", () => {
    m.recordLLMRequest("opening", { input: 100, output: 200 }, 1000);
    m.recordLLMRequest("continuation", { input: 300, output: 500 }, 2000);

    const snap = m.snapshot();
    expect(snap.llm.tokens.input).toBe(400);
    expect(snap.llm.tokens.output).toBe(700);
  });

  it("should handle zero-token requests", () => {
    m.recordLLMRequest("opening", { input: 0, output: 0 }, 500);
    const snap = m.snapshot();
    expect(snap.llm.tokens.input).toBe(0);
    expect(snap.llm.tokens.output).toBe(0);
  });

  it("should accumulate tokens across all request types", () => {
    m.recordLLMRequest("opening", { input: 10, output: 20 }, 100);
    m.recordLLMRequest("branch_prefetch", { input: 5, output: 8 }, 100);
    m.recordLLMRequest("continuation", { input: 30, output: 50 }, 100);
    m.recordLLMRequest("autocomplete", { input: 2, output: 1 }, 100);
    m.recordLLMRequest("speculative", { input: 3, output: 4 }, 100);

    const snap = m.snapshot();
    expect(snap.llm.tokens.input).toBe(50);
    expect(snap.llm.tokens.output).toBe(83);
  });
});

// ---------------------------------------------------------------------------
// P50 / P95 / Max computation
// ---------------------------------------------------------------------------

describe("Metrics latency percentiles", () => {
  let m: Metrics;

  beforeEach(() => {
    m = freshMetrics();
  });

  it("should return 0 for all stats with zero samples", () => {
    const snap = m.snapshot();
    expect(snap.llm.latency_ms.p50).toBe(0);
    expect(snap.llm.latency_ms.p95).toBe(0);
    expect(snap.llm.latency_ms.max).toBe(0);
    expect(snap.llm.latency_ms.samples).toBe(0);
  });

  it("should return the single value for p50, p95, and max with one sample", () => {
    m.recordLLMRequest("opening", { input: 10, output: 10 }, 1200);
    const snap = m.snapshot();
    expect(snap.llm.latency_ms.p50).toBe(1200);
    expect(snap.llm.latency_ms.p95).toBe(1200);
    expect(snap.llm.latency_ms.max).toBe(1200);
    expect(snap.llm.latency_ms.samples).toBe(1);
  });

  it("should compute correct median with an odd number of samples", () => {
    const latencies = [300, 100, 500, 200, 400];
    for (const lat of latencies) {
      m.recordLLMRequest("opening", { input: 1, output: 1 }, lat);
    }

    const snap = m.snapshot();
    // Sorted: [100, 200, 300, 400, 500]; p50 is the middle value = 300
    expect(snap.llm.latency_ms.p50).toBe(300);
    expect(snap.llm.latency_ms.max).toBe(500);
    expect(snap.llm.latency_ms.samples).toBe(5);
  });

  it("should compute correct median with an even number of samples", () => {
    const latencies = [400, 200, 600, 100];
    for (const lat of latencies) {
      m.recordLLMRequest("continuation", { input: 1, output: 1 }, lat);
    }

    const snap = m.snapshot();
    // Sorted: [100, 200, 400, 600]; p50 = linear interp at index 1.5
    // floor=1 (200), ceil=2 (400), fraction=0.5 → 200*0.5 + 400*0.5 = 300
    expect(snap.llm.latency_ms.p50).toBe(300);
    expect(snap.llm.latency_ms.max).toBe(600);
    expect(snap.llm.latency_ms.samples).toBe(4);
  });

  it("should compute p95 with a 20-sample set", () => {
    // 20 values: 50, 100, 150, ..., 1000
    for (let i = 1; i <= 20; i++) {
      m.recordLLMRequest("opening", { input: 0, output: 0 }, i * 50);
    }

    const snap = m.snapshot();
    // Sorted: [50, 100, ..., 1000]
    // p95 at index 0.95 * 19 = 18.05
    // floor=18 → value 950, ceil=19 → value 1000
    // fraction=0.05 → 950*0.95 + 1000*0.05 = 902.5 + 50 = 952.5
    expect(snap.llm.latency_ms.p95).toBeCloseTo(952.5, 1);
    expect(snap.llm.latency_ms.samples).toBe(20);
  });

  it("should correctly sort jumbled latencies", () => {
    const latencies = [1000, 100, 500, 800, 200, 600];
    for (const lat of latencies) {
      m.recordLLMRequest("branch_prefetch", { input: 1, output: 1 }, lat);
    }

    const snap = m.snapshot();
    // Sorted: [100, 200, 500, 600, 800, 1000]
    // p50 at 0.5 * 5 = 2.5 → floor=2 (500), ceil=3 (600) → 550
    expect(snap.llm.latency_ms.p50).toBe(550);
    // p95 at 0.95 * 5 = 4.75 → floor=4 (800), ceil=5 (1000) → 800*0.25+1000*0.75 = 950
    expect(snap.llm.latency_ms.p95).toBeCloseTo(950, 1);
    expect(snap.llm.latency_ms.max).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Autocomplete acceptance rate
// ---------------------------------------------------------------------------

describe("Metrics autocomplete tracking", () => {
  let m: Metrics;

  beforeEach(() => {
    m = freshMetrics();
  });

  it("should start with zero rate", () => {
    const snap = m.snapshot();
    expect(snap.autocomplete.accepted).toBe(0);
    expect(snap.autocomplete.ignored).toBe(0);
    expect(snap.autocomplete.acceptance_rate).toBe(0);
  });

  it("should compute 100% acceptance rate", () => {
    m.recordAutocompleteAccept();
    m.recordAutocompleteAccept();
    const snap = m.snapshot();
    expect(snap.autocomplete.accepted).toBe(2);
    expect(snap.autocomplete.ignored).toBe(0);
    expect(snap.autocomplete.acceptance_rate).toBe(1);
  });

  it("should compute 0% acceptance rate", () => {
    m.recordAutocompleteIgnore();
    m.recordAutocompleteIgnore();
    m.recordAutocompleteIgnore();
    const snap = m.snapshot();
    expect(snap.autocomplete.accepted).toBe(0);
    expect(snap.autocomplete.ignored).toBe(3);
    expect(snap.autocomplete.acceptance_rate).toBe(0);
  });

  it("should compute mixed acceptance rate", () => {
    m.recordAutocompleteAccept();
    m.recordAutocompleteAccept();
    m.recordAutocompleteAccept();
    m.recordAutocompleteIgnore();
    const snap = m.snapshot();
    expect(snap.autocomplete.accepted).toBe(3);
    expect(snap.autocomplete.ignored).toBe(1);
    expect(snap.autocomplete.acceptance_rate).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// Prefetch hit rate
// ---------------------------------------------------------------------------

describe("Metrics prefetch tracking", () => {
  let m: Metrics;

  beforeEach(() => {
    m = freshMetrics();
  });

  it("should start with zero prefetch stats", () => {
    const snap = m.snapshot();
    expect(snap.prefetch.branches_requested).toBe(0);
    expect(snap.prefetch.branches_hit).toBe(0);
    expect(snap.prefetch.branches_missed).toBe(0);
    expect(snap.prefetch.hit_rate).toBe(0);
  });

  it("should track branch requests", () => {
    m.recordBranchRequested(3);
    const snap = m.snapshot();
    expect(snap.prefetch.branches_requested).toBe(3);
  });

  it("should track hits without affecting requested count", () => {
    m.recordBranchRequested(3);
    m.recordPrefetchHit();
    const snap = m.snapshot();
    expect(snap.prefetch.branches_requested).toBe(3);
    expect(snap.prefetch.branches_hit).toBe(1);
  });

  it("should compute 100% hit rate", () => {
    m.recordBranchRequested(3);
    m.recordPrefetchHit();
    m.recordPrefetchMiss();
    m.recordPrefetchMiss();
    // 1 hit, 2 misses, hit_rate = 1/3
    const snap = m.snapshot();
    expect(snap.prefetch.hit_rate).toBeCloseTo(1 / 3, 5);
  });

  it("should compute 0% hit rate when all miss", () => {
    m.recordBranchRequested(2);
    m.recordPrefetchMiss();
    m.recordPrefetchMiss();
    const snap = m.snapshot();
    expect(snap.prefetch.hit_rate).toBe(0);
  });

  it("should track multiple branch request calls", () => {
    m.recordBranchRequested(3);
    m.recordBranchRequested(2);
    const snap = m.snapshot();
    expect(snap.prefetch.branches_requested).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Snapshot immutability
// ---------------------------------------------------------------------------

describe("Metrics snapshot immutability", () => {
  let m: Metrics;

  beforeEach(() => {
    m = freshMetrics();
    m.recordLLMRequest("opening", { input: 100, output: 200 }, 1500);
    m.recordAutocompleteAccept();
    m.recordBranchRequested(3);
  });

  it("should not mutate internal counters when snapshot is modified", () => {
    const snap1 = m.snapshot();

    // Mutate the snapshot
    snap1.llm.requests.opening = 999;
    snap1.llm.tokens.input = 999;
    snap1.autocomplete.accepted = 999;

    const snap2 = m.snapshot();
    expect(snap2.llm.requests.opening).toBe(1);
    expect(snap2.llm.tokens.input).toBe(100);
    expect(snap2.autocomplete.accepted).toBe(1);
  });

  it("should not share array references in player timing", () => {
    m.recordChoiceToNextLine(100);
    m.recordChoiceToNextLine(200);

    const snap1 = m.snapshot();
    snap1.player.choice_to_next_line_ms.push(9999);

    const snap2 = m.snapshot();
    expect(snap2.player.choice_to_next_line_ms).toHaveLength(2);
    expect(snap2.player.choice_to_next_line_ms).toEqual([100, 200]);
  });

  it("should produce independent snapshots over time", () => {
    const snapBefore = m.snapshot();
    expect(snapBefore.llm.requests.opening).toBe(1);

    m.recordLLMRequest("continuation", { input: 50, output: 80 }, 700);

    const snapAfter = m.snapshot();
    expect(snapAfter.llm.requests.opening).toBe(1);
    expect(snapAfter.llm.requests.continuation).toBe(1);

    // snapBefore should still be frozen at time of capture
    expect(snapBefore.llm.requests.continuation).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Waste tracking
// ---------------------------------------------------------------------------

describe("Metrics waste tracking", () => {
  let m: Metrics;

  beforeEach(() => {
    m = freshMetrics();
  });

  it("should accumulate text waste bytes", () => {
    m.recordTextWaste(1024);
    m.recordTextWaste(2048);
    const snap = m.snapshot();
    expect(snap.waste.text_bytes).toBe(3072);
  });

  it("should accumulate audio waste count", () => {
    m.recordAudioWaste(1);
    m.recordAudioWaste(3);
    const snap = m.snapshot();
    expect(snap.waste.audio_files).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Input preview dwell timing
// ---------------------------------------------------------------------------

describe("Metrics input preview tracking", () => {
  let m: Metrics;

  beforeEach(() => {
    m = freshMetrics();
  });

  it("should compute average dwell time", () => {
    m.recordInputPreview(500);
    m.recordInputPreview(1500);
    const snap = m.snapshot();
    expect(snap.input.preview_count).toBe(2);
    expect(snap.input.avg_dwell_ms).toBe(1000);
  });

  it("should return zero avg dwell with no samples", () => {
    const snap = m.snapshot();
    expect(snap.input.preview_count).toBe(0);
    expect(snap.input.avg_dwell_ms).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error counters
// ---------------------------------------------------------------------------

describe("Metrics error tracking", () => {
  let m: Metrics;

  beforeEach(() => {
    m = freshMetrics();
  });

  it("should track schema validation failures", () => {
    m.recordSchemaValidationFailure();
    m.recordSchemaValidationFailure();
    const snap = m.snapshot();
    expect(snap.errors.schema_validation_failures).toBe(2);
  });

  it("should track state patch rejections", () => {
    m.recordStatePatchRejection();
    const snap = m.snapshot();
    expect(snap.errors.state_patch_rejections).toBe(1);
  });

  it("should track both error types independently", () => {
    m.recordSchemaValidationFailure();
    m.recordSchemaValidationFailure();
    m.recordStatePatchRejection();
    const snap = m.snapshot();
    expect(snap.errors.schema_validation_failures).toBe(2);
    expect(snap.errors.state_patch_rejections).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Player timing
// ---------------------------------------------------------------------------

describe("Metrics player timing", () => {
  let m: Metrics;

  beforeEach(() => {
    m = freshMetrics();
  });

  it("should record choice-to-next-line samples", () => {
    m.recordChoiceToNextLine(500);
    m.recordChoiceToNextLine(1200);
    const snap = m.snapshot();
    expect(snap.player.choice_to_next_line_ms).toEqual([500, 1200]);
  });

  it("should start empty", () => {
    const snap = m.snapshot();
    expect(snap.player.choice_to_next_line_ms).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("Metrics reset", () => {
  it("should clear all counters to zero / empty", () => {
    const m = freshMetrics();
    m.recordLLMRequest("opening", { input: 100, output: 200 }, 1000);
    m.recordAutocompleteAccept();
    m.recordAutocompleteIgnore();
    m.recordBranchRequested(4);
    m.recordPrefetchHit();
    m.recordPrefetchMiss();
    m.recordTextWaste(500);
    m.recordAudioWaste(2);
    m.recordInputPreview(300);
    m.recordSchemaValidationFailure();
    m.recordStatePatchRejection();
    m.recordChoiceToNextLine(800);

    // Verify data was recorded
    const before = m.snapshot();
    expect(before.llm.requests.opening).toBe(1);
    expect(before.llm.tokens.input).toBe(100);

    m.reset();

    const after = m.snapshot();
    expect(after.llm.requests.opening).toBe(0);
    expect(after.llm.requests.branch_prefetch).toBe(0);
    expect(after.llm.requests.continuation).toBe(0);
    expect(after.llm.requests.autocomplete).toBe(0);
    expect(after.llm.requests.speculative).toBe(0);
    expect(after.llm.tokens.input).toBe(0);
    expect(after.llm.tokens.output).toBe(0);
    expect(after.llm.latency_ms.samples).toBe(0);
    expect(after.llm.latency_ms.p50).toBe(0);
    expect(after.autocomplete.accepted).toBe(0);
    expect(after.autocomplete.ignored).toBe(0);
    expect(after.autocomplete.acceptance_rate).toBe(0);
    expect(after.prefetch.branches_requested).toBe(0);
    expect(after.prefetch.branches_hit).toBe(0);
    expect(after.prefetch.branches_missed).toBe(0);
    expect(after.prefetch.hit_rate).toBe(0);
    expect(after.waste.text_bytes).toBe(0);
    expect(after.waste.audio_files).toBe(0);
    expect(after.input.preview_count).toBe(0);
    expect(after.input.avg_dwell_ms).toBe(0);
    expect(after.errors.schema_validation_failures).toBe(0);
    expect(after.errors.state_patch_rejections).toBe(0);
    expect(after.player.choice_to_next_line_ms).toEqual([]);
  });
});
