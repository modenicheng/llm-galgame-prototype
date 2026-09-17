import { describe, expect, it } from "vitest";
import type { WriterTaskModel } from "./monitor-model.js";
import { deriveGenerationStatus } from "./status-bar.js";

function task(overrides: Partial<WriterTaskModel["attempts"][number]> = {}): WriterTaskModel {
  return {
    taskId: "continuation-nonce",
    taskType: "continuation",
    sliceId: null,
    startedAt: 1_000,
    lastActivityAt: 1_000,
    firstSeen: 0,
    attempts: [
      {
        attemptId: "continuation-nonce#0",
        index: 0,
        state: "streaming",
        startedAt: 1_000,
        endedAt: null,
        chars: 0,
        lines: 0,
        groups: 0,
        error: null,
        segmentEnd: null,
        firstTokenMs: null,
        usage: null,
        repairs: [],
        promptRequests: [],
        text: "",
        truncated: false,
        ...overrides,
      },
    ],
  };
}

describe("deriveGenerationStatus", () => {
  it("reports requesting and the live wait before the first token", () => {
    expect(deriveGenerationStatus([task()], 1_640)).toEqual({
      phase: "requesting",
      taskType: "continuation",
      waitMs: 640,
    });
  });

  it("reports streaming with the fixed first-token latency", () => {
    expect(
      deriveGenerationStatus(
        [task({ firstTokenMs: 420, chars: 18, text: "苏遥：来了。\n" })],
        2_000,
      ),
    ).toEqual({ phase: "streaming", taskType: "continuation", firstTokenMs: 420 });
  });

  it("reports idle when no attempt is active", () => {
    expect(
      deriveGenerationStatus(
        [task({ state: "done", endedAt: 1_900, firstTokenMs: 310, chars: 18 })],
        2_000,
      ),
    ).toEqual({
      phase: "idle",
      lastFirstTokenMs: 310,
      lastLatencyMs: 900,
      lastFailed: false,
    });
  });

  it("flags the idle state when the latest attempt failed", () => {
    expect(
      deriveGenerationStatus(
        [task({ state: "failed", endedAt: 1_900, firstTokenMs: null, error: "boom" })],
        2_000,
      ),
    ).toEqual({
      phase: "idle",
      lastFirstTokenMs: null,
      lastLatencyMs: 900,
      lastFailed: true,
    });
  });
});
