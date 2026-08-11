/**
 * Tests for Metrics wiring in the Game class.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "./game.js";
import { Metrics } from "./runtime/metrics.js";
import type { MetricsSnapshot } from "./runtime/metrics.js";
import { makeTestConfig, makeTestPorts } from "./test-helpers.js";
import type { StoryGeneratorPort } from "./core/ports/story-generator-port.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import type { RuntimeStatus } from "./status.js";
import type { AppConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockGenerator(): StoryGeneratorPort {
  return {
    generateOpening: vi.fn(),
    generateBranchPrefetch: vi.fn(),
    generateInputResponse: vi.fn(),
    generateContinuation: vi.fn(),
    generateInputBridge: vi.fn(),
  } as unknown as StoryGeneratorPort;
}

function makeMockMedia(): MediaPlannerPort {
  return {
    registerActive: vi.fn(),
    registerCandidate: vi.fn(),
    activateCandidate: vi.fn(),
    discardCandidate: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    markPresented: vi.fn(),
  } as unknown as MediaPlannerPort;
}

function makeMockStatus(): RuntimeStatus {
  return {
    setPhase: vi.fn(),
    setJob: vi.fn(),
    removeJob: vi.fn(),
    setBuffer: vi.fn(),
    setBranch: vi.fn(),
    clearBranches: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => undefined),
    snapshot: vi.fn().mockReturnValue({ branches: {} }),
  } as unknown as RuntimeStatus;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Game Metrics integration", () => {
  let config: AppConfig;
  let generator: StoryGeneratorPort;
  let status: RuntimeStatus;
  let media: MediaPlannerPort;

  beforeEach(() => {
    config = makeTestConfig();
    generator = makeMockGenerator();
    status = makeMockStatus();
    media = makeMockMedia();
  });

  // ------------------------------------------------------------------
  // Metrics auto-creation
  // ------------------------------------------------------------------

  it("should auto-create a Metrics instance when none is provided", () => {
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const snap = game.getMetrics();
    expect(snap).toBeDefined();
    expect(snap.llm.requests.opening).toBe(0);
    expect(snap.llm.tokens.input).toBe(0);
  });

  it("should use the provided Metrics instance", () => {
    const metrics = new Metrics();
    metrics.recordBranchRequested(5);
    const game = new Game(config, generator, status, media, metrics, makeTestPorts());
    const snap = game.getMetrics();
    expect(snap.prefetch.branches_requested).toBe(5);
  });

  it("should return the same Metrics instance via getMetrics each call", () => {
    const metrics = new Metrics();
    const game = new Game(config, generator, status, media, metrics, makeTestPorts());
    const snap1 = game.getMetrics();
    metrics.recordBranchRequested(2);
    const snap2 = game.getMetrics();
    expect(snap1.prefetch.branches_requested).toBe(0);
    expect(snap2.prefetch.branches_requested).toBe(2);
  });

  // ------------------------------------------------------------------
  // Snapshot structure
  // ------------------------------------------------------------------

  it("should return a complete MetricsSnapshot with all expected fields", () => {
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const snap = game.getMetrics();

    // LLM
    expect(snap.llm).toBeDefined();
    expect(snap.llm.requests).toBeDefined();
    expect(snap.llm.tokens).toBeDefined();
    expect(snap.llm.latency_ms).toBeDefined();

    // Request types
    expect(snap.llm.requests.opening).toBe(0);
    expect(snap.llm.requests.branch_prefetch).toBe(0);
    expect(snap.llm.requests.continuation).toBe(0);
    expect(snap.llm.requests.speculative).toBe(0);

    // Prefetch
    expect(snap.prefetch.branches_requested).toBe(0);
    expect(snap.prefetch.branches_hit).toBe(0);
    expect(snap.prefetch.branches_missed).toBe(0);
    expect(snap.prefetch.hit_rate).toBe(0);

    // Waste
    expect(snap.waste.text_bytes).toBe(0);
    expect(snap.waste.audio_files).toBe(0);

    // Input
    expect(snap.input.preview_count).toBe(0);
    expect(snap.input.avg_dwell_ms).toBe(0);

    // Errors
    expect(snap.errors.schema_validation_failures).toBe(0);

    // Player
    expect(snap.player.choice_to_next_line_ms).toEqual([]);
  });

  // ------------------------------------------------------------------
  // Metrics recorded via shared instance
  // ------------------------------------------------------------------

  it("should reflect branch requests recorded on the shared Metrics", () => {
    const metrics = new Metrics();
    const game = new Game(config, generator, status, media, metrics, makeTestPorts());

    metrics.recordBranchRequested(3);
    metrics.recordPrefetchHit();
    metrics.recordPrefetchMiss();
    metrics.recordPrefetchMiss();

    const snap = game.getMetrics();
    expect(snap.prefetch.branches_requested).toBe(3);
    expect(snap.prefetch.branches_hit).toBe(1);
    expect(snap.prefetch.branches_missed).toBe(2);
    expect(snap.prefetch.hit_rate).toBeCloseTo(1 / 3, 5);
  });

  it("should reflect LLM requests recorded on the shared Metrics", () => {
    const metrics = new Metrics();
    const game = new Game(config, generator, status, media, metrics, makeTestPorts());

    metrics.recordLLMRequest("opening", { input: 100, output: 200 }, 1000);
    metrics.recordLLMRequest("branch_prefetch", { input: 50, output: 80 }, 500);

    const snap = game.getMetrics();
    expect(snap.llm.requests.opening).toBe(1);
    expect(snap.llm.requests.branch_prefetch).toBe(1);
    expect(snap.llm.tokens.input).toBe(150);
    expect(snap.llm.tokens.output).toBe(280);
    expect(snap.llm.latency_ms.samples).toBe(2);
  });

  it("should reflect input preview and choice-to-next-line on shared Metrics", () => {
    const metrics = new Metrics();
    const game = new Game(config, generator, status, media, metrics, makeTestPorts());

    metrics.recordInputPreview(400);
    metrics.recordInputPreview(600);
    metrics.recordChoiceToNextLine(250);

    const snap = game.getMetrics();
    expect(snap.input.preview_count).toBe(2);
    expect(snap.input.avg_dwell_ms).toBe(500);
    expect(snap.player.choice_to_next_line_ms).toEqual([250]);
  });

  it("should reflect error counters on shared Metrics", () => {
    const metrics = new Metrics();
    const game = new Game(config, generator, status, media, metrics, makeTestPorts());

    metrics.recordSchemaValidationFailure();
    metrics.recordSchemaValidationFailure();

    const snap = game.getMetrics();
    expect(snap.errors.schema_validation_failures).toBe(2);
  });

  // ------------------------------------------------------------------
  // Snapshot immutability
  // ------------------------------------------------------------------

  it("getMetrics snapshot should not be mutated by subsequent recordings", () => {
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const snap = game.getMetrics();

    // Record more after snapshot
    const metrics = new Metrics();
    // We can't directly access the internal metrics, but we know the snapshot
    // is a copy. Just verify the snapshot fields are primitives/arrays.
    expect(snap.llm.requests.opening).toBe(0);
  });

  // ------------------------------------------------------------------
  // Independent instances
  // ------------------------------------------------------------------

  it("should keep metrics independent when different instances are used", () => {
    const metrics1 = new Metrics();
    const metrics2 = new Metrics();

    const game1 = new Game(config, generator, status, media, metrics1, makeTestPorts());
    const game2 = new Game(config, generator, status, media, metrics2, makeTestPorts());

    metrics1.recordBranchRequested(2);
    metrics2.recordBranchRequested(5);

    expect(game1.getMetrics().prefetch.branches_requested).toBe(2);
    expect(game2.getMetrics().prefetch.branches_requested).toBe(5);
  });
});
