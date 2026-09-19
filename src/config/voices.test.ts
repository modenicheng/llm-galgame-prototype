import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  loadVoices,
  resolveVoiceBinding,
  resolveVoiceId,
  validateDashscopeEnv,
  validateLocalModelConfig,
  VoicesConfigSchema,
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
    // C7（C2 safeRecord 模式）：自有 __proto__ / constructor / prototype
    // 数据键不得被 z.record 静默丢弃——在原始输入上显式拒绝（YAML 路径）。
    ["__proto__ profile key", `version: 3\nprofiles:\n  __proto__:\n    semantic: { base_description: x }\n    providers: {}\n`],
    ["constructor profile key", `version: 3\nprofiles:\n  constructor:\n    semantic: { base_description: x }\n    providers: {}\n`],
    ["prototype profile key", `version: 3\nprofiles:\n  prototype:\n    semantic: { base_description: x }\n    providers: {}\n`],
  ])("rejects %s", async (_label, yaml) => {
    const dir = fixtureDir(yaml);
    try {
      await expect(loadVoices(path.join(dir, "voices.yaml"))).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// profiles 键原型链安全（C2 safeRecord 模式，C7 接线）——schema 级
// ---------------------------------------------------------------------------

/**
 * JSON.parse 造出的自有 `__proto__` 数据键是真实输入面（wire/存储回读），
 * zod v4 的 z.record 不把它交给键 schema 校验而是静默丢弃——safeRecord
 * 必须在原始输入上拒绝。
 */
function profilesInputWithOwnKey(key: string): unknown {
  const raw = `{"version":3,"profiles":{"${key}":{"semantic":{"base_description":"x"},"providers":{}}}}`;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // 前置条件钉死：该键确为自有数据键（不是原型链成员）。
  expect(Object.keys(parsed.profiles as object)).toContain(key);
  return parsed;
}

describe("VoicesConfigSchema — safeRecord 原型链安全（C7）", () => {
  it("自有 __proto__ 数据键（JSON.parse 构造）被显式拒绝，不被 z.record 静默丢弃", () => {
    const input = profilesInputWithOwnKey("__proto__");
    expect(VoicesConfigSchema.safeParse(input).success).toBe(false);
    // 危险对照（钉住被防住的缺陷）：裸 z.record 会静默丢键后放行——
    // 正是 safeRecord 存在的理由。
    const plainRecord = z.record(z.string().min(1), z.any());
    expect(plainRecord.safeParse((input as { profiles: object }).profiles).success).toBe(true);
    expect(Object.keys(plainRecord.parse((input as { profiles: object }).profiles))).toEqual([]);
  });

  it("constructor / prototype 字面键同样在原始输入上拒绝", () => {
    for (const key of ["constructor", "prototype"]) {
      expect(VoicesConfigSchema.safeParse(profilesInputWithOwnKey(key)).success, key).toBe(false);
    }
  });

  it("合法键原样通过（passthrough 不受安全层影响）", () => {
    const parsed = VoicesConfigSchema.safeParse({
      version: 3,
      profiles: {
        suyao_main: {
          semantic: { base_description: "清亮少女声", allowed_delivery: ["gentle"], forbidden_delivery: [] },
          providers: {},
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data.profiles)).toEqual(["suyao_main"]);
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

  it("flags an empty base override (absent = undefined, empty = invalid)", () => {
    expect(validateDashscopeEnv({ version: 3, profiles: {} }, { DASHSCOPE_TTS_BASE_URL: "" })).toHaveLength(1);
  });
});

function voicesWithLocalBinding(): VoicesConfig {
  return {
    version: 3,
    profiles: {
      suyao_main: {
        semantic: { base_description: "", allowed_delivery: [], forbidden_delivery: [] },
        providers: {
          local: { model: "local-qwen3-tts", voice: "suyao", voice_revision: 1 },
          dashscope: { model: "cosyvoice-v3-flash", voice_id_env: "COSYVOICE_VOICE_SUYAO", voice_revision: 1, instruction_mode: "free" },
        },
      },
    },
  };
}

describe("local bindings", () => {
  it("parses a local binding with zod defaults expanded", async () => {
    const yaml = `version: 3
profiles:
  p:
    semantic: { base_description: x }
    providers:
      local: { model: local-qwen3-tts, voice: suyao }
`;
    const dir = fixtureDir(yaml);
    try {
      const voices = await loadVoices(path.join(dir, "voices.yaml"));
      expect(voices.profiles.p?.providers.local).toEqual({
        model: "local-qwen3-tts",
        voice: "suyao",
        voice_revision: 1, // default expanded
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a local binding with an unknown model literal", async () => {
    const yaml = `version: 3
profiles:
  p:
    semantic: { base_description: x }
    providers:
      local: { model: local-cosyvoice, voice: suyao }
`;
    const dir = fixtureDir(yaml);
    try {
      await expect(loadVoices(path.join(dir, "voices.yaml"))).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveVoiceBinding normalizes a local binding into the dashscope shape", () => {
    const binding = resolveVoiceBinding(voicesWithLocalBinding(), "suyao_main", "local")!;
    expect(binding).toEqual({
      model: "local-qwen3-tts",
      voice_id_env: "",
      voice: "suyao",
      voice_revision: 1,
      instruction_mode: "none",
    });
    // the dashscope view of the same profile is untouched
    const dashscope = resolveVoiceBinding(voicesWithLocalBinding(), "suyao_main", "dashscope")!;
    expect(dashscope.model).toBe("cosyvoice-v3-flash");
    expect(dashscope.voice).toBeUndefined();
  });

  it("returns undefined for an absent local binding or profile", () => {
    const voices = voicesWithLocalBinding();
    expect(resolveVoiceBinding(voices, "nope", "local")).toBeUndefined();
    expect(resolveVoiceBinding({ version: 3, profiles: { p: { semantic: { base_description: "", allowed_delivery: [], forbidden_delivery: [] }, providers: { dashscope: { model: "m", voice_id_env: "V", voice_revision: 1, instruction_mode: "free" } } } } }, "p", "local")).toBeUndefined();
  });

  it("resolveVoiceId prefers the inline registry key over the env lookup", () => {
    const binding = resolveVoiceBinding(voicesWithLocalBinding(), "suyao_main", "local")!;
    expect(resolveVoiceId(binding, { COSYVOICE_VOICE_SUYAO: "cosyvoice-xxx" })).toBe("suyao");
  });
});

describe("validateLocalModelConfig", () => {
  it("accepts the fixed 24000 Hz output rate and ignores dashscope-only profiles", () => {
    expect(validateLocalModelConfig(voicesWithLocalBinding(), 24000)).toEqual([]);
    const dashscopeOnly: VoicesConfig = {
      version: 3,
      profiles: {
        p: {
          semantic: { base_description: "", allowed_delivery: [], forbidden_delivery: [] },
          providers: { dashscope: { model: "cosyvoice-v3-flash", voice_id_env: "V", voice_revision: 1, instruction_mode: "free" } },
        },
      },
    };
    expect(validateLocalModelConfig(dashscopeOnly, 22050)).toEqual([]);
  });

  it("flags a sample rate mismatch naming the profile and the required rate", () => {
    const errors = validateLocalModelConfig(voicesWithLocalBinding(), 22050);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("suyao_main");
    expect(errors[0]).toContain("24000");
  });
});
