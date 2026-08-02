/**
 * Tests for AudioIntentPlanner: active/candidate registration, branch
 * promotion + invalidation, cursor advancement, and the CLI readiness
 * queries.
 */
import { describe, it, expect } from "vitest";
import { AudioIntentPlanner } from "./audio-intent-planner.js";
import { AudioCatalogServiceImpl } from "./audio-catalog-service.js";
import type { AudioCatalogEvent } from "./audio-catalog-service.js";
import type { AudioDescriptorFactoryOptions } from "./audio-descriptor-factory.js";
import { AudioDescriptorFactory } from "./audio-descriptor-factory.js";
import {
  PerformanceCompilerImpl,
  type LinePerformance,
  type PerformanceCompiler,
} from "./performance-compiler.js";
import type { VoicesConfig } from "../../config/voices.js";
import type { RuntimePlayableEvent } from "../../schema.js";

const stubCompiler: PerformanceCompiler = {
  compile: () => ({ rate: 1, pitch: 1, volume: 1, pauseBeforeMs: 0, pauseAfterMs: 0 }),
};

const voices: VoicesConfig = {
  version: 2,
  profiles: {
    suyao_main: {
      semantic: { base_description: "温柔的少女声", allowed_delivery: [], forbidden_delivery: [] },
      providers: {
        dashscope: { model: "cosyvoice-v2", voice_id_env: "SUYAO_VOICE_ID", voice_revision: 1 },
      },
    },
  },
};

const characters: AudioDescriptorFactoryOptions["characters"] = {
  suyao: { name: "苏遥", voice_profile: "suyao_main" },
};

function makePlanner(
  overrides: Partial<{ candidatePrefetchLines: number; maxActiveFutureLines: number }> = {},
  compiler: PerformanceCompiler = stubCompiler,
) {
  const catalog = new AudioCatalogServiceImpl();
  const factory = new AudioDescriptorFactory({
    characters,
    voices,
    provider: "mock",
    modelProfile: "cosyvoice_v3_flash",
    sampleRate: 22050,
    format: "pcm_s16le",
    env: { MOCK_VOICE_suyao: "mock-voice" },
    compiler,
    seedFor: (lineId) => [...lineId].reduce((acc, char) => acc + char.charCodeAt(0), 0),
  });
  const planner = new AudioIntentPlanner({
    catalog,
    factory,
    candidatePrefetchLines: overrides.candidatePrefetchLines ?? 1,
    maxActiveFutureLines: overrides.maxActiveFutureLines ?? 4,
  });
  return { catalog, planner };
}

function dialogue(lineId: string): RuntimePlayableEvent {
  return { type: "dialogue", speaker: "suyao", text: `台词 ${lineId}`, line_id: lineId };
}

function dialogueWithPerformance(lineId: string, performance: LinePerformance): RuntimePlayableEvent {
  return { type: "dialogue", speaker: "suyao", text: `台词 ${lineId}`, line_id: lineId, performance };
}

describe("AudioIntentPlanner", () => {
  it("registerActive assigns current/next/active_future priorities", () => {
    const { catalog, planner } = makePlanner();
    planner.registerActive([dialogue("l1"), dialogue("l2"), dialogue("l3")]);

    expect(catalog.get("l1")?.priority).toBe("current");
    expect(catalog.get("l2")?.priority).toBe("next");
    expect(catalog.get("l3")?.priority).toBe("active_future");
    expect(catalog.get("l1")?.scope).toEqual({ type: "active" });
  });

  it("registerActive is idempotent for repeated lines", () => {
    const { catalog, planner } = makePlanner();
    planner.registerActive([dialogue("l1")]);
    planner.registerActive([dialogue("l1"), dialogue("l2")]);

    expect(catalog.get("l1")?.priority).toBe("current");
    expect(catalog.get("l2")?.priority).toBe("next");
  });

  it("registerActive emits descriptors only for newly added lines", () => {
    const { catalog, planner } = makePlanner();
    const events: AudioCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));
    planner.registerActive([dialogue("l1"), dialogue("l2")]);

    // Re-registering the same timeline must not re-emit prior descriptors.
    events.length = 0;
    planner.registerActive([dialogue("l1"), dialogue("l2"), dialogue("l3")]);

    const descriptorEvents = events.filter((event) => event.type === "descriptor");
    expect(descriptorEvents.map((event) => event.descriptor.lineId)).toEqual(["l3"]);
  });

  it("registerCandidate marks the first configured line candidate_first_line, rest background", () => {
    const { catalog, planner } = makePlanner();
    planner.registerCandidate("b1", [dialogue("c1"), dialogue("c2"), dialogue("c3")]);

    expect(catalog.get("c1")?.priority).toBe("candidate_first_line");
    expect(catalog.get("c1")?.scope).toEqual({ type: "candidate", branchId: "b1" });
    expect(catalog.get("c2")?.priority).toBe("background");
    expect(catalog.get("c3")?.priority).toBe("background");
  });

  it("registerCandidate respects candidatePrefetchLines", () => {
    const { catalog, planner } = makePlanner({ candidatePrefetchLines: 2 });
    planner.registerCandidate("b1", [dialogue("c1"), dialogue("c2"), dialogue("c3")]);

    expect(catalog.get("c1")?.priority).toBe("candidate_first_line");
    expect(catalog.get("c2")?.priority).toBe("candidate_first_line");
    expect(catalog.get("c3")?.priority).toBe("background");
  });

  it("activateCandidate promotes the branch and invalidates others", () => {
    const { catalog, planner } = makePlanner();
    const events: AudioCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));
    planner.registerCandidate("b1", [dialogue("c1"), dialogue("c2")]);
    planner.registerCandidate("b2", [dialogue("d1"), dialogue("d2")]);

    planner.activateCandidate("b1");

    // b2 lines are gone.
    expect(catalog.get("d1")).toBeUndefined();
    expect(catalog.get("d2")).toBeUndefined();
    // b1 lines promoted with active priorities.
    expect(catalog.get("c1")?.scope).toEqual({ type: "active" });
    expect(catalog.get("c1")?.priority).toBe("current");
    expect(catalog.get("c2")?.priority).toBe("next");
    // Invalidations were announced.
    const invalidations = events.filter((event) => event.type === "invalidated");
    expect(invalidations).toEqual([
      { type: "invalidated", lineId: "d1", reason: "branch_discarded" },
      { type: "invalidated", lineId: "d2", reason: "branch_discarded" },
    ]);
  });

  it("activateCandidate appends promoted lines after the existing timeline", () => {
    const { catalog, planner } = makePlanner();
    planner.registerActive([dialogue("l1")]);
    planner.registerCandidate("b1", [dialogue("c1")]);

    planner.activateCandidate("b1");

    expect(catalog.get("l1")?.priority).toBe("current");
    expect(catalog.get("c1")?.priority).toBe("next");
  });

  it("activateCandidate emits descriptors only for newly promoted lines", () => {
    const { catalog, planner } = makePlanner();
    const events: AudioCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));
    planner.registerActive([dialogue("l1")]);
    planner.registerCandidate("b1", [dialogue("c1")]);

    // Promoting b1 must not re-emit the already-registered l1 descriptor.
    events.length = 0;
    planner.activateCandidate("b1");

    const descriptorEvents = events.filter((event) => event.type === "descriptor");
    expect(descriptorEvents.map((event) => event.descriptor.lineId)).toEqual(["c1"]);
  });
  it("discardCandidate invalidates the branch lines", () => {
    const { catalog, planner } = makePlanner();
    const events: AudioCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));
    planner.registerCandidate("b1", [dialogue("c1")]);

    planner.discardCandidate("b1");

    expect(catalog.get("c1")).toBeUndefined();
    expect(events.filter((event) => event.type === "invalidated")).toEqual([
      { type: "invalidated", lineId: "c1", reason: "branch_discarded" },
    ]);
  });

  it("markPresented advances the cursor and re-prioritizes", () => {
    const { catalog, planner } = makePlanner();
    planner.registerActive([dialogue("l1"), dialogue("l2"), dialogue("l3")]);

    planner.markPresented("l1");

    expect(catalog.get("l2")?.priority).toBe("current");
    expect(catalog.get("l3")?.priority).toBe("next");
  });

  it("markPresented on an unknown line is a no-op", () => {
    const { catalog, planner } = makePlanner();
    planner.registerActive([dialogue("l1")]);

    expect(() => planner.markPresented("ghost")).not.toThrow();
    expect(catalog.get("l1")?.priority).toBe("current");
  });

  it("isReady and waitUntilReady always succeed (CLI compat)", async () => {
    const { planner } = makePlanner();
    expect(planner.isReady("anything")).toBe(true);
    await expect(planner.waitUntilReady("anything", 100)).resolves.toBe(true);
  });

  it("forwards event.performance so compiled params reach the recipe", () => {
    const { catalog, planner } = makePlanner({}, new PerformanceCompilerImpl());
    const event = dialogueWithPerformance("perf1", {
      emotion: "sad",
      pace: "slow",
      pause_before_ms: 600,
      pause_after_ms: 200,
    });

    planner.registerActive([event]);

    const recipe = catalog.getRecipe("perf1");
    expect(recipe).toBeDefined();
    expect(recipe!.rate).toBe(0.92); // slow pace → slower rate, not identity
    expect(recipe!.pauseBeforeMs).toBe(600);
    expect(recipe!.pauseAfterMs).toBe(200);
  });
});
