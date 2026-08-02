/**
 * Tests for cacheKeyFromRecipe: determinism, full-parameter sensitivity,
 * and the distinct behavior of an absent vs. empty compiledInstruction.
 */
import { describe, it, expect } from "vitest";
import { cacheKeyFromRecipe, type CacheKeyRecipe } from "./cache-key.js";

function makeRecipe(overrides: Partial<CacheKeyRecipe> = {}): CacheKeyRecipe {
  return {
    provider: "dashscope",
    model: "cosyvoice-v2",
    voiceId: "voice-1",
    voiceRevision: 3,
    text: "你好，世界。",
    rate: 1,
    pitch: 1,
    volume: 1,
    seed: 42,
    format: "pcm_s16le",
    sampleRate: 22050,
    ...overrides,
  };
}

describe("cacheKeyFromRecipe", () => {
  it("produces the same key for the same recipe", () => {
    expect(cacheKeyFromRecipe(makeRecipe())).toBe(cacheKeyFromRecipe(makeRecipe()));
  });

  it("changes the key when any audio-affecting field changes", () => {
    const base = cacheKeyFromRecipe(makeRecipe());
    const mutations: Array<Partial<CacheKeyRecipe>> = [
      { provider: "mock" },
      { model: "other-model" },
      { voiceId: "voice-2" },
      { voiceRevision: 4 },
      { text: "不同的文本" },
      { rate: 1.1 },
      { pitch: 0.9 },
      { volume: 0.8 },
      { seed: 43 },
      { format: "pcm_s16le" }, // same value → same key (sanity)
      { sampleRate: 16000 },
      { compiledInstruction: "温柔地说" },
    ];
    for (const mutation of mutations) {
      const key = cacheKeyFromRecipe(makeRecipe(mutation));
      if (mutation.format === "pcm_s16le") {
        expect(key).toBe(base);
      } else {
        expect(key).not.toBe(base);
      }
    }
  });

  it("treats absent instruction differently from an empty-string instruction", () => {
    const absent = cacheKeyFromRecipe(makeRecipe());
    const empty = cacheKeyFromRecipe(makeRecipe({ compiledInstruction: "" }));

    expect(absent).not.toBe(empty);
  });

  it("includes a present instruction in the digest", () => {
    const withInstruction = cacheKeyFromRecipe(makeRecipe({ compiledInstruction: "沉稳" }));
    const withoutInstruction = cacheKeyFromRecipe(makeRecipe());

    expect(withInstruction).not.toBe(withoutInstruction);
  });
});
