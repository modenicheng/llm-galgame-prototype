/**
 * cacheKey — stable audio identity for a synthesis recipe.
 *
 * cacheKey = SHA-256 of every parameter that affects the produced audio.
 * The browser treats it as an opaque string; it can never recompute it
 * from provider parameters (it doesn't have them).
 */
import { createHash } from "node:crypto";

export interface CacheKeyRecipe {
  provider: string;
  model: string;
  voiceId: string;
  voiceRevision: number;
  text: string;
  /** Compiled instruction (may be undefined → excluded from digest). */
  compiledInstruction?: string;
  rate: number;
  pitch: number;
  volume: number;
  seed: number;
  format: string;
  sampleRate: number;
}

export function cacheKeyFromRecipe(recipe: CacheKeyRecipe): string {
  const hash = createHash("sha256");
  hash.update(recipe.provider);
  hash.update("\u0000");
  hash.update(recipe.model);
  hash.update("\u0000");
  hash.update(recipe.voiceId);
  hash.update("\u0000");
  hash.update(String(recipe.voiceRevision));
  hash.update("\u0000");
  hash.update(recipe.text);
  hash.update("\u0000");
  if (recipe.compiledInstruction !== undefined) {
    hash.update(recipe.compiledInstruction);
    hash.update("\u0000");
  }
  hash.update(String(recipe.rate));
  hash.update("\u0000");
  hash.update(String(recipe.pitch));
  hash.update("\u0000");
  hash.update(String(recipe.volume));
  hash.update("\u0000");
  hash.update(String(recipe.seed));
  hash.update("\u0000");
  hash.update(recipe.format);
  hash.update("\u0000");
  hash.update(String(recipe.sampleRate));
  return `sha256:${hash.digest("hex")}`;
}
