/**
 * Tests for AudioDescriptorFactory: voice resolution, descriptor/recipe
 * shapes, env-based voice IDs, mock bindings, and deterministic seeds.
 */
import { describe, it, expect } from "vitest";
import { AudioDescriptorFactory, type AudioDescriptorFactoryOptions } from "./audio-descriptor-factory.js";
import type { VoicesConfig } from "../../config/voices.js";
import type { PerformanceCompiler } from "./performance-compiler.js";
import type { RuntimePlayableEvent } from "../../schema.js";
import type { InternalAudioRecipe } from "./internal-audio-recipe.js";

const stubCompiler: PerformanceCompiler = {
  compile: () => ({
    rate: 1,
    pitch: 1,
    volume: 1,
    pauseBeforeMs: 0,
    pauseAfterMs: 0,
  }),
};

const voices: VoicesConfig = {
  version: 2,
  profiles: {
    suyao_main: {
      semantic: {
        base_description: "温柔的少女声",
        allowed_delivery: ["gentle"],
        forbidden_delivery: ["cold"],
      },
      providers: {
        dashscope: {
          model: "cosyvoice-v2",
          voice_id_env: "SUYAO_VOICE_ID",
          voice_revision: 3,
        },
      },
    },
    narrator_main: {
      semantic: {
        base_description: "沉稳的旁白",
        allowed_delivery: [],
        forbidden_delivery: [],
      },
      providers: {},
    },
  },
};

const characters: AudioDescriptorFactoryOptions["characters"] = {
  suyao: { name: "苏遥", voice_profile: "suyao_main" },
  旁白: { name: "旁白", voice_profile: "narrator_main" },
};

function makeFactory(overrides: Partial<AudioDescriptorFactoryOptions> = {}): AudioDescriptorFactory {
  return new AudioDescriptorFactory({
    characters,
    voices,
    provider: "dashscope",
    modelProfile: "cosyvoice_v3_flash",
    sampleRate: 22050,
    format: "pcm_s16le",
    env: { SUYAO_VOICE_ID: "suyao-voice-001" },
    compiler: stubCompiler,
    seedFor: (lineId) => [...lineId].reduce((acc, char) => acc + char.charCodeAt(0), 0),
    ...overrides,
  });
}

function dialogue(speaker: string, text: string, lineId: string): RuntimePlayableEvent {
  return { type: "dialogue", speaker, text, line_id: lineId };
}

function narration(text: string, lineId: string): RuntimePlayableEvent {
  return { type: "narration", text, line_id: lineId };
}

describe("AudioDescriptorFactory", () => {
  it("builds a descriptor + recipe for dialogue with a profile", () => {
    const result = makeFactory().build(
      dialogue("suyao", "今天天气真好。", "l1"),
      { type: "active" },
      "current",
    );

    expect(result).not.toBeNull();
    const { descriptor, recipe } = result!;
    expect(descriptor).toMatchObject({
      lineId: "l1",
      scope: { type: "active" },
      priority: "current",
      speakerId: "suyao",
      displaySpeaker: "苏遥",
      format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
    });
    expect(descriptor.cacheKey).toBe(recipe.cacheKey);
    expect(recipe).toMatchObject({
      lineId: "l1",
      text: "今天天气真好。",
      model: "cosyvoice-v2",
      voiceId: "suyao-voice-001",
      voiceRevision: 3,
      rate: 1,
      pitch: 1,
      volume: 1,
    });
  });

  it("returns null for an unknown speaker", () => {
    expect(makeFactory().build(dialogue("ghost", "hi", "l2"), { type: "active" }, "current")).toBeNull();
  });

  it("returns null for narration when no 旁白 profile exists", () => {
    const factory = makeFactory({ characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } } });
    expect(factory.build(narration("风雪夜。", "l3"), { type: "active" }, "current")).toBeNull();
  });

  it("builds narration via the 旁白 character profile", () => {
    const result = makeFactory().build(narration("风雪夜。", "l3"), { type: "active" }, "active_future");

    expect(result).not.toBeNull();
    expect(result!.descriptor).toMatchObject({
      speakerId: "narrator",
      displaySpeaker: "旁白",
    });
    expect(result!.recipe.text).toBe("风雪夜。");
  });

  it("uses the configured env voice ID and falls back to <unset>", () => {
    const recipe = makeFactory().build(dialogue("suyao", "hi", "l4"), { type: "active" }, "current")!
      .recipe as InternalAudioRecipe;
    expect(recipe.voiceId).toBe("suyao-voice-001");

    const unset = makeFactory({ env: {} }).build(dialogue("suyao", "hi", "l4"), { type: "active" }, "current")!;
    expect(unset.recipe.voiceId).toBe("<unset>");
  });

  it("synthesizes a stable mock binding when provider is mock", () => {
    const result = makeFactory({
      provider: "mock",
      env: { MOCK_VOICE_suyao: "mock-voice-9" },
    }).build(dialogue("suyao", "hi", "l5"), { type: "active" }, "current")!;

    expect(result.recipe).toMatchObject({
      model: "cosyvoice_v3_flash",
      voiceId: "mock-voice-9",
      voiceRevision: 0,
    });
    // Same speaker + text + mock binding → deterministic key.
    const again = makeFactory({
      provider: "mock",
      env: { MOCK_VOICE_suyao: "mock-voice-9" },
    }).build(dialogue("suyao", "hi", "l5"), { type: "active" }, "current")!;
    expect(again.recipe.cacheKey).toBe(result.recipe.cacheKey);
  });

  it("falls back to a mock binding when the profile has no provider binding", () => {
    const result = makeFactory().build(narration("旁白内容。", "l6"), { type: "active" }, "current")!;
    expect(result.recipe.model).toBe("cosyvoice_v3_flash");
    expect(result.recipe.voiceRevision).toBe(0);
  });

  it("uses a deterministic per-line seed", () => {
    const factory = makeFactory();
    const first = factory.build(dialogue("suyao", "你好", "l7"), { type: "active" }, "current")!;
    const second = factory.build(dialogue("suyao", "你好", "l7"), { type: "active" }, "current")!;
    expect(first.recipe.seed).toBe(second.recipe.seed);
    expect(first.recipe.cacheKey).toBe(second.recipe.cacheKey);

    const otherLine = factory.build(dialogue("suyao", "你好", "l8"), { type: "active" }, "current")!;
    expect(otherLine.recipe.seed).not.toBe(first.recipe.seed);
  });

  it("scopes the descriptor to the requested scope", () => {
    const result = makeFactory().build(
      dialogue("suyao", "hi", "l9"),
      { type: "candidate", branchId: "b1" },
      "candidate_first_line",
    )!;
    expect(result.descriptor.scope).toEqual({ type: "candidate", branchId: "b1" });
    expect(result.descriptor.priority).toBe("candidate_first_line");
  });
});
