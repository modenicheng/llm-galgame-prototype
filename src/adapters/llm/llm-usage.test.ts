/**
 * Tests for the LLM usage parser in src/adapters/llm/llm-usage.ts.
 */

import { describe, it, expect } from "vitest";
import { parseLLMUsage } from "./llm-usage.js";

describe("parseLLMUsage", () => {
  it("reads DeepSeek prompt_cache_hit_tokens", () => {
    expect(
      parseLLMUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 64,
        prompt_cache_miss_tokens: 36,
      }),
    ).toEqual({ input: 100, output: 50, cachedInput: 64 });
  });

  it("reads OpenAI prompt_tokens_details.cached_tokens", () => {
    expect(
      parseLLMUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 32, audio_tokens: 0 },
      }),
    ).toEqual({ input: 100, output: 50, cachedInput: 32 });
  });

  it("returns zero cache when no cache fields are present", () => {
    expect(parseLLMUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      input: 10,
      output: 5,
      cachedInput: 0,
    });
  });

  it("prefers the OpenAI-standard field when both styles are present", () => {
    expect(
      parseLLMUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 64,
        prompt_tokens_details: { cached_tokens: 32 },
      }),
    ).toEqual({ input: 100, output: 50, cachedInput: 32 });
  });

  it("falls back to DeepSeek field when OpenAI field is zero", () => {
    expect(
      parseLLMUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 64,
        prompt_tokens_details: { cached_tokens: 0 },
      }),
    ).toEqual({ input: 100, output: 50, cachedInput: 64 });
  });

  it("clamps cachedInput to prompt_tokens", () => {
    expect(
      parseLLMUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 999 },
      }),
    ).toEqual({ input: 10, output: 5, cachedInput: 10 });
  });

  it("clamps negative cache values to zero", () => {
    expect(
      parseLLMUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_cache_hit_tokens: -3,
      }),
    ).toEqual({ input: 10, output: 5, cachedInput: 0 });
  });

  it("returns null when token counters are missing", () => {
    expect(parseLLMUsage({ completion_tokens: 5 })).toBeNull();
    expect(parseLLMUsage({ prompt_tokens: 10 })).toBeNull();
    expect(parseLLMUsage({})).toBeNull();
  });

  it("returns null when token counters are not finite non-negative numbers", () => {
    expect(
      parseLLMUsage({ prompt_tokens: "10", completion_tokens: 5 }),
    ).toBeNull();
    expect(
      parseLLMUsage({ prompt_tokens: -1, completion_tokens: 5 }),
    ).toBeNull();
    expect(
      parseLLMUsage({ prompt_tokens: Number.NaN, completion_tokens: 5 }),
    ).toBeNull();
  });

  it("returns null for non-object payloads", () => {
    expect(parseLLMUsage(null)).toBeNull();
    expect(parseLLMUsage(undefined)).toBeNull();
    expect(parseLLMUsage("usage")).toBeNull();
    expect(parseLLMUsage(42)).toBeNull();
  });

  it("reads completion_tokens_details.reasoning_tokens (DeepSeek thinking mode)", () => {
    expect(
      parseLLMUsage({
        prompt_tokens: 36,
        completion_tokens: 209,
        completion_tokens_details: { reasoning_tokens: 189 },
      }),
    ).toEqual({ input: 36, output: 209, cachedInput: 0, reasoningTokens: 189 });
  });

  it("omits reasoningTokens when the breakdown is absent (thinking off)", () => {
    const reading = parseLLMUsage({
      prompt_tokens: 10,
      completion_tokens: 12,
      completion_tokens_details: {},
    });
    expect(reading).toEqual({ input: 10, output: 12, cachedInput: 0 });
    expect(reading?.reasoningTokens).toBeUndefined();
  });

  it("ignores non-finite reasoning_tokens values", () => {
    expect(
      parseLLMUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: "many" },
      }),
    ).toEqual({ input: 10, output: 5, cachedInput: 0 });
  });
});
