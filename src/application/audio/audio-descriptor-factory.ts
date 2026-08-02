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
  type VoiceProviderBinding,
  type VoicesConfig,
} from "../../config/voices.js";
import type {
  CompiledPerformance,
  LinePerformance,
  PerformanceCompiler,
} from "./performance-compiler.js";

export interface AudioDescriptorFactoryOptions {
  characters: Record<string, { name: string; voice_profile: string }>;
  voices: VoicesConfig;
  provider: "dashscope" | "mock";
  /** Fallback model profile, e.g. "cosyvoice_v3_flash" (used for mock bindings). */
  modelProfile: string;
  sampleRate: number;
  format: "pcm_s16le";
  /** Voice ID lookup (e.g. process.env); never serialized to the browser. */
  env: Record<string, string | undefined>;
  compiler: PerformanceCompiler;
  /** Deterministic per-line seed (same line always synthesizes the same audio). */
  seedFor: (lineId: string) => number;
}

export interface BuildAudioResult {
  descriptor: AudioDescriptor;
  recipe: InternalAudioRecipe;
}

/** The narrator is addressed through the reserved character key "旁白". */
const NARRATOR_CHARACTER_KEY = "旁白";
/** Env var namespace for synthesized mock voice IDs. */
const MOCK_VOICE_ENV_PREFIX = "MOCK_VOICE_";

export class AudioDescriptorFactory {
  constructor(private readonly options: AudioDescriptorFactoryOptions) {}

  /**
   * Build the descriptor + recipe for one line.
   * Returns null when the event has no resolvable voice (no character
   * profile for the speaker, no 旁白 profile for narration).
   */
  build(
    event: RuntimePlayableEvent,
    scope: AudioScope,
    priority: AudioPriority,
    performance?: LinePerformance,
  ): BuildAudioResult | null {
    const character = this.resolveCharacter(event);
    if (!character) return null;

    const profile = this.options.voices.profiles[character.voiceProfile];
    if (!profile) return null;

    const binding = this.resolveBinding(character.voiceProfile, character.speakerId);
    const voiceId = this.options.env[binding.voice_id_env] ?? "<unset>";
    const compiled = this.options.compiler.compile({
      baseDescription: profile.semantic.base_description,
      allowedDelivery: profile.semantic.allowed_delivery,
      forbiddenDelivery: profile.semantic.forbidden_delivery,
      ...(performance !== undefined ? { performance } : {}),
    });

    const seed = this.options.seedFor(event.line_id);
    const cacheKey = cacheKeyFromRecipe(
      this.cacheKeyRecipe(binding, voiceId, event.text, compiled, seed),
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
  ): { voiceProfile: string; speakerId: string; displayName: string } | null {
    if (event.type === "narration") {
      const character = this.options.characters[NARRATOR_CHARACTER_KEY];
      if (!character) return null;
      return {
        voiceProfile: character.voice_profile,
        speakerId: "narrator",
        displayName: character.name,
      };
    }
    const character = this.options.characters[event.speaker];
    if (!character) return null;
    return {
      voiceProfile: character.voice_profile,
      speakerId: event.speaker,
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
