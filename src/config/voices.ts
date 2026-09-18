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
import { QWEN3_TTS_SAMPLE_RATE, ttsModelFamilyOf } from "../core/ports/tts-model-family.js";

/** DashScope instruction policy for a voice. */
export type InstructionMode = "free" | "fixed_emotion" | "none";

/** One provider binding inside a profile. */
export interface VoiceProviderBinding {
  model: string;
  /** Env var holding the effective voice-id (system / console-cloned / console-designed). */
  voice_id_env: string;
  /** Local bindings only: registry key in tts-server voices (no env indirection). */
  voice?: string;
  /** Cache invalidation bump. Zod default 1 — always present after parse. */
  voice_revision: number;
  /** Instruction policy. Zod default "free" — always present after parse. */
  instruction_mode: InstructionMode;
}

/**
 * Local qwen3-tts binding: `voice` is a registry key in the local inference
 * server (tts-server/voices/registry.json), not a secret — no .env indirection.
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
  const qwen3BaseUrl = env.DASHSCOPE_QWEN3_TTS_BASE_URL;
  if (qwen3BaseUrl !== undefined && !/^https?:\/\//.test(qwen3BaseUrl)) {
    missing.push("DASHSCOPE_QWEN3_TTS_BASE_URL must be an http(s) URL");
  }
  return missing;
}

/**
 * Startup validation (local mode only): every local binding exists and the
 * configured sample rate matches the server's fixed 24 kHz output. Voice
 * keys themselves are validated by the server (404 → provider error).
 */
export function validateLocalModelConfig(
  voices: VoicesConfig,
  sampleRate: number,
): string[] {
  const errors: string[] = [];
  for (const [profileId, profile] of Object.entries(voices.profiles)) {
    const binding = profile.providers.local;
    if (binding === undefined) continue;
    if (sampleRate !== QWEN3_TTS_SAMPLE_RATE) {
      errors.push(
        `profile "${profileId}" uses local-qwen3-tts（固定 ${QWEN3_TTS_SAMPLE_RATE} Hz 输出）` +
          `，但 synthesis.sample_rate=${sampleRate}；请将 media.audio.synthesis.sample_rate 设为 ${QWEN3_TTS_SAMPLE_RATE}`,
      );
    }
  }
  return errors;
}

/**
 * Startup validation (dashscope mode only): cross-check each binding's model
 * family against its voice id and the configured sample rate. Returns a list
 * of configuration errors; [] when consistent.
 *
 *  - Voice ids self-describe their family (cloned/designed ids embed the
 *    model prefix, e.g. `cosyvoice-v3-flash-suyao-xxxx` / qwen 复刻 id 以
 *    `qwen3-tts` 开头). DashScope does not accept voices across families.
 *  - qwen3-tts streams fixed 24 kHz PCM while the browser resamples from the
 *    global `synthesis.sample_rate` — cosyvoice supports 24 kHz, so a single
 *    consistent rate works for mixed deployments.
 */
export function validateDashscopeModelConfig(
  voices: VoicesConfig,
  env: Record<string, string | undefined>,
  sampleRate: number,
): string[] {
  const errors: string[] = [];
  for (const [profileId, profile] of Object.entries(voices.profiles)) {
    const binding = profile.providers.dashscope;
    if (binding === undefined) continue;
    const family = ttsModelFamilyOf(binding.model);
    if (family === "qwen3-tts" && sampleRate !== QWEN3_TTS_SAMPLE_RATE) {
      errors.push(
        `profile "${profileId}" uses qwen3-tts model "${binding.model}"（固定 ${QWEN3_TTS_SAMPLE_RATE} Hz 输出）` +
          `，但 synthesis.sample_rate=${sampleRate}；请将 media.audio.synthesis.sample_rate 设为 ${QWEN3_TTS_SAMPLE_RATE}` +
          `（cosyvoice 同样支持 24 kHz，可混布）`,
      );
    }
    const voiceId = env[binding.voice_id_env];
    if (voiceId === undefined || voiceId === "") continue;
    const voiceIsCosyvoice = voiceId.startsWith("cosyvoice");
    const voiceIsQwen3 = voiceId.startsWith("qwen3-tts");
    if (family === "qwen3-tts" && voiceIsCosyvoice) {
      errors.push(
        `profile "${profileId}"：模型 "${binding.model}" 属 qwen3-tts 族，但 voice-id "${voiceId.slice(0, 24)}…" 是 CosyVoice 复刻/设计音色——` +
          `两族音色不互用。请在百炼控制台对 qwen3-tts 系模型重新复刻/设计音色后更新 ${binding.voice_id_env}，` +
          `或将 model 改回 cosyvoice 系`,
      );
    }
    if (family === "cosyvoice" && voiceIsQwen3) {
      errors.push(
        `profile "${profileId}"：模型 "${binding.model}" 属 cosyvoice 族，但 voice-id 是 qwen3-tts 音色（"${voiceId.slice(0, 24)}…"）——` +
          `两族音色不互用。请将 model 改为对应的 qwen3-tts 模型，或更换 ${binding.voice_id_env} 为 cosyvoice 音色`,
      );
    }
  }
  return errors;
}
