/**
 * AudioDescriptorFactory — turns a runtime playable event into the
 * authoritative `{ descriptor, recipe }` pair (§7.4, §11.2).
 *
 * C7（计划 §6.1）：音频身份只按稳定 CharacterId 定位——factory 消费
 * C2 CharacterRegistry，不再按 speaker/name 查配置表。`speakerId` 恒为
 * roster 角色 ID，`displaySpeaker` 是该条事件的 label 快照（只进用户可见
 * 描述，不进 speakerId、不进缓存键）。兼容查表（旧 scriptName → 稳定 ID）
 * 集中在 legacy-identity 解析器（scoped、versioned），不散落在本 factory。
 * 导演声音指导（voiceDirectionFor）与编剧画像（voiceDesigns）同样严格按
 * 稳定 characterId 查询（R18：导演侧键的严格校验属 M2，factory 只保证
 * 不按显示名寻址）。
 *
 * 声音不可用是可观测降级，不是身份解析失败：profile 缺失 / provider 无
 * 绑定 / 无音色角色 / 旧事件身份无法解析时返回显式
 * `voiceAvailability: "unavailable"` 诊断，文字照常播放，registry 不动。
 *
 * The descriptor is the browser-visible identity (lineId, cacheKey, scope,
 * priority, speaker labels, format). The recipe holds everything the Node
 * synthesis pipeline needs and is never serialized to the browser: model,
 * voiceId (from the environment), voice revision, compiled performance
 * parameters, and the deterministic seed.
 */
import type {
  RuntimeNarrationEvent,
  RuntimePlayableEvent,
} from "../../schema.js";
import type {
  AudioDescriptor,
  AudioPriority,
  AudioScope,
} from "../../shared/wire/audio-descriptor.js";
import type { InternalAudioRecipe } from "./internal-audio-recipe.js";
import { cacheKeyFromRecipe, type CacheKeyRecipe } from "./cache-key.js";
import type { CharacterId, CharacterRegistry } from "../../core/characters/types.js";
import type { LegacyIdentityResolver } from "../../core/characters/legacy-identity.js";
import {
  resolveVoiceBinding,
  resolveVoiceId,
  type VoiceProviderBinding,
  type VoicesConfig,
} from "../../config/voices.js";
import type {
  CompiledPerformance,
  LinePerformance,
  PerformanceCompiler,
  VoiceDirectionTarget,
} from "./performance-compiler.js";
import type { CharacterVoiceDesign } from "../outline/outline-writer.js";
import { ttsLog } from "./tts-log.js";

export interface AudioDescriptorFactoryOptions {
  /**
   * 身份真源（C2 CharacterRegistry）：按稳定 CharacterId 解析角色与
   * `voiceProfileId` 绑定。bootstrap 注入与 writer/game 同源的 roster
   *（main M1：动态世界角色由绑定基座补 voiceProfileId 后派生音频视图，
   * 键空间仍是稳定 CharacterId——见 voice-design-views）。
   */
  registry: CharacterRegistry;
  /**
   * 兼容边界（C7 集中点）：缺 `characterId` 的旧事件经 legacy 解析器
   * （scoped、versioned，见 core/characters/legacy-identity.ts）映射到
   * 稳定 ID。新生成路径的事件一律携带 characterId，不经过这里；resolver
   * 缺席时旧事件按「身份无法解析」降级，绝不按名牌猜一个新角色。
   */
  legacyResolver?: LegacyIdentityResolver;
  voices: VoicesConfig;
  provider: "dashscope" | "local" | "mock";
  /** Fallback model profile, e.g. "cosyvoice_v3_flash" (used for mock bindings). */
  modelProfile: string;
  sampleRate: number;
  format: "pcm_s16le";
  /** Voice ID lookup (e.g. process.env); never serialized to the browser. */
  env: Record<string, string | undefined>;
  compiler: PerformanceCompiler;
  /** Deterministic per-line seed (same line always synthesizes the same audio). */
  seedFor: (lineId: string) => number;
  /**
   * 导演声音指导查询（角色音频特征设计 §4.2）：按稳定 characterId 取
   * 当前场景的 VoiceDirectionTarget；缺省/未绑定 = 无指导。显示名/
   * 名牌不作为查询键（R18 的导演侧键校验属 M2）。
   */
  voiceDirectionFor?: (characterId: string) => VoiceDirectionTarget | undefined;
  /**
   * 编剧音频画像（角色音频特征设计 §4.1）：稳定 characterId → 画像。
   * delivery 与 author semantic 取并集进调色板，avoid 并进 forbidden，
   * baseline 作表演先验；timbre 锚由装配层折进合成 profile 的
   * base_description。
   */
  voiceDesigns?: Record<string, CharacterVoiceDesign>;
}

/** 成功构建：descriptor（浏览器可见身份）+ recipe（Node 合成参数）。 */
export interface AvailableAudioBuild {
  voiceAvailability: "available";
  descriptor: AudioDescriptor;
  recipe: InternalAudioRecipe;
}

/** 声音不可用的降级原因（身份不受影响，文字照播）。 */
export type VoiceUnavailabilityReason =
  /** 旧事件缺 characterId 且 legacy 解析器缺席/无法解析——不猜姓名。 */
  | "unresolved_speaker"
  /** 事件携带的 characterId 不在本局 roster——不静默新建身份。 */
  | "unknown_character"
  /** roster 角色无 voiceProfileId（玩家、无音色 NPC 合法）。 */
  | "voiceless_character"
  /** voiceProfileId 指向 voices.yaml 中不存在的 profile（配置错误）。 */
  | "missing_profile"
  /** 非 mock provider 在该 profile 没有绑定（DashScope/local 缺 fallback）。 */
  | "missing_provider_binding";

/** 可观测降级：结构化诊断 + 明确的「文字继续播放」语义。 */
export interface UnavailableAudioBuild {
  voiceAvailability: "unavailable";
  reason: VoiceUnavailabilityReason;
  /** 人类可读诊断（含角色 ID / profile / provider 定位）。 */
  diagnostic: string;
  descriptor?: undefined;
  recipe?: undefined;
}

export type BuildAudioResult = AvailableAudioBuild | UnavailableAudioBuild;

/** Env var namespace for synthesized mock voice IDs. */
const MOCK_VOICE_ENV_PREFIX = "MOCK_VOICE_";

export class AudioDescriptorFactory {
  constructor(private readonly options: AudioDescriptorFactoryOptions) {}

  /**
   * Build the descriptor + recipe for one line.
   *
   * - `null` ⟺ narration：旁白无语音是设计（不产生任何诊断）。
   * - `voiceAvailability: "unavailable"` ⟺ 可观测降级：该行文字照常
   *   播放，只是没有合成音频；诊断给出可定位原因。
   * - `voiceAvailability: "available"` ⟺ 正常 descriptor + recipe。
   */
  build(
    event: RuntimePlayableEvent,
    scope: AudioScope,
    priority: AudioPriority,
    performance?: LinePerformance,
  ): BuildAudioResult | null {
    // Narration has no voice by design (no log — expected).
    if (event.type === "narration") return null;

    const resolved = this.resolveIdentity(event);
    if (resolved.characterId === null) {
      return this.unavailable(event, resolved.reason!, resolved.diagnostic!);
    }
    const characterId = resolved.characterId;
    const label = resolved.label;
    const definition = this.options.registry.get(characterId);
    if (definition === undefined) {
      return this.unavailable(
        event,
        "unknown_character",
        `characterId=${characterId} 不在本局 roster（scopeId=${this.options.registry.roster.scopeId}）；` +
          `不静默新建身份，本行按无语音文字播放`,
      );
    }
    // 无音色角色合法（缺资源不丢失身份，§6.1）：玩家台词、voiceless NPC。
    const voiceProfileId = definition.voiceProfileId;
    if (voiceProfileId === undefined) {
      return this.unavailable(
        event,
        "voiceless_character",
        `characterId=${characterId}（${definition.control}）无 voiceProfileId 绑定；` +
          `无音色角色照常说话（文字播放），身份保留`,
      );
    }
    const profile = this.options.voices.profiles[voiceProfileId];
    if (profile === undefined) {
      return this.unavailable(
        event,
        "missing_profile",
        `characterId=${characterId} 绑定的音色 profile "${voiceProfileId}" 不存在于 voices.yaml；` +
          `请补齐 profile 或修正角色名册的 voiceProfileId`,
      );
    }

    const binding = this.resolveBinding(voiceProfileId, characterId);
    if (binding === null) {
      return this.unavailable(
        event,
        "missing_provider_binding",
        `profile "${voiceProfileId}"（characterId=${characterId}）在 provider ` +
          `"${this.options.provider}" 下没有绑定且无 fallback；本行按无语音文字播放，` +
          `不从 registry 删除角色`,
      );
    }
    const voiceId = resolveVoiceId(binding, this.options.env) ?? "";
    // 指导/画像严格按稳定 characterId 查（C7/R18：显示名不是查询键；
    // 导演侧对 voice 键的严格校验属 M2，这里只保证工厂侧 ID 语义）。
    const direction = this.options.voiceDirectionFor?.(characterId);
    const design = this.options.voiceDesigns?.[characterId];
    // design 并集在此是通用路径：既覆盖注入角色（合成 profile 已含 design，
    // filterDelivery 去重兜底），也覆盖 author 混合角色与注入被跳过
    // （local / 无 fallback env）时 design id 撞 author 键的边缘。
    const compiled = this.options.compiler.compile({
      baseDescription: profile.semantic.base_description,
      allowedDelivery:
        design !== undefined
          ? [...profile.semantic.allowed_delivery, ...design.delivery]
          : profile.semantic.allowed_delivery,
      forbiddenDelivery:
        design?.avoid !== undefined
          ? [...profile.semantic.forbidden_delivery, ...design.avoid]
          : profile.semantic.forbidden_delivery,
      instructionMode: binding.instruction_mode,
      ...(performance !== undefined ? { performance } : {}),
      ...(direction !== undefined ? { direction } : {}),
      ...(design?.baseline !== undefined ? { baseline: design.baseline } : {}),
    });

    const seed = this.options.seedFor(event.line_id);
    const cacheKey = cacheKeyFromRecipe(
      this.cacheKeyRecipe(binding, voiceId, event.text, compiled, seed),
    );
    ttsLog(
      "build",
      event.line_id,
      `speakerId=${characterId} label=${label} model=${binding.model} voice=${voiceId} ` +
        `rev=${binding.voice_revision} mode=${binding.instruction_mode} cache=${cacheKey.slice(0, 8)}`,
    );

    const recipe: InternalAudioRecipe = {
      lineId: event.line_id,
      cacheKey,
      text: event.text,
      model: binding.model,
      voiceId,
      voiceRevision: binding.voice_revision,
      rate: compiled.rate,
      pitch: compiled.pitch,
      volume: compiled.volume,
      pauseBeforeMs: compiled.pauseBeforeMs,
      pauseAfterMs: compiled.pauseAfterMs,
      seed,
    };
    if (compiled.instruction !== undefined) {
      recipe.instruction = compiled.instruction;
    }

    return {
      voiceAvailability: "available",
      descriptor: {
        lineId: event.line_id,
        cacheKey,
        scope,
        priority,
        speakerId: characterId,
        displaySpeaker: label,
        format: {
          encoding: this.options.format,
          sampleRate: this.options.sampleRate,
          channels: 1,
        },
      },
      recipe,
    };
  }

  /**
   * 身份解析（§6.1）：新路径只认事件携带的 characterId；旧事件（缺
   * characterId）走注入的 legacy 解析器——compat 查表集中于此，不在
   * build 主路径里散落 bySpeaker/byName 兜底。label 恒为该条事件的
   * 名牌快照（严格事件读 displayLabel，旧形状读 speaker），只用于展示。
   */
  private resolveIdentity(
    event: Exclude<RuntimePlayableEvent, RuntimeNarrationEvent>,
  ):
    | { characterId: CharacterId; label: string }
    | { characterId: null; reason: VoiceUnavailabilityReason; diagnostic: string } {
    if (event.type === "player_dialogue") {
      // 玩家话语由运行时创建；玩家通常无音色绑定，按无 voiceProfileId
      // 角色走 voiceless 降级（roster 内玩家 ID 仍可解析）。
      return { characterId: this.options.registry.roster.playerId, label: event.speaker };
    }
    const label =
      "displayLabel" in event && typeof event.displayLabel === "string"
        ? event.displayLabel
        : event.speaker;
    const ownId = "characterId" in event ? (event as { characterId?: unknown }).characterId : undefined;
    if (typeof ownId === "string" && ownId !== "") {
      return { characterId: ownId, label };
    }
    // 兼容边界：旧事件没有 characterId——只有 legacy 解析器唯一命中才
    // 归因（scoped、versioned）；同名多义/完全未知都不猜。
    const legacy = this.options.legacyResolver;
    if (legacy === undefined) {
      return {
        characterId: null,
        reason: "unresolved_speaker",
        diagnostic: `事件缺 characterId 且未装配 legacy 身份解析器（speaker=${JSON.stringify(label)}）；` +
          `新生成路径的事件必须携带 roster 角色 ID`,
      };
    }
    const resolution = legacy.resolveScriptName(event.speaker);
    if (resolution.status === "resolved") {
      return { characterId: resolution.characterId, label };
    }
    return {
      characterId: null,
      reason: "unresolved_speaker",
      diagnostic: `旧事件身份无法解析（speaker=${JSON.stringify(event.speaker)}，scopeId=${legacy.scope.scopeId}）：${resolution.diagnostic}`,
    };
  }

  private unavailable(
    event: RuntimePlayableEvent,
    reason: VoiceUnavailabilityReason,
    diagnostic: string,
  ): UnavailableAudioBuild {
    ttsLog("build-skip", event.line_id, `voice_availability=unavailable reason=${reason}`);
    return { voiceAvailability: "unavailable", reason, diagnostic };
  }

  /**
   * Resolve the provider binding for a profile. Provider "mock" synthesizes a
   * stable mock binding so mock audio still receives deterministic cache keys
   * (voice keyed by the stable characterId); a real provider with no binding
   * is an observable degradation（C7：不再是静默 mock 兜底）.
   */
  private resolveBinding(profileId: string, characterId: CharacterId): VoiceProviderBinding | null {
    if (this.options.provider !== "mock") {
      return resolveVoiceBinding(this.options.voices, profileId, this.options.provider) ?? null;
    }
    return {
      model: this.options.modelProfile,
      voice_id_env: `${MOCK_VOICE_ENV_PREFIX}${characterId}`,
      voice_revision: 0,
      instruction_mode: "none",
    };
  }

  private cacheKeyRecipe(
    binding: VoiceProviderBinding,
    voiceId: string,
    text: string,
    compiled: CompiledPerformance,
    seed: number,
  ): CacheKeyRecipe {
    const recipe: CacheKeyRecipe = {
      provider: this.options.provider,
      model: binding.model,
      voiceId,
      voiceRevision: binding.voice_revision,
      text,
      rate: compiled.rate,
      pitch: compiled.pitch,
      volume: compiled.volume,
      seed,
      format: this.options.format,
      sampleRate: this.options.sampleRate,
    };
    if (compiled.instruction !== undefined) {
      recipe.compiledInstruction = compiled.instruction;
    }
    if (compiled.pauseBeforeMs > 0) {
      recipe.pauseBeforeMs = compiled.pauseBeforeMs;
    }
    if (compiled.pauseAfterMs > 0) {
      recipe.pauseAfterMs = compiled.pauseAfterMs;
    }
    return recipe;
  }
}
