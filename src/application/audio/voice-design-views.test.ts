/**
 * mergeVoiceDesignViews tests（角色音频特征设计 §4.1）：动态角色注入、
 * provider 相关的跳过语义、绑定基座（roster）不被改写。
 *
 * C7：绑定基座 = roster.voiceProfileId（config.characters 退役）；
 * audioRosterFromViews 为工厂补动态角色绑定（键恒为稳定 CharacterId）。
 */
import { describe, expect, it } from "vitest";
import {
  DASHSCOPE_VOICE_FALLBACK_ENV,
  DESIGN_PROFILE_PREFIX,
  audioRosterFromViews,
  mergeVoiceDesignViews,
} from "./voice-design-views.js";
import type { VoicesConfig } from "../../config/voices.js";
import type { VoiceDesignFile } from "../../adapters/storage/voice-design-store.js";
import { buildCharacterRoster } from "../../core/characters/registry.js";
import type { CharacterRoster } from "../../core/characters/types.js";

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

/** 绑定基座 roster：suyao（静态绑定）+ robot（动态角色，无绑定）。 */
function baseRoster(): CharacterRoster {
  return buildCharacterRoster({
    schemaVersion: 2,
    scopeId: "views-test",
    playerId: "player_one",
    characters: [
      {
        id: "player_one",
        name: "玩家",
        control: "player",
        initialLabel: "你",
        persona: "玩家本人。",
      },
      {
        id: "suyao",
        name: "苏遥",
        control: "npc",
        initialLabel: "苏遥",
        persona: "静态角色。",
        voiceProfileId: "suyao_main",
      },
      {
        id: "robot",
        name: "旧终端",
        control: "npc",
        initialLabel: "旧终端",
        persona: "动态角色（无静态绑定）。",
      },
    ],
  });
}

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
      roster: baseRoster(),
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
    // roster 绑定基座不被改写（键 = 稳定 CharacterId）。
    expect(views.characters.suyao).toEqual({ name: "苏遥", voice_profile: "suyao_main" });
    expect(views.voices.profiles.suyao_main?.semantic.base_description).toBe("author 锚");
  });

  it("injects under dashscope only when the fallback voice env is set", () => {
    const base = {
      roster: baseRoster(),
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
      roster: baseRoster(),
      authorVoices: AUTHOR_VOICES,
      designFile: DESIGN_FILE,
      provider: "local",
      dashscopeModelProfile: "cosyvoice_v3_flash",
      fallbackVoiceId: "",
    });
    expect(views.characters.robot).toBeUndefined();
    expect(views.designs.robot).toBeDefined();
  });

  it("returns roster-equivalent views when the world has no design file", () => {
    const views = mergeVoiceDesignViews({
      roster: baseRoster(),
      authorVoices: AUTHOR_VOICES,
      designFile: undefined,
      provider: "dashscope",
      dashscopeModelProfile: "cosyvoice_v3_flash",
      fallbackVoiceId: "Cherry",
    });
    expect(views.characters).toEqual({ suyao: { name: "苏遥", voice_profile: "suyao_main" } });
    expect(views.voices.profiles).toEqual(AUTHOR_VOICES.profiles);
    expect(views.designs).toEqual({});
  });

  it("roster 缺席（legacy 世界）不注入绑定，画像索引仍建", () => {
    const views = mergeVoiceDesignViews({
      roster: undefined,
      authorVoices: AUTHOR_VOICES,
      designFile: DESIGN_FILE,
      provider: "mock",
      dashscopeModelProfile: "cosyvoice_v3_flash",
      fallbackVoiceId: "",
    });
    expect(views.characters).toEqual({});
    expect(views.designs.robot).toBeDefined();
  });
});

describe("audioRosterFromViews — 工厂绑定派生（C7）", () => {
  it("动态角色按稳定 ID 补 voiceProfileId；静态绑定与无绑定角色不动", () => {
    const roster = baseRoster();
    const views = mergeVoiceDesignViews({
      roster,
      authorVoices: AUTHOR_VOICES,
      designFile: DESIGN_FILE,
      provider: "mock",
      dashscopeModelProfile: "cosyvoice_v3_flash",
      fallbackVoiceId: "",
    });
    const audioRoster = audioRosterFromViews(roster, views);
    const byId = new Map(audioRoster.characters.map((definition) => [definition.id, definition]));
    // 动态角色：注入合成 profile 绑定（键 = 稳定 ID）。
    expect(byId.get("robot")?.voiceProfileId).toBe(`${DESIGN_PROFILE_PREFIX}robot`);
    // 静态角色：roster 绑定原样（不覆盖）。
    expect(byId.get("suyao")?.voiceProfileId).toBe("suyao_main");
    // 玩家/无绑定且未注入：保持无绑定（工厂走 voiceless 降级）。
    expect(byId.get("player_one")?.voiceProfileId).toBeUndefined();
    // 身份字段不变（改名/控制契约/名牌快照与源 roster 一致）。
    expect(byId.get("robot")?.initialLabel).toBe("旧终端");
    expect(byId.get("robot")?.control).toBe("npc");
  });

  it("注入被 provider 跳过时（local）动态角色保持无绑定", () => {
    const roster = baseRoster();
    const views = mergeVoiceDesignViews({
      roster,
      authorVoices: AUTHOR_VOICES,
      designFile: DESIGN_FILE,
      provider: "local",
      dashscopeModelProfile: "cosyvoice_v3_flash",
      fallbackVoiceId: "",
    });
    const audioRoster = audioRosterFromViews(roster, views);
    const robot = audioRoster.characters.find((definition) => definition.id === "robot");
    expect(robot?.voiceProfileId).toBeUndefined();
  });
});
