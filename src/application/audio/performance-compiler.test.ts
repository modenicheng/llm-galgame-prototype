/**
 * Tests for PerformanceCompilerImpl — LLM 演出意图 → 供应商参数。
 *
 * Key contracts: identity defaults for ordinary lines, constrained delivery
 * filtering (§14.1), the numeric pace/energy/volume bounds (§14.5), stable
 * output for identical inputs (cacheKey safety), and total behavior (never
 * throws on garbage input).
 */
import { describe, it, expect } from "vitest";
import {
  PerformanceCompilerImpl,
  type PerformanceCompileInput,
  type LinePerformance,
} from "./performance-compiler.js";

const BASE = "年轻女性，音色清亮偏冷，表达克制，句子较短。";

function compile(input: PerformanceCompileInput) {
  return new PerformanceCompilerImpl().compile(input);
}

describe("PerformanceCompilerImpl", () => {
  it("compiles an ordinary line to identity defaults with only the base description", () => {
    const result = compile({ baseDescription: BASE });
    expect(result).toEqual({
      instruction: BASE,
      rate: 1.0,
      pitch: 1.0,
      volume: 50,
      pauseBeforeMs: 0,
      pauseAfterMs: 0,
    });
  });

  it("omits instruction when the base description is empty and no delivery/intensity given", () => {
    const result = compile({ baseDescription: "  " });
    expect(result.instruction).toBeUndefined();
    expect(result.rate).toBe(1.0);
    expect(result.pitch).toBe(1.0);
    expect(result.volume).toBe(50);
  });

  it("filters forbidden delivery styles and keeps allowed ones", () => {
    const result = compile({
      baseDescription: BASE,
      allowedDelivery: ["restrained", "gentle"],
      forbiddenDelivery: ["cold", "playful"],
      performance: { delivery: ["restrained", "cold", "playful", "gentle"] },
    });
    expect(result.instruction).toBe(`${BASE}语气：克制、温柔。`);
  });

  it("keeps delivery styles when no allowed list is provided (only forbidden filtered)", () => {
    const result = compile({
      baseDescription: BASE,
      forbiddenDelivery: ["cold"],
      performance: { delivery: ["restrained", "cold", "firm"] },
    });
    expect(result.instruction).toBe(`${BASE}语气：克制、坚定。`);
  });

  it("drops delivery styles outside an explicit allowed list", () => {
    const result = compile({
      baseDescription: BASE,
      allowedDelivery: ["restrained"],
      performance: { delivery: ["restrained", "playful", "tearful"] },
    });
    expect(result.instruction).toBe(`${BASE}语气：克制。`);
  });

  it("maps pace to rate bounds", () => {
    expect(compile({ baseDescription: BASE, performance: { pace: "very_slow" } }).rate).toBe(0.85);
    expect(compile({ baseDescription: BASE, performance: { pace: "slow" } }).rate).toBe(0.92);
    expect(compile({ baseDescription: BASE, performance: { pace: "normal" } }).rate).toBe(1.0);
    expect(compile({ baseDescription: BASE, performance: { pace: "fast" } }).rate).toBe(1.08);
    expect(compile({ baseDescription: BASE, performance: { pace: "very_fast" } }).rate).toBe(1.15);
  });

  it("maps energy to pitch bounds", () => {
    expect(compile({ baseDescription: BASE, performance: { energy: "very_low" } }).pitch).toBe(0.9);
    expect(compile({ baseDescription: BASE, performance: { energy: "low" } }).pitch).toBe(0.95);
    expect(compile({ baseDescription: BASE, performance: { energy: "normal" } }).pitch).toBe(1.0);
    expect(compile({ baseDescription: BASE, performance: { energy: "high" } }).pitch).toBe(1.05);
    expect(compile({ baseDescription: BASE, performance: { energy: "very_high" } }).pitch).toBe(1.1);
  });

  it("maps volume to volume bounds", () => {
    expect(compile({ baseDescription: BASE, performance: { volume: "whisper" } }).volume).toBe(20);
    expect(compile({ baseDescription: BASE, performance: { volume: "soft" } }).volume).toBe(35);
    expect(compile({ baseDescription: BASE, performance: { volume: "normal" } }).volume).toBe(50);
    expect(compile({ baseDescription: BASE, performance: { volume: "loud" } }).volume).toBe(70);
  });

  it("passes through pauses", () => {
    const result = compile({
      baseDescription: BASE,
      performance: { pause_before_ms: 120, pause_after_ms: 350 },
    });
    expect(result.pauseBeforeMs).toBe(120);
    expect(result.pauseAfterMs).toBe(350);
  });

  it("adds intensity emphasis to the instruction for intensity 2-3", () => {
    expect(compile({ baseDescription: BASE, performance: { intensity: 2 } }).instruction).toBe(
      `${BASE}情绪强烈。`,
    );
    expect(compile({ baseDescription: BASE, performance: { intensity: 3 } }).instruction).toBe(
      `${BASE}情绪强烈。`,
    );
  });

  it("does not add intensity emphasis for intensity 0-1", () => {
    expect(compile({ baseDescription: BASE, performance: { intensity: 0 } }).instruction).toBe(BASE);
    expect(compile({ baseDescription: BASE, performance: { intensity: 1 } }).instruction).toBe(BASE);
  });

  it("produces identical output for identical inputs (cacheKey stability)", () => {
    const input: PerformanceCompileInput = {
      baseDescription: BASE,
      allowedDelivery: ["restrained", "firm"],
      forbiddenDelivery: ["cold"],
      performance: {
        emotion: "happy",
        intensity: 3,
        pace: "fast",
        energy: "high",
        volume: "loud",
        delivery: ["restrained", "cold", "firm"],
        pause_before_ms: 100,
        pause_after_ms: 200,
      },
    };
    const a = compile(input);
    const b = compile(input);
    expect(a).toEqual(b);
  });

  it("never throws on garbage performance input — falls back to defaults", () => {
    const garbage = {
      baseDescription: BASE,
      performance: {
        emotion: "evil",
        intensity: 99,
        pace: "warp",
        energy: "ultra",
        volume: "max",
        delivery: "not-an-array",
        pause_before_ms: -5,
        pause_after_ms: Number.NaN,
      } as unknown as LinePerformance,
    };
    const result = compile(garbage);
    expect(result.rate).toBe(1.0);
    expect(result.pitch).toBe(1.0);
    expect(result.volume).toBe(50);
    expect(result.pauseBeforeMs).toBe(0);
    expect(result.pauseAfterMs).toBe(0);
    // Base description survives as the default tone; nothing else leaks in.
    expect(result.instruction).toBe(BASE);
  });

  it("never throws when input or performance is null/undefined", () => {
    expect(compile({ baseDescription: BASE }).rate).toBe(1.0);
    expect(
      compile({ baseDescription: BASE, performance: null as unknown as LinePerformance }).rate,
    ).toBe(1.0);
    expect(compile({ baseDescription: BASE, performance: 42 as unknown as LinePerformance }).rate).toBe(1.0);
    expect(compile(undefined as unknown as PerformanceCompileInput).rate).toBe(1.0);
  });
});

describe("instruction modes", () => {
  const compiler = new PerformanceCompilerImpl();

  it("fixed_emotion emits the DashScope fixed-format emotion instruction", () => {
    const out = compiler.compile({
      baseDescription: "年轻女性。",
      instructionMode: "fixed_emotion",
      performance: { emotion: "sad", delivery: ["gentle"], intensity: 3 },
    });
    expect(out.instruction).toBe("你说话的情感是sad。");
  });

  it("fixed_emotion maps emotions to the DashScope vocabulary incl. surprised/disgusted", () => {
    const cases: Array<[string, string]> = [
      ["neutral", "neutral"],
      ["happy", "happy"],
      ["angry", "angry"],
      ["afraid", "fearful"],
      ["anxious", "fearful"],
      ["excited", "happy"],
      ["surprised", "surprised"],
      ["disgusted", "disgusted"],
    ];
    for (const [from, to] of cases) {
      const out = compiler.compile({
        baseDescription: "",
        instructionMode: "fixed_emotion",
        performance: { emotion: from as never },
      });
      expect(out.instruction).toBe(`你说话的情感是${to}。`);
    }
  });

  it("fixed_emotion omits the instruction for unmappable emotions", () => {
    for (const emotion of ["tired", "sarcastic", "tender", "serious"]) {
      const out = compiler.compile({
        baseDescription: "",
        instructionMode: "fixed_emotion",
        performance: { emotion: emotion as never },
      });
      expect(out.instruction).toBeUndefined();
    }
  });

  it("free mode (default) keeps the existing free-form instruction", () => {
    const out = compiler.compile({
      baseDescription: "年轻女性。",
      performance: { emotion: "sad", delivery: ["gentle"] },
    });
    expect(out.instruction).toContain("语气：温柔");
  });

  it("none mode omits the instruction entirely", () => {
    const out = compiler.compile({
      baseDescription: "年轻女性。",
      instructionMode: "none",
      performance: { emotion: "happy", delivery: ["gentle"] },
    });
    expect(out.instruction).toBeUndefined();
    expect(out.volume).toBe(50);
  });

  it("truncates the instruction to the 100 weighted-char budget", () => {
    // 51 汉字 = 102 weighted chars → base alone overflows, truncated to 50.
    const longBase = "青".repeat(51);
    const out = compiler.compile({ baseDescription: longBase, instructionMode: "free" });
    expect(out.instruction).toBe("青".repeat(50));
  });

  it("drops trailing clauses before truncating the base description", () => {
    // 48 汉字 base (96) + 语气 clause (8+) overflows → delivery dropped, base kept.
    const base = "清".repeat(48);
    const out = compiler.compile({
      baseDescription: base,
      instructionMode: "free",
      performance: { delivery: ["gentle", "firm"] },
    });
    expect(out.instruction).toBe(base);
  });

  it("counts 汉字 as 2 and other chars as 1 at the budget boundary", () => {
    // 50 汉字 = exactly 100 weighted → kept untruncated.
    const exactly = "青".repeat(50);
    expect(
      compiler.compile({ baseDescription: exactly, instructionMode: "free" }).instruction,
    ).toBe(exactly);
    // 50 汉字 + fullwidth comma (U+FF0C, counts 1) = 101 → trailing char cut.
    const overflow = "青".repeat(50) + "，";
    expect(
      compiler.compile({ baseDescription: overflow, instructionMode: "free" }).instruction,
    ).toBe("青".repeat(50));
    // 49 汉字 + 2 punct (，=1, 、=1) = exactly 100 → kept.
    const withPunct = "青".repeat(49) + "，、";
    expect(
      compiler.compile({ baseDescription: withPunct, instructionMode: "free" }).instruction,
    ).toBe(withPunct);
  });
});
