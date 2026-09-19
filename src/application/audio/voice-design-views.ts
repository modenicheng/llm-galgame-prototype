/**
 * 动态角色音频注入（角色音频特征设计 §4.1）：世界创建期落盘的编剧画像 →
 * AudioDescriptorFactory 可用的合并视图（roster 绑定基座 ⊕ 合成 profile ⊕
 * designs 索引）。纯函数；voices.yaml 保持 author 权威，只建只读视图、
 * 不回写。
 *
 * C7：config.characters 别名键兼容形状已移除——绑定基座 = roster 的
 * voiceProfileId（键恒为稳定 CharacterId；M1 语义），设计注入在其上叠加。
 */
import type { VoicesConfig } from "../../config/voices.js";
import type { CharacterVoiceDesign } from "../outline/outline-writer.js";
import type { VoiceDesignFile } from "../../adapters/storage/voice-design-store.js";
import { buildCharacterRoster } from "../../core/characters/registry.js";
import type { CharacterRoster } from "../../core/characters/types.js";

/** 动态角色共享的 dashscope 回退音色 env（部署侧选一个与 model_profile 配对的音色）。 */
export const DASHSCOPE_VOICE_FALLBACK_ENV = "DASHSCOPE_VOICE_FALLBACK";

/** 动态角色合成 profile 的 id 前缀（author profile 命名空间隔离）。 */
export const DESIGN_PROFILE_PREFIX = "design:";

export interface VoiceDesignViews {
  /** 稳定 CharacterId → 音色 profile 绑定（roster 基座 + 设计注入）。 */
  characters: Record<string, { name: string; voice_profile: string }>;
  voices: VoicesConfig;
  designs: Record<string, CharacterVoiceDesign>;
}

/** roster 成员检查（原型链安全：不走 record 索引）。 */
function rosterHas(roster: CharacterRoster, id: string): boolean {
  return roster.characters.some((definition) => definition.id === id);
}

export function mergeVoiceDesignViews(input: {
  /** M1 绑定基座：roster.voiceProfileId（按稳定 ID；缺省 = 无音色）。 */
  roster: CharacterRoster | undefined;
  authorVoices: VoicesConfig;
  designFile: VoiceDesignFile | undefined;
  /** 装配时工厂侧 provider 判别（disabled → mock 语义）。 */
  provider: "dashscope" | "local" | "mock";
  dashscopeModelProfile: string;
  /** dashscope 部署的共享回退音色 id（空 = 动态角色不注入、保持无声）。 */
  fallbackVoiceId: string;
}): VoiceDesignViews {
  // C7：绑定基座由 roster 派生（键 = CharacterId）；config.characters 退役。
  const characters: Record<string, { name: string; voice_profile: string }> = {};
  if (input.roster !== undefined) {
    for (const character of input.roster.characters) {
      if (character.voiceProfileId === undefined) continue;
      characters[character.id] = { name: character.name, voice_profile: character.voiceProfileId };
    }
  }
  const voices: VoicesConfig = { version: 3, profiles: { ...input.authorVoices.profiles } };
  const designs: Record<string, CharacterVoiceDesign> = {};
  if (input.designFile === undefined) {
    return { characters, voices, designs };
  }
  for (const [id, stored] of Object.entries(input.designFile.characters)) {
    designs[id] = stored.voice;
    // roster 内不存在的画像 ID 不注入绑定（工厂按 registry 寻址，注入了
    // 也永远命不中；保留画像索引供调色板/诊断）。
    if (input.roster === undefined || !rosterHas(input.roster, id)) continue;
    // dashscope 无共享回退音色 / local 无动态注册表键（V3 前身份缺口）→
    // 不注入：该角色走工厂 voiceless 降级保持无声；mock 语义下
    // resolveBinding 的 mock 分支自然兜住。
    if (input.provider === "local") continue;
    if (input.provider === "dashscope" && input.fallbackVoiceId === "") continue;
    const profileId = `${DESIGN_PROFILE_PREFIX}${id}`;
    characters[id] = { name: stored.name, voice_profile: profileId };
    voices.profiles[profileId] = {
      semantic: {
        base_description: stored.voice.timbre,
        allowed_delivery: stored.voice.delivery,
        forbidden_delivery: stored.voice.avoid ?? [],
      },
      providers:
        input.provider === "dashscope"
          ? {
              dashscope: {
                model: input.dashscopeModelProfile,
                voice_id_env: DASHSCOPE_VOICE_FALLBACK_ENV,
                voice_revision: 1,
                instruction_mode: "free",
              },
            }
          : {},
    };
  }
  return { characters, voices, designs };
}

/**
 * C7（main M1 绑定基座）：roster ⊕ 设计注入视图 → 工厂用 CharacterRoster。
 * 身份（ID/名牌/控制契约）与源 roster 一致，只为动态角色补
 * `voiceProfileId`（rosterFromCanonCharacters 的动态角色无绑定，绑定来自
 * 设计注入；静态 fallback 世界的绑定已在 characters.yaml）。键空间恒为
 * 稳定 CharacterId；revision 随绑定注入按 C2 规范重算。
 */
export function audioRosterFromViews(
  roster: CharacterRoster,
  views: VoiceDesignViews,
): CharacterRoster {
  const characters = roster.characters.map((definition) => {
    const injected = views.characters[definition.id]?.voice_profile;
    if (definition.voiceProfileId !== undefined || injected === undefined) return definition;
    return { ...definition, voiceProfileId: injected };
  });
  return buildCharacterRoster({
    schemaVersion: roster.schemaVersion,
    scopeId: roster.scopeId,
    playerId: roster.playerId,
    characters,
  });
}
