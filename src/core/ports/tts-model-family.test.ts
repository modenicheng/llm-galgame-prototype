import { describe, expect, it } from "vitest";
import {
  QWEN3_TTS_SAMPLE_RATE,
  isQwen3TtsInstructModel,
  ttsModelFamilyOf,
} from "./tts-model-family.js";

describe("ttsModelFamilyOf", () => {
  it.each([
    ["qwen3-tts-flash", "qwen3-tts"],
    ["qwen3-tts-flash-2025-11-27", "qwen3-tts"],
    ["qwen3-tts-instruct-flash-2026-01-26", "qwen3-tts"],
    ["qwen3-tts-vc-2026-01-22", "qwen3-tts"],
    ["qwen3-tts-vd-2026-01-26", "qwen3-tts"],
    ["cosyvoice-v3-flash", "cosyvoice"],
    ["cosyvoice-v3.5-flash", "cosyvoice"],
    ["cosyvoice-clone-v2", "cosyvoice"],
    ["qwen-audio-3.0-tts-plus", "cosyvoice"],
    ["qwen-tts", "cosyvoice"], // legacy qwen-tts stays on the SpeechSynthesizer endpoint
  ])("classifies %s as %s", (model, family) => {
    expect(ttsModelFamilyOf(model)).toBe(family);
  });

  it("exposes the fixed qwen3 sample rate", () => {
    expect(QWEN3_TTS_SAMPLE_RATE).toBe(24000);
  });
});

describe("isQwen3TtsInstructModel", () => {
  it("is true only for the instruct sub-family", () => {
    expect(isQwen3TtsInstructModel("qwen3-tts-instruct-flash-2026-01-26")).toBe(true);
    expect(isQwen3TtsInstructModel("qwen3-tts-flash")).toBe(false);
    expect(isQwen3TtsInstructModel("qwen3-tts-vc-2026-01-22")).toBe(false);
    expect(isQwen3TtsInstructModel("cosyvoice-v3-flash")).toBe(false);
  });
});
