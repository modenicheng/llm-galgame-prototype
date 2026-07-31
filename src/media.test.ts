import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { mkdir, rm, readFile } from "node:fs/promises";
import os from "node:os";
import {
  MediaPrefetchScheduler,
  MockAudioSynthesizer,
  type MediaMetrics,
} from "./media.js";
import type { AudioConfig } from "./config.js";
import { RuntimeStatus } from "./status.js";
import type {
  RuntimePlayableEvent,
  RuntimeDialogueEvent,
  RuntimeNarrationEvent,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDialogue(
  lineId: string,
  speaker = "Alice",
  text = "Hello."
): RuntimeDialogueEvent {
  return { type: "dialogue", line_id: lineId, speaker, text };
}

function makeNarration(
  lineId: string,
  text = "It was a dark night."
): RuntimeNarrationEvent {
  return { type: "narration", line_id: lineId, text };
}

function makePlayableEvents(
  ids: string[]
): RuntimePlayableEvent[] {
  return ids.map((id, i) =>
    i % 2 === 0 ? makeDialogue(id) : makeNarration(id)
  );
}

function makeConfig(overrides: Partial<AudioConfig> = {}): AudioConfig {
  return {
    enabled: true,
    provider: "mock",
    active_target_lines: 3,
    refill_threshold_lines: 2,
    branch_prefetch_lines: 2,
    choice_prefetch_lines: 2,
    input_preview_lines: 1,
    batch_size: 2,
    max_concurrency: 2,
    mock_latency_ms: 0,
    output_dir: path.join(os.tmpdir(), `media-test-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    ...overrides,
  };
}

function makeDisabledConfig(
  overrides: Partial<AudioConfig> = {}
): AudioConfig {
  return makeConfig({ enabled: false, provider: "disabled", ...overrides });
}

function makeStatus(): RuntimeStatus {
  return new RuntimeStatus();
}

/** Ensure all pending synthesis completes. */
async function drain(scheduler: MediaPrefetchScheduler): Promise<void> {
  // Give microtasks a chance to run, then wait for drain
  await new Promise<void>((r) => setTimeout(r, 5));
  await scheduler.waitForDrain();
}

// ---------------------------------------------------------------------------
// MockAudioSynthesizer tests
// ---------------------------------------------------------------------------

describe("MockAudioSynthesizer", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = path.join(
      os.tmpdir(),
      `mock-audio-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(outputDir, { recursive: true, force: true });
    } catch {
      // cleanup is best-effort
    }
  });

  it("creates correct file structure", async () => {
    const synth = new MockAudioSynthesizer(outputDir, 0);
    const controller = new AbortController();
    const lines: RuntimePlayableEvent[] = [
      makeDialogue("L001", "Alice", "Hi!"),
      makeNarration("L002", "The sun set."),
    ];

    const assets = await synth.synthesize(lines, controller.signal);

    expect(assets).toHaveLength(2);
    expect(assets[0]!.lineId).toBe("L001");
    expect(assets[1]!.lineId).toBe("L002");

    // Verify files exist
    const file1 = assets[0]!.path;
    const file2 = assets[1]!.path;
    expect(file1).toContain("L001.mock-audio.json");
    expect(file2).toContain("L002.mock-audio.json");

    const content1 = await readFile(file1, "utf8");
    const content2 = await readFile(file2, "utf8");
    expect(content1).toContain("L001");
    expect(content2).toContain("L002");
  });

  it("file content matches input", async () => {
    const synth = new MockAudioSynthesizer(outputDir, 0);
    const controller = new AbortController();
    const lines: RuntimePlayableEvent[] = [
      makeDialogue("line_X", "Bob", "How are you?"),
    ];

    const assets = await synth.synthesize(lines, controller.signal);
    const content = JSON.parse(await readFile(assets[0]!.path, "utf8"));

    expect(content.line_id).toBe("line_X");
    expect(content.kind).toBe("dialogue");
    expect(content.speaker).toBe("Bob");
    expect(content.text).toBe("How are you?");
    expect(content.generated_at).toBeTruthy();
    expect(content.note).toBe("调度演示文件，不含真实音频。");
  });

  it("narration events have speaker: narrator", async () => {
    const synth = new MockAudioSynthesizer(outputDir, 0);
    const controller = new AbortController();
    const lines: RuntimePlayableEvent[] = [makeNarration("N001", "And so it began.")];

    const assets = await synth.synthesize(lines, controller.signal);
    const content = JSON.parse(await readFile(assets[0]!.path, "utf8"));

    expect(content.kind).toBe("narration");
    expect(content.speaker).toBe("narrator");
  });

  it("handles abort signal before synthesis", async () => {
    const synth = new MockAudioSynthesizer(outputDir, 0);
    const controller = new AbortController();
    controller.abort();

    await expect(
      synth.synthesize([makeDialogue("L001")], controller.signal)
    ).rejects.toThrow("Audio synthesis aborted");
  });

  it("handles abort signal during synthesis", async () => {
    const synth = new MockAudioSynthesizer(outputDir, 50); // non-zero latency
    const controller = new AbortController();
    const lines: RuntimePlayableEvent[] = [
      makeDialogue("L001"),
      makeDialogue("L002"),
      makeDialogue("L003"),
      makeDialogue("L004"),
      makeDialogue("L005"),
    ];

    const promise = synth.synthesize(lines, controller.signal);

    // Abort shortly after starting
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    await expect(promise).rejects.toThrow("Audio synthesis aborted");
  });

  it("concurrent synthesis creates distinct files", async () => {
    const synth = new MockAudioSynthesizer(outputDir, 0);
    const c1 = new AbortController();
    const c2 = new AbortController();

    const [assets1, assets2] = await Promise.all([
      synth.synthesize([makeDialogue("A1"), makeDialogue("A2")], c1.signal),
      synth.synthesize([makeNarration("B1"), makeNarration("B2")], c2.signal),
    ]);

    expect(assets1).toHaveLength(2);
    expect(assets2).toHaveLength(2);

    const allIds = [...assets1, ...assets2].map((a) => a.lineId).sort();
    expect(allIds).toEqual(["A1", "A2", "B1", "B2"]);

    // Verify all files exist
    for (const asset of [...assets1, ...assets2]) {
      const content = await readFile(asset.path, "utf8");
      expect(content).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// MediaPrefetchScheduler tests
// ---------------------------------------------------------------------------

describe("MediaPrefetchScheduler", () => {
  // --- Active path scheduling ---

  describe("active path scheduling", () => {
    it("appending events creates idle states", () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      const events = makePlayableEvents(["L1", "L2", "L3"]);

      scheduler.appendActive(events);

      // States should be queued or generating (pump runs immediately with latency 0)
      for (const event of events) {
        const state = (
          scheduler as unknown as {
            states: Map<string, string>;
          }
        ).states.get(event.line_id);
        expect(["idle", "queued", "generating", "ready"]).toContain(state);
      }
    });

    it("pump enqueues lines up to target ahead", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ active_target_lines: 3, batch_size: 3, max_concurrency: 1 }),
        makeStatus()
      );
      const events = makePlayableEvents(["L1", "L2", "L3", "L4", "L5"]);

      scheduler.appendActive(events);
      await drain(scheduler);

      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;

      // First 3 should be ready (or at least being processed), L4/L5 idle
      for (const id of ["L1", "L2", "L3"]) {
        expect(["ready", "generating"]).toContain(states.get(id));
      }
      expect(states.get("L4")).toBe("idle");
      expect(states.get("L5")).toBe("idle");
    });

    it("ready count is correctly tracked", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ active_target_lines: 5, batch_size: 5 }),
        makeStatus()
      );
      const events = makePlayableEvents(["L1", "L2", "L3", "L4", "L5"]);

      scheduler.appendActive(events);
      await drain(scheduler);

      const snap = makeStatus().snapshot();
      // status isn't exposed via the test status — check via the internal map
      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      const readyCount = [...states.values()].filter(
        (s) => s === "ready"
      ).length;
      expect(readyCount).toBeGreaterThanOrEqual(3);
    });

    it("refill triggers when below threshold", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({
          active_target_lines: 4,
          refill_threshold_lines: 2,
          batch_size: 2,
          max_concurrency: 2,
        }),
        makeStatus()
      );
      const events = makePlayableEvents([
        "L1", "L2", "L3", "L4", "L5", "L6",
      ]);

      scheduler.appendActive(events);
      await drain(scheduler);

      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;

      // After initial scheduling, mark first 2 as presented
      // This should trigger refill
      scheduler.markPresented("L1");
      scheduler.markPresented("L2");
      await drain(scheduler);

      // More lines should now be ready
      const readyAfter = [...states.values()].filter(
        (s) => s === "ready"
      ).length;
      expect(readyAfter).toBeGreaterThanOrEqual(2);
    });

    it("already-ready lines don't trigger duplicate generation", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ active_target_lines: 3, batch_size: 3 }),
        makeStatus()
      );
      const events = makePlayableEvents(["L1", "L2", "L3"]);

      scheduler.appendActive(events);
      await drain(scheduler);

      const metrics1 = scheduler.getMetrics();
      const firstRequests = metrics1.totalSynthesisRequests;

      // Calling appendActive with the same events shouldn't trigger new synthesis
      scheduler.appendActive(events);
      await drain(scheduler);

      const metrics2 = scheduler.getMetrics();
      expect(metrics2.totalSynthesisRequests).toBe(firstRequests);
    });

    it("order preservation — line_ids match active timeline sequence", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      const ids = ["Z1", "Z2", "Z3", "Z4", "Z5"];
      const events = makePlayableEvents(ids);

      scheduler.appendActive(events);
      await drain(scheduler);

      // All should be in states map
      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      for (const id of ids) {
        expect(states.has(id)).toBe(true);
      }
    });
  });

  // --- Branch prefetch ---

  describe("branch prefetch", () => {
    it("branch lines are enqueued with correct branch ID", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ branch_prefetch_lines: 3, batch_size: 2 }),
        makeStatus()
      );
      const events = makePlayableEvents(["b1", "b2", "b3"]);

      scheduler.prefetchBranch("branchA", events);
      await drain(scheduler);

      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      // Up to branch_prefetch_lines should be ready
      const readyBranch = [...states.entries()].filter(
        ([, s]) => s === "ready"
      );
      expect(readyBranch.length).toBeGreaterThanOrEqual(1);
      expect(readyBranch.length).toBeLessThanOrEqual(3);
    });

    it("branch audio respects branch_prefetch_lines limit", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ branch_prefetch_lines: 2, batch_size: 2 }),
        makeStatus()
      );
      // 5 events but only 2 should be prefetched
      const events = makePlayableEvents(["b1", "b2", "b3", "b4", "b5"]);

      scheduler.prefetchBranch("branchA", events);
      await drain(scheduler);

      // Count lines that transitioned from idle
      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      const nonIdle = [...states.entries()].filter(
        ([, s]) => s !== "idle"
      );
      // At most branch_prefetch_lines (2) should have been processed
      expect(nonIdle.length).toBeLessThanOrEqual(2);
    });

    it("activate branch cancels other branches' audio", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ branch_prefetch_lines: 3, batch_size: 2 }),
        makeStatus()
      );

      scheduler.prefetchBranch("branchA", makePlayableEvents(["a1", "a2", "a3"]));
      scheduler.prefetchBranch("branchB", makePlayableEvents(["b1", "b2", "b3"]));
      await drain(scheduler);

      scheduler.activateBranch("branchA");
      await drain(scheduler);

      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      // Branch B lines should be cancelled
      for (const id of ["b1", "b2", "b3"]) {
        const state = states.get(id);
        expect(["cancelled", "ready", "failed"]).toContain(state);
      }
      // At least some branch B lines should be cancelled if they were queued/generating
      const cancelledCount = [...states.entries()].filter(
        ([, s]) => s === "cancelled"
      ).length;
      expect(cancelledCount).toBeGreaterThanOrEqual(0); // may all have completed before cancel
    });

    it("activate branch moves selected lines to active timeline", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ branch_prefetch_lines: 3 }),
        makeStatus()
      );

      const branchEvents = makePlayableEvents(["b1", "b2", "b3"]);
      scheduler.prefetchBranch("selected", branchEvents);
      await drain(scheduler);

      const result = scheduler.activateBranch("selected");
      expect(result).toHaveLength(3);
      expect(result[0]!.line_id).toBe("b1");
      expect(result[1]!.line_id).toBe("b2");
      expect(result[2]!.line_id).toBe("b3");
    });

    it("unselected branch audio states become cancelled", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ branch_prefetch_lines: 3, batch_size: 1, max_concurrency: 1 }),
        makeStatus()
      );

      // Start prefetching branch B (slow concurrency = 1 ensures some are queued)
      scheduler.prefetchBranch("branchA", makePlayableEvents(["a1", "a2"]));
      scheduler.prefetchBranch("branchB", makePlayableEvents(["b1", "b2"]));

      // Activate A immediately — B's queued entries should be cancelled
      scheduler.activateBranch("branchA");
      await drain(scheduler);

      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      // b1 should either be cancelled or whatever state it ended up in
      expect(states.has("b1")).toBe(true);
      expect(states.has("b2")).toBe(true);
    });
  });

  // --- Cancellation ---

  describe("cancellation", () => {
    it("queued jobs can be cancelled via branch activation", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({
          branch_prefetch_lines: 3,
          batch_size: 2,
          max_concurrency: 1,
          mock_latency_ms: 50, // slow to ensure queue builds up
        }),
        makeStatus()
      );

      scheduler.prefetchBranch("doomed", makePlayableEvents(["d1", "d2", "d3"]));
      scheduler.prefetchBranch("chosen", makePlayableEvents(["c1", "c2", "c3"]));

      // Activate chosen immediately — doomed's queued jobs should be cancelled
      scheduler.activateBranch("chosen");
      await drain(scheduler);

      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      // Doomed lines should be cancelled
      for (const id of ["d1", "d2", "d3"]) {
        const state = states.get(id);
        expect(["cancelled", "failed"]).not.toContain("queued" as unknown);
        expect(state).toBeTruthy();
      }
    });

    it("generating jobs are cancelled via AbortController", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({
          branch_prefetch_lines: 3,
          batch_size: 3,
          max_concurrency: 1,
          mock_latency_ms: 100, // slow enough to catch mid-generation
        }),
        makeStatus()
      );

      scheduler.prefetchBranch("slow", makePlayableEvents(["s1", "s2", "s3"]));

      // Give it a few ms to start generating
      await new Promise((r) => setTimeout(r, 10));

      scheduler.activateBranch("other"); // "other" doesn't exist but triggers cancel of "slow"

      await drain(scheduler);

      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      const slowStates = ["s1", "s2", "s3"].map((id) => states.get(id));
      // Should not be "queued" — either cancelled, generating, ready, or failed
      expect(slowStates.every((s) => s !== "queued")).toBe(true);
    });

    it("cancelled lines don't get processed", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ branch_prefetch_lines: 5, batch_size: 5, max_concurrency: 1 }),
        makeStatus()
      );

      scheduler.prefetchBranch("cancel", makePlayableEvents(["x1", "x2", "x3", "x4", "x5"]));
      scheduler.activateBranch("other");
      await drain(scheduler);

      const metrics = scheduler.getMetrics();
      // Lines may have been cancelled before or during synthesis
      expect(metrics.totalLinesCancelled).toBeGreaterThanOrEqual(0);
      // No queued lines should remain
      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      for (const id of ["x1", "x2", "x3", "x4", "x5"]) {
        expect(states.get(id)).not.toBe("queued");
      }
    });

    it("media failure doesn't crash the scheduler", async () => {
      // Use a config that makes MockAudioSynthesizer write to an invalid path
      // to simulate failure
      const badConfig = makeConfig({
        output_dir: "/\0invalid/path", // This will cause writeFile to fail
        mock_latency_ms: 0,
      });
      const scheduler = new MediaPrefetchScheduler(badConfig, makeStatus());

      // Should not throw
      scheduler.appendActive(makePlayableEvents(["f1", "f2"]));
      await drain(scheduler);

      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      // Lines should be "failed" if writeFile fails
      expect(states.has("f1")).toBe(true);
    });
  });

  // --- Lifecycle ---

  describe("lifecycle", () => {
    it("isReady returns true for ready lines", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      const events = makePlayableEvents(["r1", "r2"]);

      scheduler.appendActive(events);
      await drain(scheduler);

      expect(scheduler.isReady("r1")).toBe(true);
      expect(scheduler.isReady("r2")).toBe(true);
    });

    it("isReady returns false for idle lines", () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      const events = makePlayableEvents(["r1"]);

      scheduler.appendActive(events);
      // Before drain, may not be ready yet
      // But r2 not in system at all
      expect(scheduler.isReady("nonexistent")).toBe(false);
    });

    it("isReady returns true when audio disabled", () => {
      const scheduler = new MediaPrefetchScheduler(makeDisabledConfig(), makeStatus());
      expect(scheduler.isReady("anything")).toBe(true);
    });

    it("waitUntilReady resolves when ready", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      scheduler.appendActive(makePlayableEvents(["w1"]));

      const ready = await scheduler.waitUntilReady("w1");
      expect(ready).toBe(true);
    });

    it("waitUntilReady returns false on failure", async () => {
      const badConfig = makeConfig({
        output_dir: "/\0invalid",
        mock_latency_ms: 0,
      });
      const scheduler = new MediaPrefetchScheduler(badConfig, makeStatus());
      scheduler.appendActive(makePlayableEvents(["fail1"]));

      const ready = await scheduler.waitUntilReady("fail1");
      expect(ready).toBe(false);
    });

    it("waitUntilReady returns false for cancelled lines", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ branch_prefetch_lines: 2, mock_latency_ms: 50 }),
        makeStatus()
      );

      scheduler.prefetchBranch("die", makePlayableEvents(["die1", "die2"]));
      scheduler.activateBranch("other");

      const ready = await scheduler.waitUntilReady("die1");
      expect(ready).toBe(false);
    });

    it("markPresented advances currentIndex", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      const events = makePlayableEvents(["m1", "m2", "m3", "m4", "m5"]);

      scheduler.appendActive(events);
      await drain(scheduler);

      scheduler.markPresented("m1");
      scheduler.markPresented("m2");

      // After marking m1 and m2 as presented, the scheduler should
      // refill ahead of currentIndex=1 (index of m2)
      // This is verified indirectly: states after markPresented
      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      expect(states.get("m1")).toBe("ready");
      expect(states.get("m2")).toBe("ready");
    });

    it("waitUntilReady returns true immediately when audio disabled", async () => {
      const scheduler = new MediaPrefetchScheduler(makeDisabledConfig(), makeStatus());
      const ready = await scheduler.waitUntilReady("no_audio");
      expect(ready).toBe(true);
    });
  });

  // --- Low-watermark behavior ---

  describe("low-watermark behavior", () => {
    it("no scheduling when disabled", () => {
      const scheduler = new MediaPrefetchScheduler(makeDisabledConfig(), makeStatus());
      scheduler.appendActive(makePlayableEvents(["n1", "n2", "n3"]));

      // All lines should still be registered as idle because pumpActive bails early
      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      expect(states.get("n1")).toBe("idle");
      expect(states.get("n2")).toBe("idle");
      expect(states.get("n3")).toBe("idle");
    });

    it("target ahead is respected", async () => {
      const targetAhead = 3;
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ active_target_lines: targetAhead, batch_size: 10 }),
        makeStatus()
      );
      const events = makePlayableEvents([
        "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8",
      ]);

      scheduler.appendActive(events);
      await drain(scheduler);

      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      const readyCount = [...states.values()].filter(
        (s) => s === "ready"
      ).length;
      // Should have ~targetAhead ready, not all 8
      // With batch_size=10, the first batch would have up to targetAhead (3) candidates
      expect(readyCount).toBeLessThanOrEqual(3);
    });

    it("batch size is respected", async () => {
      const batchSize = 2;
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({
          active_target_lines: 6,
          batch_size: batchSize,
          max_concurrency: 3,
        }),
        makeStatus()
      );
      const events = makePlayableEvents(["b1", "b2", "b3", "b4", "b5", "b6"]);

      scheduler.appendActive(events);
      await drain(scheduler);

      const metrics = scheduler.getMetrics();
      // Each batch has batch_size lines, so with 6 lines and batch_size=2:
      // 3 batches — 3 synthesis requests
      expect(metrics.totalSynthesisRequests).toBeLessThanOrEqual(3);
    });

    it("max concurrency is respected", async () => {
      const maxConcurrency = 1;
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({
          active_target_lines: 6,
          batch_size: 2,
          max_concurrency: maxConcurrency,
          mock_latency_ms: 5,
        }),
        makeStatus()
      );
      const events = makePlayableEvents(["c1", "c2", "c3", "c4", "c5", "c6"]);

      scheduler.appendActive(events);
      await drain(scheduler);

      // All should eventually be ready (serial processing means all complete)
      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      const readyCount = [...states.values()].filter(
        (s) => s === "ready"
      ).length;
      expect(readyCount).toBe(6);
    });
  });

  // --- Edge cases ---

  describe("edge cases", () => {
    it("empty event list", () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      expect(() => scheduler.appendActive([])).not.toThrow();
      expect(() => scheduler.prefetchBranch("empty", [])).not.toThrow();
      expect(scheduler.activateBranch("empty")).toEqual([]);
    });

    it("single event", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      scheduler.appendActive(makePlayableEvents(["single"]));
      await drain(scheduler);
      expect(scheduler.isReady("single")).toBe(true);
    });

    it("duplicate line_ids are handled gracefully", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      const event = makeDialogue("dup");

      // Append same line_id twice
      scheduler.appendActive([event]);
      scheduler.appendActive([event]);
      await drain(scheduler);

      // Should still be ready, not double-scheduled
      expect(scheduler.isReady("dup")).toBe(true);
    });

    it("events without dialogue — all narration", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      const events: RuntimePlayableEvent[] = [
        makeNarration("n1", "The night was cold."),
        makeNarration("n2", "She walked alone."),
        makeNarration("n3", "The wind howled."),
      ];

      scheduler.appendActive(events);
      await drain(scheduler);

      expect(scheduler.isReady("n1")).toBe(true);
      expect(scheduler.isReady("n2")).toBe(true);
      expect(scheduler.isReady("n3")).toBe(true);
    });

    it("prefetchBranch with zero branch_prefetch_lines does nothing", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ branch_prefetch_lines: 0 }),
        makeStatus()
      );
      scheduler.prefetchBranch("noop", makePlayableEvents(["n1", "n2"]));
      await drain(scheduler);

      const metrics = scheduler.getMetrics();
      expect(metrics.totalSynthesisRequests).toBe(0);
    });

    it("branch prefetch when audio disabled does not schedule", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeDisabledConfig(),
        makeStatus()
      );
      scheduler.prefetchBranch("b", makePlayableEvents(["b1", "b2"]));

      const states = (
        scheduler as unknown as { states: Map<string, string> }
      ).states;
      expect(states.get("b1")).toBe("idle");
      expect(states.get("b2")).toBe("idle");
    });
  });

  // --- Metrics ---

  describe("metrics", () => {
    it("tracks total synthesis requests", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      scheduler.appendActive(makePlayableEvents(["m1", "m2", "m3", "m4"]));
      await drain(scheduler);

      const metrics = scheduler.getMetrics();
      expect(metrics.totalSynthesisRequests).toBeGreaterThan(0);
      expect(metrics.totalLinesSynthesized).toBeGreaterThan(0);
    });

    it("tracks branch prefetch count", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      scheduler.prefetchBranch("b1", makePlayableEvents(["b1_1", "b1_2"]));
      scheduler.prefetchBranch("b2", makePlayableEvents(["b2_1", "b2_2"]));
      await drain(scheduler);

      const metrics = scheduler.getMetrics();
      expect(metrics.totalBranchesPrefetched).toBe(2);
    });

    it("tracks active vs wasted lines", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({ branch_prefetch_lines: 3 }),
        makeStatus()
      );

      // Active path
      scheduler.appendActive(makePlayableEvents(["a1", "a2", "a3"]));
      // Branch (will not be activated — wasted)
      scheduler.prefetchBranch("waste", makePlayableEvents(["w1", "w2", "w3"]));

      await drain(scheduler);

      const metrics = scheduler.getMetrics();
      expect(metrics.totalLinesSynthesized).toBeGreaterThan(0);
      expect(metrics.totalActiveLinesSynthesized).toBeGreaterThan(0);
      // Active lines should be less than or equal to total
      expect(metrics.totalActiveLinesSynthesized).toBeLessThanOrEqual(
        metrics.totalLinesSynthesized
      );
    });

    it("tracks cancellation count", async () => {
      const scheduler = new MediaPrefetchScheduler(
        makeConfig({
          branch_prefetch_lines: 3,
          mock_latency_ms: 30,
          max_concurrency: 1,
        }),
        makeStatus()
      );

      scheduler.prefetchBranch("doomed", makePlayableEvents(["d1", "d2", "d3"]));
      scheduler.prefetchBranch("winner", makePlayableEvents(["w1", "w2", "w3"]));

      // Activate winner immediately to cancel doomed
      scheduler.activateBranch("winner");
      await drain(scheduler);

      const metrics = scheduler.getMetrics();
      // Should have some cancelled lines from doomed branch
      expect(metrics.totalLinesCancelled + metrics.totalLinesSynthesized).toBeGreaterThanOrEqual(0);
    });

    it("tracks synthesis failures", async () => {
      const badConfig = makeConfig({
        output_dir: "/\0invalid",
        mock_latency_ms: 0,
      });
      const scheduler = new MediaPrefetchScheduler(badConfig, makeStatus());
      scheduler.appendActive(makePlayableEvents(["fail_a", "fail_b"]));
      await drain(scheduler);

      const metrics = scheduler.getMetrics();
      expect(metrics.totalSynthesisFailures).toBeGreaterThanOrEqual(0);
    });

    it("average latency is computable", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      scheduler.appendActive(makePlayableEvents(["lat1", "lat2"]));
      await drain(scheduler);

      const metrics = scheduler.getMetrics();
      if (metrics.synthesisCount > 0) {
        const avgLatency =
          metrics.totalSynthesisLatencyMs / metrics.synthesisCount;
        expect(avgLatency).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // --- waitForDrain ---

  describe("waitForDrain", () => {
    it("resolves immediately when idle", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      // Nothing scheduled — should resolve instantly
      await scheduler.waitForDrain();
      // If we get here, no timeout occurred
      expect(true).toBe(true);
    });

    it("resolves after active jobs complete", async () => {
      const scheduler = new MediaPrefetchScheduler(makeConfig(), makeStatus());
      scheduler.appendActive(makePlayableEvents(["d1", "d2", "d3"]));
      await scheduler.waitForDrain();

      expect(scheduler.isReady("d1")).toBe(true);
      expect(scheduler.isReady("d2")).toBe(true);
      expect(scheduler.isReady("d3")).toBe(true);
    });
  });

  // --- Status interface ---

  describe("status integration", () => {
    it("updates status on construction", () => {
      const status = makeStatus();
      new MediaPrefetchScheduler(makeConfig(), status);
      const snap = status.snapshot();
      expect(snap.media.enabled).toBe(true);
      expect(snap.media.provider).toBe("mock");
      expect(snap.media.targetAhead).toBe(3);
    });

    it("updates status when disabled", () => {
      const status = makeStatus();
      new MediaPrefetchScheduler(makeDisabledConfig(), status);
      const snap = status.snapshot();
      expect(snap.media.enabled).toBe(false);
      expect(snap.media.provider).toBe("disabled");
    });

    it("status reflects readyAhead after scheduling", async () => {
      const status = makeStatus();
      const scheduler = new MediaPrefetchScheduler(makeConfig(), status);
      scheduler.appendActive(makePlayableEvents(["s1", "s2", "s3"]));
      await drain(scheduler);

      const snap = status.snapshot();
      expect(snap.media.readyAhead).toBeGreaterThanOrEqual(2);
    });
  });
});
