/**
 * PerformanceCompiler contract — LLM 演出意图 → 供应商参数。
 *
 * Types, interface, and the default implementation (`PerformanceCompilerImpl`)
 * live here (application layer, Node-side). The compiled result participates
 * in cacheKey generation, so a prompt/mapping/voice-version change
 * naturally invalidates old audio caches.
 */
import type { InstructionMode } from "../../config/voices.js";

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
    | "serious"
    | "surprised"
    | "disgusted";
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
  /** DashScope instruction policy: free-form (cloned/designed voices —
   *  default), fixed_emotion (system voices), or none. */
  instructionMode?: InstructionMode;
}

export interface PerformanceCompiler {
  compile(input: PerformanceCompileInput): CompiledPerformance;
}

// ---------------------------------------------------------------------------
// Implementation — PerformanceCompilerImpl
// ---------------------------------------------------------------------------

/** Delivery style → stable Chinese label (feeds the compiled instruction). */
type DeliveryTag = NonNullable<LinePerformance["delivery"]>[number];

const DELIVERY_LABELS: Record<DeliveryTag, string> = {
  restrained: "克制",
  hesitant: "犹豫",
  firm: "坚定",
  gentle: "温柔",
  cold: "冷漠",
  playful: "俏皮",
  breathless: "气促",
  tearful: "含泪",
};

const PACE_RATE: Record<NonNullable<LinePerformance["pace"]>, number> = {
  very_slow: 0.85,
  slow: 0.92,
  normal: 1.0,
  fast: 1.08,
  very_fast: 1.15,
};

const ENERGY_PITCH: Record<NonNullable<LinePerformance["energy"]>, number> = {
  very_low: 0.9,
  low: 0.95,
  normal: 1.0,
  high: 1.05,
  very_high: 1.1,
};

const VOLUME_LEVEL: Record<NonNullable<LinePerformance["volume"]>, number> = {
  whisper: 20,
  soft: 35,
  normal: 50,
  loud: 70,
};

/** Identity parameters — ordinary lines compile to exactly these. */
const IDENTITY_PARAMS = {
  rate: 1.0,
  pitch: 1.0,
  volume: 50,
  pauseBeforeMs: 0,
  pauseAfterMs: 0,
} as const;

/** Lookup a numeric bound; unknown/absent keys fall back to the identity
 *  value for that parameter (rate/pitch 1.0, volume 50). */
function lookup<T extends string>(
  table: Record<T, number>,
  key: T | undefined,
  identity: number,
): number {
  if (key === undefined) return identity;
  return table[key] ?? identity;
}

function clampPause(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(30000, Math.max(0, value));
}

/**
 * Filter the LLM's delivery suggestions against the character profile
 * (§14.1): a tag survives only when it is explicitly allowed (an empty /
 * absent allowed list means "no restriction") and never forbidden. Unknown
 * tags and duplicates are dropped so identical inputs stay identical.
 */
function filterDelivery(
  input: PerformanceCompileInput,
  perf: LinePerformance,
): DeliveryTag[] {
  const raw = perf.delivery;
  if (!Array.isArray(raw)) return [];
  const allowed = Array.isArray(input.allowedDelivery) ? input.allowedDelivery : [];
  const forbidden = Array.isArray(input.forbiddenDelivery) ? input.forbiddenDelivery : [];
  const allowedSet = allowed.length > 0 ? new Set(allowed) : null;
  const forbiddenSet = new Set(forbidden);
  const kept: DeliveryTag[] = [];
  const seen = new Set<string>();
  for (const tag of raw) {
    if (typeof tag !== "string") continue;
    if (allowedSet !== null && !allowedSet.has(tag)) continue;
    if (forbiddenSet.has(tag)) continue;
    if (!(tag in DELIVERY_LABELS)) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    kept.push(tag as DeliveryTag);
  }
  return kept;
}

/**
 * Compose the provider instruction: the character's base description is the
 * voice anchor; surviving delivery tags are appended as `语气：…。`;
 * high intensity (2–3) adds `情绪强烈。`. Trailing clauses are dropped
 * first, then the base is truncated, to stay within the vendor's weighted
 * 100-char budget. Deterministic — identical inputs produce identical
 * output, which is what makes the result cacheKey-safe.
 */
function buildInstruction(
  base: string,
  delivery: DeliveryTag[],
  intensity: LinePerformance["intensity"],
): string | undefined {
  const parts: string[] = [];
  if (base.length > 0) parts.push(base);
  if (delivery.length > 0) {
    parts.push(`语气：${delivery.map((tag) => DELIVERY_LABELS[tag]).join("、")}。`);
  }
  if (intensity === 2 || intensity === 3) {
    parts.push("情绪强烈。");
  }
  while (parts.length > 1 && weightedLength(parts.join("")) > INSTRUCTION_BUDGET) {
    parts.pop();
  }
  if (parts.length === 0) return undefined;
  const text = parts.join("");
  if (weightedLength(text) <= INSTRUCTION_BUDGET) return text;
  const kept = truncateWeighted(base, INSTRUCTION_BUDGET);
  return kept.length > 0 ? kept : undefined;
}

/** CosyVoice instruction budget: ≤ 100 chars, CJK counts 2. */
const INSTRUCTION_BUDGET = 100;

/** Weighted length: CJK (incl. CJK punctuation) counts 2, other chars 1. */
function weightedLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    n += code >= 0x2e80 && code <= 0x9fff ? 2 : 1;
  }
  return n;
}

/** Weighted truncation at the budget boundary (never splits a surrogate pair). */
function truncateWeighted(text: string, budget: number): string {
  let kept = "";
  let n = 0;
  for (const ch of text) {
    const w = weightedLength(ch);
    if (n + w > budget) break;
    kept += ch;
    n += w;
  }
  return kept;
}

/**
 * LinePerformance.emotion → DashScope fixed-format emotion vocabulary
 * (docs: 你说话的情感是<emotion>。 with neutral/fearful/angry/sad/
 * surprised/happy/disgusted). Emotions without a faithful mapping are
 * dropped so we never emit an invalid fixed instruction.
 */
const FIXED_EMOTION: Record<string, string> = {
  neutral: "neutral",
  happy: "happy",
  sad: "sad",
  angry: "angry",
  afraid: "fearful",
  anxious: "fearful",
  excited: "happy",
  surprised: "surprised",
  disgusted: "disgusted",
};

/** Fixed-format instruction (system voices): emotion clause only. */
function buildFixedEmotionInstruction(perf: LinePerformance | undefined): string | undefined {
  const emotion = perf?.emotion;
  const mapped = typeof emotion === "string" ? FIXED_EMOTION[emotion] : undefined;
  return mapped !== undefined ? `你说话的情感是${mapped}。` : undefined;
}

/**
 * Total compiler: never throws. Any malformed input (null, non-object,
 * out-of-range enums, non-numeric pauses) degrades to identity parameters;
 * on an exception the character's base description is kept as the default
 * tone (§14.5). The mapping is deterministic — identical inputs produce
 * identical output, which is what makes the result cacheKey-safe.
 */
export class PerformanceCompilerImpl implements PerformanceCompiler {
  compile(input: PerformanceCompileInput): CompiledPerformance {
    try {
      const base = typeof input.baseDescription === "string" ? input.baseDescription.trim() : "";
      const perf = input.performance;
      const validPerf = perf !== null && typeof perf === "object" ? perf : undefined;
      const kept = validPerf ? filterDelivery(input, validPerf) : [];

      const mode: InstructionMode = input.instructionMode ?? "free";
      let instruction: string | undefined;
      if (mode === "fixed_emotion") {
        instruction = buildFixedEmotionInstruction(validPerf);
      } else if (mode === "free") {
        instruction = buildInstruction(base, kept, validPerf?.intensity);
      }
      const result: CompiledPerformance = {
        rate: lookup(PACE_RATE, validPerf?.pace, IDENTITY_PARAMS.rate),
        pitch: lookup(ENERGY_PITCH, validPerf?.energy, IDENTITY_PARAMS.pitch),
        volume: lookup(VOLUME_LEVEL, validPerf?.volume, IDENTITY_PARAMS.volume),
        pauseBeforeMs: clampPause(validPerf?.pause_before_ms),
        pauseAfterMs: clampPause(validPerf?.pause_after_ms),
      };
      if (instruction !== undefined) result.instruction = instruction;
      return result;
    } catch {
      // §14.5: 编译失败时回退角色默认语气。
      const base = typeof input?.baseDescription === "string" ? input.baseDescription.trim() : "";
      const result: CompiledPerformance = { ...IDENTITY_PARAMS };
      if (base.length > 0) result.instruction = base;
      return result;
    }
  }
}
