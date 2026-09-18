/**
 * 动态角色音频注入（角色音频特征设计 §4.1）：世界创建期落盘的编剧画像 →
 * AudioDescriptorFactory 可用的合并视图（characters ⊕ 合成 profile ⊕
 * designs 索引）。纯函数；voices.yaml 保持 author 权威，只建只读视图、
 * 不回写。
 */
import type { VoicesConfig } from "../../config/voices.js";
import type { CharacterVoiceDesign } from "../outline/outline-writer.js";
import type { VoiceDesignFile } from "../../adapters/storage/voice-design-store.js";

/** 动态角色共享的 dashscope 回退音色 env（部署侧选一个与 model_profile 配对的音色）。 */
export const DASHSCOPE_VOICE_FALLBACK_ENV = "DASHSCOPE_VOICE_FALLBACK";

/** 动态角色合成 profile 的 id 前缀（author profile 命名空间隔离）。 */
export const DESIGN_PROFILE_PREFIX = "design:";

export interface VoiceDesignViews {
  characters: Record<string, { name: string; voice_profile: string }>;
  voices: VoicesConfig;
  designs: Record<string, CharacterVoiceDesign>;
}

export function mergeVoiceDesignViews(input: {
  authorCharacters: Record<string, { name: string; voice_profile: string }>;
  authorVoices: VoicesConfig;
  designFile: VoiceDesignFile | undefined;
  /** 装配时工厂侧 provider 判别（disabled → mock 语义）。 */
  provider: "dashscope" | "local" | "mock";
  dashscopeModelProfile: string;
  /** dashscope 部署的共享回退音色 id（空 = 动态角色不注入、保持无声）。 */
  fallbackVoiceId: string;
}): VoiceDesignViews {
  const characters = { ...input.authorCharacters };
  const voices: VoicesConfig = { version: 3, profiles: { ...input.authorVoices.profiles } };
  const designs: Record<string, CharacterVoiceDesign> = {};
  if (input.designFile === undefined) {
    return { characters, voices, designs };
  }
  for (const [id, stored] of Object.entries(input.designFile.characters)) {
    designs[id] = stored.voice;
    // dashscope 无共享回退音色 / local 无动态注册表键（V3 前身份缺口）→
    // 不注入：该角色走工厂 no-character 路径保持无声；mock 语义下
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
