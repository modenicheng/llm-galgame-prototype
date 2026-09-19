/**
 * mergeVoiceDesignViews tests（角色音频特征设计 §4.1）：动态角色注入、
 * provider 相关的跳过语义、绑定基座（roster）不被改写。
 *
 * C7：绑定基座 = roster.voiceProfileId（config.characters 退役）；
 * audioRosterFromViews 为工厂补动态角色绑定（键恒为稳定 CharacterId）。
 * 评审轮 1（Ruling 12/R08）：设计画像与 roster 既有绑定冲突大声失败
 * （同 profile no-op、不同 profile 结构化报错）；工厂与导演调色板
 * （buildSpeakerPalette）从同一视图读到一致数据。
 */
import { describe, expect, it } from "vitest";
import {
  DASHSCOPE_VOICE_FALLBACK_ENV,
  DESIGN_PROFILE_PREFIX,
  VoiceDesignConflictError,
  audioRosterFromViews,
  buildSpeakerPalette,
  mergeVoiceDesignViews,
} from "./voice-design-views.js";
import type { VoicesConfig } from "../../config/voices.js";
import type { VoiceDesignFile } from "../../adapters/storage/voice-design-store.js";
import { buildCharacterRoster, createCharacterRegistry } from "../../core/characters/registry.js";
import type { CharacterRoster } from "../../core/characters/types.js";
import type { AssetCatalog } from "../../core/assets/types.js";
import { AudioDescriptorFactory } from "./audio-descriptor-factory.js";
import type { PerformanceCompiler } from "./performance-compiler.js";
import type { BuildAudioResult } from "./audio-descriptor-factory.js";
import type { RuntimePlayableEvent } from "../../schema.js";

const stubCompiler: PerformanceCompiler = {
  compile: () => ({ rate: 1, pitch: 1, volume: 1, pauseBeforeMs: 0, pauseAfterMs: 0 }),
};

const EMPTY_ASSETS: AssetCatalog = {
  guidance: "",
  backgrounds: {},
  bgm: {},
  soundEffects: {},
  spriteSets: {},
};

function dialogue(
  characterId: string,
  label: string,
  text: string,
  lineId: string,
): RuntimePlayableEvent {
  return { type: "dialogue", characterId, displayLabel: label, speaker: label, text, line_id: lineId };
}

function availableBuild(result: BuildAudioResult | null): Exclude<
  BuildAudioResult,
  { voiceAvailability: "unavailable" }
> {
  expect(result).not.toBeNull();
  expect(result!.voiceAvailability).toBe("available");
  return result as Exclude<BuildAudioResult, { voiceAvailability: "unavailable" }>;
}

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

  it("Ruling 12/R08：roster 已绑定角色被设计画像瞄准（不同 profile）→ 结构化报错，不静默覆盖", () => {
    // roster 的 suyao 已绑定 suyao_main；设计画像也瞄准 suyao——
    // 与部署 provider 无关（配置意图冲突在装配期大声失败，M1 parity）。
    for (const provider of ["dashscope", "local", "mock"] as const) {
      const roster = baseRoster();
      const designFile: VoiceDesignFile = {
        version: 1,
        characters: {
          ...DESIGN_FILE.characters,
          suyao: {
            name: "苏遥",
            voice: { timbre: "沙哑变声", delivery: ["cold"] },
          },
        },
      };
      const attempt = () =>
        mergeVoiceDesignViews({
          roster,
          authorVoices: AUTHOR_VOICES,
          designFile,
          provider,
          dashscopeModelProfile: "cosyvoice_v3_flash",
          fallbackVoiceId: provider === "dashscope" ? "Cherry" : "",
        });
      expect(attempt, `provider=${provider}`).toThrow(VoiceDesignConflictError);
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }
      const conflict = caught as VoiceDesignConflictError;
      // 结构化定位：错误码 + characterId + 两侧 profile 全部点名。
      expect(conflict.code).toBe("voice_design_conflict");
      expect(conflict.characterId).toBe("suyao");
      expect(conflict.rosterProfileId).toBe("suyao_main");
      expect(conflict.designProfileId).toBe("design:suyao");
      expect(conflict.message).toContain("suyao");
      expect(conflict.message).toContain("suyao_main");
      expect(conflict.message).toContain("design:suyao");
    }
  });

  it("Ruling 12/R08：同 profile → 无害 no-op（roster 绑定与 author profile 原样保留）", () => {
    // roster 已绑定 design:robot（author 在 voices.yaml 注册了该合成
    // profile）；设计画像同样瞄准 robot——同 profile 是无害重复，绑定与
    // author profile 都不被设计注入改写。
    const roster = buildCharacterRoster({
      schemaVersion: 2,
      scopeId: "views-same-profile",
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
          id: "robot",
          name: "旧终端",
          control: "npc",
          initialLabel: "旧终端",
          persona: "动态角色（roster 直接绑定合成 profile）。",
          voiceProfileId: "design:robot",
        },
      ],
    });
    const authorVoices: VoicesConfig = {
      version: 3,
      profiles: {
        ...AUTHOR_VOICES.profiles,
        "design:robot": {
          semantic: {
            base_description: "author 锚定的合成音色",
            allowed_delivery: ["restrained"],
            forbidden_delivery: [],
          },
          providers: {
            dashscope: {
              model: "cosyvoice-v2",
              voice_id_env: "ROBOT_VOICE_ID",
              voice_revision: 4,
              instruction_mode: "free",
            },
          },
        },
      },
    };
    const views = mergeVoiceDesignViews({
      roster,
      authorVoices,
      designFile: DESIGN_FILE,
      provider: "dashscope",
      dashscopeModelProfile: "cosyvoice_v3_flash",
      fallbackVoiceId: "Cherry",
    });
    // 绑定原样（roster 派生值），author profile 不被设计 timbre 覆盖。
    expect(views.characters.robot).toEqual({ name: "旧终端", voice_profile: "design:robot" });
    expect(views.voices.profiles["design:robot"]!.semantic.base_description).toBe(
      "author 锚定的合成音色",
    );
    expect(views.designs.robot).toBeDefined();

    // 工厂一致性：audioRosterFromViews 保留 roster 绑定 → 工厂按该
    // profile（author 注册的绑定）合成。
    const audioRoster = audioRosterFromViews(roster, views);
    expect(audioRoster.characters.find((d) => d.id === "robot")?.voiceProfileId).toBe(
      "design:robot",
    );
    const factory = new AudioDescriptorFactory({
      registry: createCharacterRegistry(audioRoster, EMPTY_ASSETS),
      voices: views.voices,
      provider: "dashscope",
      modelProfile: "cosyvoice_v3_flash",
      sampleRate: 22050,
      format: "pcm_s16le",
      env: { ROBOT_VOICE_ID: "robot-voice-004" },
      compiler: stubCompiler,
      seedFor: () => 7,
    });
    const built = availableBuild(
      factory.build(dialogue("robot", "旧终端", "系统自检完成。", "sp1"), { type: "active" }, "current"),
    );
    expect(built.recipe.voiceId).toBe("robot-voice-004");
    expect(built.recipe.model).toBe("cosyvoice-v2");
    expect(built.recipe.voiceRevision).toBe(4);
    expect(built.descriptor.speakerId).toBe("robot");
    // 调色板一致性：author profile semantic ⊕ 设计画像（同一视图）。
    const palette = buildSpeakerPalette(views)("robot");
    expect(palette?.allowedDelivery).toEqual(["restrained", "cold"]);
    expect(palette?.forbiddenDelivery).toEqual(["playful", "tearful"]);
  });

  it("评审轮 1：未绑定动态角色注入后，工厂与调色板读同一份视图数据", () => {
    // unbound-dynamic（roster 无绑定 + 画像注入）：工厂经
    // audioRosterFromViews 拿到注入绑定，调色板经 views.characters/
    // profiles/designs 读同一注入结果——两路一致。
    const roster = baseRoster();
    const views = mergeVoiceDesignViews({
      roster,
      authorVoices: AUTHOR_VOICES,
      designFile: DESIGN_FILE,
      provider: "dashscope",
      dashscopeModelProfile: "qwen3-tts-flash",
      fallbackVoiceId: "Cherry",
    });
    expect(views.characters.robot).toEqual({
      name: "旧终端",
      voice_profile: "design:robot",
    });

    const factory = new AudioDescriptorFactory({
      registry: createCharacterRegistry(audioRosterFromViews(roster, views), EMPTY_ASSETS),
      voices: views.voices,
      provider: "dashscope",
      modelProfile: "qwen3-tts-flash",
      sampleRate: 22050,
      format: "pcm_s16le",
      env: { [DASHSCOPE_VOICE_FALLBACK_ENV]: "Cherry" },
      compiler: stubCompiler,
      seedFor: () => 7,
    });
    const built = availableBuild(
      factory.build(dialogue("robot", "旧终端", "有人吗？", "ud1"), { type: "active" }, "current"),
    );
    expect(built.recipe.voiceId).toBe("Cherry");
    expect(built.recipe.model).toBe("qwen3-tts-flash");
    expect(built.descriptor.speakerId).toBe("robot");

    // 调色板读到注入 profile 的 semantic（= 设计画像派生）∪ 设计画像。
    const palette = buildSpeakerPalette(views)("robot");
    expect(palette?.allowedDelivery).toEqual(["cold", "restrained"]);
    expect(palette?.forbiddenDelivery).toEqual(["playful", "tearful"]);
    // 静态角色（无画像）：调色板仍从 roster 绑定的 author profile 读。
    expect(buildSpeakerPalette(views)("suyao")?.allowedDelivery).toEqual(["gentle"]);
    expect(buildSpeakerPalette(views)("suyao")?.forbiddenDelivery).toEqual(["cold"]);
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
