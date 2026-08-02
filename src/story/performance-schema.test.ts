/**
 * Tests for LinePerformanceSchema and its attachment to the draft event
 * schemas. The load-bearing behavior (§14.5): an invalid `performance` is
 * DROPPED while the line body survives.
 */
import { describe, it, expect } from "vitest";
import {
  DialogueDraftEventSchema,
  NarrationDraftEventSchema,
  LinePerformanceSchema,
} from "./types.js";

const VALID_PERFORMANCE = {
  emotion: "happy",
  intensity: 2,
  pace: "fast",
  energy: "high",
  volume: "soft",
  delivery: ["restrained", "firm"],
  pause_before_ms: 120,
  pause_after_ms: 350,
} as const;

describe("LinePerformanceSchema", () => {
  it("parses a valid full performance", () => {
    const result = LinePerformanceSchema.safeParse(VALID_PERFORMANCE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(VALID_PERFORMANCE);
    }
  });

  it("parses an empty object (all fields optional)", () => {
    const result = LinePerformanceSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects an unknown emotion", () => {
    const result = LinePerformanceSchema.safeParse({ emotion: "evil" });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range intensity", () => {
    const result = LinePerformanceSchema.safeParse({ intensity: 5 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative pause", () => {
    const result = LinePerformanceSchema.safeParse({ pause_before_ms: -3 });
    expect(result.success).toBe(false);
  });

  it("rejects a fractional pause", () => {
    const result = LinePerformanceSchema.safeParse({ pause_after_ms: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe("DialogueDraftEventSchema with performance", () => {
  it("parses a valid performance on a dialogue line", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "Hello!",
      performance: VALID_PERFORMANCE,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.performance).toEqual(VALID_PERFORMANCE);
      expect(result.data.text).toBe("Hello!");
    }
  });

  it("parses with omitted performance (undefined)", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "Hello!",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.performance).toBeUndefined();
    }
  });

  it("drops an invalid emotion but keeps the line body", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "Hello!",
      performance: { emotion: "evil" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.performance).toBeUndefined();
      expect(result.data.speaker).toBe("alice");
      expect(result.data.text).toBe("Hello!");
    }
  });

  it("drops an out-of-range intensity but keeps the line body", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "Hello!",
      performance: { intensity: 5 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.performance).toBeUndefined();
      expect(result.data.text).toBe("Hello!");
    }
  });

  it("drops an invalid pause but keeps the line body", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "Hello!",
      performance: { pause_before_ms: -3 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.performance).toBeUndefined();
      expect(result.data.text).toBe("Hello!");
    }
  });

  it("drops the whole performance when any field is invalid, keeps the body", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "Hello!",
      performance: { emotion: "evil", pace: "fast" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.performance).toBeUndefined();
      expect(result.data.text).toBe("Hello!");
    }
  });
});

describe("NarrationDraftEventSchema with performance", () => {
  it("parses a valid performance on a narration line", () => {
    const result = NarrationDraftEventSchema.safeParse({
      type: "narration",
      text: "The sun set.",
      performance: { emotion: "tender", volume: "soft" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.performance).toEqual({ emotion: "tender", volume: "soft" });
      expect(result.data.text).toBe("The sun set.");
    }
  });

  it("drops an invalid performance but keeps the narration body", () => {
    const result = NarrationDraftEventSchema.safeParse({
      type: "narration",
      text: "The sun set.",
      performance: { volume: "ear-splitting" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.performance).toBeUndefined();
      expect(result.data.text).toBe("The sun set.");
    }
  });
});
