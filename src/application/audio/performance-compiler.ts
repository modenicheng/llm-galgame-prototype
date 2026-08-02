/**
 * PerformanceCompiler contract — LLM 演出意图 → 供应商参数。
 *
 * Types and interface live here (application layer, Node-side); the
 * implementation is a separate module. The compiled result participates
 * in cacheKey generation, so a prompt/mapping/voice-version change
 * naturally invalidates old audio caches.
 */

/** Restricted performance intent the LLM may attach to a line. */
export interface LinePerformance {
  emotion?:
    | "neutral"
    | "happy"
    | "sad"
    | "angry"
    | "anxious"
    | "afraid"
    | "excited"
    | "tired"
    | "sarcastic"
    | "tender"
    | "serious";
  intensity?: 0 | 1 | 2 | 3;
  pace?: "very_slow" | "slow" | "normal" | "fast" | "very_fast";
  energy?: "very_low" | "low" | "normal" | "high" | "very_high";
  volume?: "whisper" | "soft" | "normal" | "loud";
  delivery?: Array<
    | "restrained"
    | "hesitant"
    | "firm"
    | "gentle"
    | "cold"
    | "playful"
    | "breathless"
    | "tearful"
  >;
  pause_before_ms?: number;
  pause_after_ms?: number;
}

/** Provider-level numeric/instruction parameters after compilation. */
export interface CompiledPerformance {
  instruction?: string;
  rate: number;
  pitch: number;
  volume: number;
  pauseBeforeMs: number;
  pauseAfterMs: number;
}

/** Inputs the compiler needs: character base description plus line intent. */
export interface PerformanceCompileInput {
  /** Character's base voice description (from voices.yaml). */
  baseDescription: string;
  /** Delivery styles the character profile allows. */
  allowedDelivery?: string[];
  /** Delivery styles the character profile forbids. */
  forbiddenDelivery?: string[];
  /** Optional LLM-provided performance intent for this line. */
  performance?: LinePerformance;
}

export interface PerformanceCompiler {
  compile(input: PerformanceCompileInput): CompiledPerformance;
}
