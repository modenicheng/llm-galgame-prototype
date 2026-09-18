/**
 * voices.yaml loader — character voice profiles (V3, strict).
 *
 * Profiles are Node-side authoritative data. The browser never receives
 * provider model names, voice ids, or raw instructions — only the
 * compiled `AudioDescriptor` identity.
 *
 * V3 is strict: `version` must be exactly 3, and every object is
 * `.strict()` so any v2 leftover (voice_sources, voice_id, voice_source,
 * hot_fix) is a hard parse error. A dashscope binding is exactly
 * `model` + `voice_id_env`; voice ids come from the author's `.env`
 * (system voices, console-cloned voices, console-designed voices are all
 * just a voice-id string). `voice_revision` (default 1) invalidates
 * cached audio after re-cloning; `instruction_mode` (default "free")
 * selects the DashScope instruction format.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** DashScope instruction policy for a voice. */
export type InstructionMode = "free" | "fixed_emotion" | "none";

/** One provider binding inside a profile. */
export interface VoiceProviderBinding {
  model: string;
  /** Env var holding the effective voice-id (system / console-cloned / console-designed). */
  voice_id_env: string;
  /** Local bindings only: registry key in the local tts server (no env indirection). */
  voice?: string;
  /** Cache invalidation bump. Zod default 1 — always present after parse. */
  voice_revision: number;
  /** Instruction policy. Zod default "free" — always present after parse. */
  instruction_mode: InstructionMode;
}

/**
 * Local qwen3-tts binding: `voice` is a registry key in the local inference
 * server's voice registry (a machine-local asset, not a secret) — no .env
 * indirection.
 */
export interface LocalVoiceProviderBinding {
  model: "local-qwen3-tts";
  voice: string;
  /** Cache invalidation bump (bump after re-building the voice prompt). */
  voice_revision: number;
}

/** Semantic section of a profile (fed to the performance compiler). */
export interface VoiceSemantic {
  base_description: string;
  allowed_delivery: string[];
  forbidden_delivery: string[];
}

export interface VoiceProfile {
  semantic: VoiceSemantic;
  providers: {
    dashscope?: VoiceProviderBinding;
    local?: LocalVoiceProviderBinding;
  };
}

export interface VoicesConfig {
  version: 3;
  profiles: Record<string, VoiceProfile>;
}

const VoiceProviderBindingSchema = z
  .object({
    model: z.string().min(1),
    voice_id_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "voice_id_env must be an env var name"),
    voice_revision: z.number().int().nonnegative().default(1),
    instruction_mode: z.enum(["free", "fixed_emotion", "none"]).default("free"),
  })
  .strict();

const LocalVoiceProviderBindingSchema = z
  .object({
    model: z.literal("local-qwen3-tts"),
    voice: z.string().min(1),
    voice_revision: z.number().int().nonnegative().default(1),
  })
  .strict();

const VoiceProfileSchema = z
  .object({
    semantic: z
      .object({
        base_description: z.string().min(1),
        allowed_delivery: z.array(z.string()).default([]),
        forbidden_delivery: z.array(z.string()).default([]),
      })
      .strict(),
    providers: z
      .object({
        dashscope: VoiceProviderBindingSchema.optional(),
        local: LocalVoiceProviderBindingSchema.optional(),
      })
      .strict(),
  })
  .strict();

const VoicesConfigSchema = z
  .object({
    version: z.literal(3),
    profiles: z.record(z.string(), VoiceProfileSchema),
  })
  .strict();

export async function loadVoices(voicesPath = "voices.yaml"): Promise<VoicesConfig> {
  const absolutePath = path.resolve(voicesPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed: unknown = parse(raw);
  return VoicesConfigSchema.parse(parsed) as VoicesConfig;
}

/**
 * Resolve a profile binding for the configured provider; undefined if absent.
 * The local binding is normalized into the dashscope shape (voice_id_env left
 * empty; instruction_mode fixed to "none" — the local clone path takes no
 * per-request instructions) so downstream consumers stay polymorphic.
 */
export function resolveVoiceBinding(
  voices: VoicesConfig,
  profileId: string,
  provider: "dashscope" | "local",
): VoiceProviderBinding | undefined {
  const profile = voices.profiles[profileId];
  if (profile === undefined) return undefined;
  if (provider === "local") {
    const binding = profile.providers.local;
    if (binding === undefined) return undefined;
    return {
      model: binding.model,
      voice_id_env: "",
      voice: binding.voice,
      voice_revision: binding.voice_revision,
      instruction_mode: "none",
    };
  }
  return profile.providers.dashscope;
}

/**
 * Resolve the effective voice-id for a binding. DashScope ids come from the
 * environment — the author copies the id out of the Bailian console into
 * `.env`. Local bindings carry their registry key inline (`voice`).
 */
export function resolveVoiceId(
  binding: VoiceProviderBinding,
  env: Record<string, string | undefined>,
): string | undefined {
  if (binding.voice !== undefined) return binding.voice;
  return env[binding.voice_id_env];
}

/**
 * Startup validation (dashscope mode only): list every voice env var that
 * is missing or empty, and flag a non-URL base override. The caller
 * separately checks the API key env. Returns [] when everything is set.
 */
export function validateDashscopeEnv(
  voices: VoicesConfig,
  env: Record<string, string | undefined>,
): string[] {
  const missing: string[] = [];
  for (const [profileId, profile] of Object.entries(voices.profiles)) {
    const binding = profile.providers.dashscope;
    if (binding === undefined) continue;
    const value = env[binding.voice_id_env];
    if (value === undefined || value === "") {
      missing.push(`${binding.voice_id_env} (profile "${profileId}")`);
    }
  }
  const baseUrl = env.DASHSCOPE_TTS_BASE_URL;
  if (baseUrl !== undefined && !/^https?:\/\//.test(baseUrl)) {
    missing.push("DASHSCOPE_TTS_BASE_URL must be an http(s) URL");
  }
  return missing;
}

/** Fixed output rate of the local qwen3-tts server (s16le PCM). */
const LOCAL_QWEN3_TTS_SAMPLE_RATE = 24_000;

/**
 * Startup validation (local mode only): the local server emits fixed 24 kHz
 * PCM, so the global synthesis sample rate must match (the browser resamples
 * from the descriptor rate; a mismatch would skew playback). Voice keys
 * themselves are validated by the server (404 → provider error).
 */
export function validateLocalModelConfig(
  voices: VoicesConfig,
  sampleRate: number,
): string[] {
  const localProfileIds = Object.entries(voices.profiles)
    .filter(([, profile]) => profile.providers.local !== undefined)
    .map(([profileId]) => profileId);
  if (localProfileIds.length === 0 || sampleRate === LOCAL_QWEN3_TTS_SAMPLE_RATE) {
    return [];
  }
  return [
    `profiles [${localProfileIds.join(", ")}] 使用 local-qwen3-tts（固定 ${LOCAL_QWEN3_TTS_SAMPLE_RATE} Hz 输出）` +
      `，但 synthesis.sample_rate=${sampleRate}；请将 media.audio.synthesis.sample_rate 设为 ${LOCAL_QWEN3_TTS_SAMPLE_RATE}`,
  ];
}
