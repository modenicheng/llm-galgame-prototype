/**
 * AudioDescriptorFactory — turns a runtime playable event into the
 * authoritative `{ descriptor, recipe }` pair (§7.4, §11.2).
 *
 * The descriptor is the browser-visible identity (lineId, cacheKey, scope,
 * priority, speaker labels, format). The recipe holds everything the Node
 * synthesis pipeline needs and is never serialized to the browser: model,
 * voiceId (from the environment), voice revision, compiled performance
 * parameters, and the deterministic seed.
 */
import type { RuntimePlayableEvent } from "../../schema.js";
import type {
  AudioDescriptor,
  AudioPriority,
  AudioScope,
} from "../../shared/wire/audio-descriptor.js";
import type { InternalAudioRecipe } from "./internal-audio-recipe.js";
import { cacheKeyFromRecipe, type CacheKeyRecipe } from "./cache-key.js";
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
  characters: Record<string, { name: string; voice_profile: string }>;
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
   * 导演声音指导查询（角色音频特征设计 §4.2）：按说话人取当前场景的
   * VoiceDirectionTarget；缺省/未绑定 = 无指导。
   */
  voiceDirectionFor?: (speakerId: string) => VoiceDirectionTarget | undefined;
  /**
   * 编剧音频画像（角色音频特征设计 §4.1）：说话人 → 画像。delivery 与
   * author semantic 取并集进调色板，avoid 并进 forbidden，baseline 作
   * 表演先验；timbre 锚由装配层折进合成 profile 的 base_description。
   */
  voiceDesigns?: Record<string, CharacterVoiceDesign>;
}

export interface BuildAudioResult {
  descriptor: AudioDescriptor;
  recipe: InternalAudioRecipe;
}

/** Env var namespace for synthesized mock voice IDs. */
const MOCK_VOICE_ENV_PREFIX = "MOCK_VOICE_";

export class AudioDescriptorFactory {
  constructor(private readonly options: AudioDescriptorFactoryOptions) {}

  /**
   * Build the descriptor + recipe for one line.
   * Returns null when the event has no resolvable voice — narration has
   * no voice by design, and a speaker without a character profile is a
   * programming error at runtime.
   */
  build(
    event: RuntimePlayableEvent,
    scope: AudioScope,
    priority: AudioPriority,
    performance?: LinePerformance,
  ): BuildAudioResult | null {
    // Narration has no voice by design (no log — expected); a speaker
    // without a character/profile is an anomaly worth surfacing.
    if (event.type === "narration") return null;
    const character = this.resolveCharacter(event);
    if (!character) {
      ttsLog(
        "build-skip",
        event.line_id,
        `reason=no-character speaker=${event.speaker}`,
      );
      return null;
    }
    const profile = this.options.voices.profiles[character.voiceProfile];

    if (!profile) {
      ttsLog("build-skip", event.line_id, `reason=no-profile profile=${character.voiceProfile}`);
      return null;
    }

    const binding = this.resolveBinding(character.voiceProfile, character.speakerId);
    const voiceId = resolveVoiceId(binding, this.options.env) ?? "";
    // 指导/画像按 characters 命中键查（byName 回退时 speakerId 是显示名，
    // 查表键须用注册键，否则指导静默失效）。
    const direction = this.options.voiceDirectionFor?.(character.registryKey);
    const design = this.options.voiceDesigns?.[character.registryKey];
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
      `speaker=${character.displayName} model=${binding.model} voice=${voiceId} ` +
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
      descriptor: {
        lineId: event.line_id,
        cacheKey,
        scope,
        priority,
        speakerId: character.speakerId,
        displaySpeaker: character.displayName,
        format: {
          encoding: this.options.format,
          sampleRate: this.options.sampleRate,
          channels: 1,
        },
      },
      recipe,
    };
  }

  private resolveCharacter(
    event: RuntimePlayableEvent,
  ): { registryKey: string; voiceProfile: string; speakerId: string; displayName: string } | null {
    // Narration has no voice by design — only character lines are synthesized.
    if (event.type === "narration") return null;
    // Character identity comes from `characterId` when present (docs
    // llm-outputs-refactor.md §10/§67); legacy events fall back to the
    // display-name keyed mapping.
    const characterId = (event as { characterId?: string }).characterId;
    const byId = characterId !== undefined ? this.options.characters[characterId] : undefined;
    const bySpeaker = this.options.characters[event.speaker];
    const byNameEntry = Object.entries(this.options.characters).find(
      ([, c]) => c.name === event.speaker,
    );
    const character = byId ?? bySpeaker ?? byNameEntry?.[1];
    if (!character) return null;
    const registryKey =
      byId !== undefined
        ? (characterId as string)
        : bySpeaker !== undefined
          ? event.speaker
          : (byNameEntry?.[0] as string);
    return {
      registryKey,
      voiceProfile: character.voice_profile,
      speakerId: characterId ?? event.speaker,
      displayName: character.name,
    };
  }

  /**
   * Resolve the provider binding for a profile. When the configured
   * provider is "mock" (or the profile has no binding for the real
   * provider) a stable mock binding is synthesized so mock audio still
   * receives deterministic cache keys.
   */
  private resolveBinding(profileId: string, speakerId: string): VoiceProviderBinding {
    if (this.options.provider !== "mock") {
      const binding = resolveVoiceBinding(this.options.voices, profileId, this.options.provider);
      if (binding) return binding;
    }
    return {
      model: this.options.modelProfile,
      voice_id_env: `${MOCK_VOICE_ENV_PREFIX}${speakerId}`,
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
