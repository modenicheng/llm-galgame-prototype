/**
 * mergeVoiceDesignViews tests（角色音频特征设计 §4.1）：动态角色注入、
 * provider 相关的跳过语义、author 视图不被改写。
 */
import { describe, expect, it } from "vitest";
import {
  DASHSCOPE_VOICE_FALLBACK_ENV,
  DESIGN_PROFILE_PREFIX,
  mergeVoiceDesignViews,
} from "./voice-design-views.js";
import type { VoicesConfig } from "../../config/voices.js";
import type { VoiceDesignFile } from "../../adapters/storage/voice-design-store.js";

const AUTHOR_VOICES: VoicesConfig = {
  version: 3,
  profiles: {
    suyao_main: {
      semantic: {
        base_description: "author 锚",
        allowed_delivery: ["gentle"],
        forbidden_delivery: ["cold"],
      },
      providers: {},
    },
  },
};

const AUTHOR_CHARACTERS = {
  suyao: { name: "苏遥", voice_profile: "suyao_main" },
};

const DESIGN_FILE: VoiceDesignFile = {
  version: 1,
  characters: {
    robot: {
      name: "旧终端",
      voice: {
        timbre: "电子合成音，平淡无起伏",
        delivery: ["cold", "restrained"],
        avoid: ["playful", "tearful"],
        baseline: { energy: "low" },
      },
    },
  },
};

describe("mergeVoiceDesignViews", () => {
  it("injects designed characters under mock semantics without env", () => {
    const views = mergeVoiceDesignViews({
      authorCharacters: AUTHOR_CHARACTERS,
      authorVoices: AUTHOR_VOICES,
      designFile: DESIGN_FILE,
      provider: "mock",
      dashscopeModelProfile: "cosyvoice_v3_flash",
      fallbackVoiceId: "",
    });
    expect(views.characters.robot).toEqual({
      name: "旧终端",
      voice_profile: `${DESIGN_PROFILE_PREFIX}robot`,
    });
    const profile = views.voices.profiles[`${DESIGN_PROFILE_PREFIX}robot`];
    expect(profile?.semantic.base_description).toBe("电子合成音，平淡无起伏");
    expect(profile?.semantic.allowed_delivery).toEqual(["cold", "restrained"]);
    expect(profile?.semantic.forbidden_delivery).toEqual(["playful", "tearful"]);
    expect(views.designs.robot?.baseline).toEqual({ energy: "low" });
    // author 视图不被改写
    expect(views.characters.suyao).toEqual(AUTHOR_CHARACTERS.suyao);
    expect(views.voices.profiles.suyao_main?.semantic.base_description).toBe("author 锚");
  });

  it("injects under dashscope only when the fallback voice env is set", () => {
    const base = {
      authorCharacters: AUTHOR_CHARACTERS,
      authorVoices: AUTHOR_VOICES,
      designFile: DESIGN_FILE,
      dashscopeModelProfile: "qwen3-tts-flash",
    };
    const without = mergeVoiceDesignViews({ ...base, provider: "dashscope", fallbackVoiceId: "" });
    expect(without.characters.robot).toBeUndefined();
    expect(without.designs.robot).toBeDefined(); // 画像索引仍建（调色板可用）

    const withVoice = mergeVoiceDesignViews({ ...base, provider: "dashscope", fallbackVoiceId: "Cherry" });
    const profile = withVoice.voices.profiles[`${DESIGN_PROFILE_PREFIX}robot`];
    expect(profile?.providers.dashscope).toEqual({
      model: "qwen3-tts-flash",
      voice_id_env: DASHSCOPE_VOICE_FALLBACK_ENV,
      voice_revision: 1,
      instruction_mode: "free",
    });
  });

  it("skips injection under local (identity gap until V3) but keeps the design index", () => {
    const views = mergeVoiceDesignViews({
      authorCharacters: AUTHOR_CHARACTERS,
      authorVoices: AUTHOR_VOICES,
      designFile: DESIGN_FILE,
      provider: "local",
      dashscopeModelProfile: "cosyvoice_v3_flash",
      fallbackVoiceId: "",
    });
    expect(views.characters.robot).toBeUndefined();
    expect(views.designs.robot).toBeDefined();
  });

  it("returns author-equivalent views when the world has no design file", () => {
    const views = mergeVoiceDesignViews({
      authorCharacters: AUTHOR_CHARACTERS,
      authorVoices: AUTHOR_VOICES,
      designFile: undefined,
      provider: "dashscope",
      dashscopeModelProfile: "cosyvoice_v3_flash",
      fallbackVoiceId: "Cherry",
    });
    expect(views.characters).toEqual(AUTHOR_CHARACTERS);
    expect(views.voices.profiles).toEqual(AUTHOR_VOICES.profiles);
    expect(views.designs).toEqual({});
  });
});
