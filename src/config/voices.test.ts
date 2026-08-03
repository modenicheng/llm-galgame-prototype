import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadVoices,
  resolveVoiceBinding,
  resolveVoiceId,
  validateDashscopeEnv,
  type VoicesConfig,
} from "./voices.js";

function fixtureDir(yaml: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "voices-test-"));
  writeFileSync(path.join(dir, "voices.yaml"), yaml, "utf8");
  return dir;
}

const V3_FIXTURE = `version: 3
profiles:
  suyao_main:
    semantic:
      base_description: 年轻女性，音色清亮偏冷，表达克制。
    providers:
      dashscope:
        model: cosyvoice-v3-flash
        voice_id_env: COSYVOICE_VOICE_SUYAO
  system_sample:
    semantic:
      base_description: 阳光大男孩。
    providers:
      dashscope:
        model: cosyvoice-v3-flash
        voice_id_env: COSYVOICE_VOICE_SYSTEM_SAMPLE
        voice_revision: 2
        instruction_mode: fixed_emotion
`;

describe("loadVoices v3 strict", () => {
  it("parses the binding with zod defaults expanded", async () => {
    const dir = fixtureDir(V3_FIXTURE);
    try {
      const voices = await loadVoices(path.join(dir, "voices.yaml"));
      expect(voices.version).toBe(3);
      const suyao = resolveVoiceBinding(voices, "suyao_main", "dashscope")!;
      expect(suyao.voice_revision).toBe(1); // default expanded
      expect(suyao.instruction_mode).toBe("free"); // default expanded
      const sys = resolveVoiceBinding(voices, "system_sample", "dashscope")!;
      expect(sys.voice_revision).toBe(2);
      expect(sys.instruction_mode).toBe("fixed_emotion");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["version 2", `version: 2\nprofiles: {}\n`],
    ["v2 voice_id leftover", `version: 3\nprofiles:\n  p:\n    semantic: { base_description: x }\n    providers:\n      dashscope: { model: m, voice_id: longanyang, voice_revision: 1, instruction_mode: free }\n`],
    ["voice_source leftover", `version: 3\nprofiles:\n  p:\n    semantic: { base_description: x }\n    providers:\n      dashscope: { model: m, voice_source: s, voice_id_env: V, voice_revision: 1, instruction_mode: free }\n`],
    ["voice_sources section leftover", `version: 3\nvoice_sources:\n  s: { kind: clone, target_model: m, prefix: x }\nprofiles: {}\n`],
    ["hot_fix leftover", `version: 3\nprofiles:\n  p:\n    semantic: { base_description: x }\n    providers:\n      dashscope: { model: m, voice_id_env: V, voice_revision: 1, instruction_mode: free, hot_fix: { pronunciation: [{ word: a, pinyin: b }] } }\n`],
    ["missing voice_id_env", `version: 3\nprofiles:\n  p:\n    semantic: { base_description: x }\n    providers:\n      dashscope: { model: m, voice_revision: 1, instruction_mode: free }\n`],
    ["bad env var name", `version: 3\nprofiles:\n  p:\n    semantic: { base_description: x }\n    providers:\n      dashscope: { model: m, voice_id_env: "1BAD-name", voice_revision: 1, instruction_mode: free }\n`],
    ["unknown instruction_mode", `version: 3\nprofiles:\n  p:\n    semantic: { base_description: x }\n    providers:\n      dashscope: { model: m, voice_id_env: V, voice_revision: 1, instruction_mode: arbitrary }\n`],
  ])("rejects %s", async (_label, yaml) => {
    const dir = fixtureDir(yaml);
    try {
      await expect(loadVoices(path.join(dir, "voices.yaml"))).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveVoiceId", () => {
  const voices: VoicesConfig = { version: 3, profiles: {} };

  it("reads the env var for the voice id", () => {
    const binding = resolveVoiceBinding(
      { ...voices, profiles: { p: { semantic: { base_description: "", allowed_delivery: [], forbidden_delivery: [] }, providers: { dashscope: { model: "m", voice_id_env: "COSYVOICE_VOICE_SUYAO", voice_revision: 1, instruction_mode: "free" } } } } },
      "p",
      "dashscope",
    )!;
    expect(resolveVoiceId(binding, { COSYVOICE_VOICE_SUYAO: "cosyvoice-v3-flash-suyao-abc" })).toBe(
      "cosyvoice-v3-flash-suyao-abc",
    );
    expect(resolveVoiceId(binding, {})).toBeUndefined();
  });
});

describe("validateDashscopeEnv", () => {
  it("returns empty when all referenced vars are set", () => {
    const voices: VoicesConfig = {
      version: 3,
      profiles: {
        p: {
          semantic: { base_description: "", allowed_delivery: [], forbidden_delivery: [] },
          providers: { dashscope: { model: "m", voice_id_env: "V1", voice_revision: 1, instruction_mode: "free" } },
        },
      },
    };
    expect(validateDashscopeEnv(voices, { V1: "voice-1", DASHSCOPE_API_KEY: "k" })).toEqual([]);
  });

  it("lists missing voice envs (not the api key env — caller checks that)", () => {
    const voices: VoicesConfig = {
      version: 3,
      profiles: {
        a: { semantic: { base_description: "", allowed_delivery: [], forbidden_delivery: [] }, providers: { dashscope: { model: "m", voice_id_env: "VA", voice_revision: 1, instruction_mode: "free" } } },
        b: { semantic: { base_description: "", allowed_delivery: [], forbidden_delivery: [] }, providers: { dashscope: { model: "m", voice_id_env: "VB", voice_revision: 1, instruction_mode: "free" } } },
      },
    };
    const missing = validateDashscopeEnv(voices, { VA: "" });
    expect(missing.join(", ")).toContain("VA");
    expect(missing.join(", ")).toContain("VB");
  });

  it("flags a non-URL base override", () => {
    expect(validateDashscopeEnv({ version: 3, profiles: {} }, { DASHSCOPE_TTS_BASE_URL: "not-a-url" })).toHaveLength(1);
    expect(validateDashscopeEnv({ version: 3, profiles: {} }, { DASHSCOPE_TTS_BASE_URL: "https://example.com" })).toEqual([]);
  });
});
