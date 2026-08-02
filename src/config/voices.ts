/**
 * voices.yaml loader — character voice profiles (V2, §14.1).
 *
 * Profiles are Node-side authoritative data. The browser never receives
 * provider model names, voice IDs, or raw instructions — only the
 * compiled `AudioDescriptor` identity.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** One provider binding inside a profile. */
export interface VoiceProviderBinding {
  model: string;
  voice_id_env: string;
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
  };
}

export interface VoicesConfig {
  version: number;
  profiles: Record<string, VoiceProfile>;
}

const VoiceProviderBindingSchema = z.object({
  model: z.string().min(1),
  voice_id_env: z.string().min(1),
  voice_revision: z.number().int().nonnegative(),
});

const VoiceProfileSchema = z.object({
  semantic: z.object({
    base_description: z.string().min(1),
    allowed_delivery: z.array(z.string()).default([]),
    forbidden_delivery: z.array(z.string()).default([]),
  }),
  providers: z.object({
    dashscope: VoiceProviderBindingSchema.optional(),
  }),
});

const VoicesConfigSchema = z.object({
  version: z.number().int().default(2),
  profiles: z.record(z.string(), VoiceProfileSchema),
});

export async function loadVoices(voicesPath = "voices.yaml"): Promise<VoicesConfig> {
  const absolutePath = path.resolve(voicesPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed: unknown = parse(raw);
  return VoicesConfigSchema.parse(parsed) as VoicesConfig;
}

/** Resolve a profile binding for the configured provider; undefined if absent. */
export function resolveVoiceBinding(
  voices: VoicesConfig,
  profileId: string,
  provider: "dashscope",
): VoiceProviderBinding | undefined {
  return voices.profiles[profileId]?.providers[provider];
}
