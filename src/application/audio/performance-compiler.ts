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
  pace?: Pace;
  energy?: Energy;
  volume?: VolumeLevel;
  delivery?: DeliveryTag[];
  pause_before_ms?: number;
  pause_after_ms?: number;
}

// ---------------------------------------------------------------------------
// 表演词汇表（运行时真源）——LinePerformance 的类型与导演指导的运行时校验
// 共用同一份词表（docs/superpowers/specs/2026-09-16-character-voice-design.md）。
// ---------------------------------------------------------------------------

export const DELIVERY_TAGS = [
  "restrained",
  "hesitant",
  "firm",
  "gentle",
  "cold",
  "playful",
  "breathless",
  "tearful",
] as const;
export type DeliveryTag = (typeof DELIVERY_TAGS)[number];

export const PACE_VALUES = ["very_slow", "slow", "normal", "fast", "very_fast"] as const;
export type Pace = (typeof PACE_VALUES)[number];

export const ENERGY_VALUES = ["very_low", "low", "normal", "high", "very_high"] as const;
export type Energy = (typeof ENERGY_VALUES)[number];

export const VOLUME_VALUES = ["whisper", "soft", "normal", "loud"] as const;
export type VolumeLevel = (typeof VOLUME_VALUES)[number];

/**
 * 表演先验（角色音频画像 §3.1 的 baseline）：画像层的基线档位，低于演员
 * 逐行意图与导演指导。词汇表与 LinePerformance 同源。
 */
export interface VoicePerformanceBaseline {
  pace?: Pace;
  energy?: Energy;
  volume?: VolumeLevel;
}

/**
 * 导演逐场景声音指导（角色音频特征设计 §3.2）：作用于某说话人在当前场景
 * 的全部台词，优先级高于演员逐行意图。`note` 只进 free 档 instruction
 * （fixed_emotion 档是纯情绪句式，自由文字没有落点）。
 */
export interface VoiceDirectionTarget {
  delivery?: DeliveryTag;
  pace?: Pace;
  energy?: Energy;
  volume?: VolumeLevel;
  /** ≤40 字自由提示（截断在导演解析侧），预算内自然让位给画像与语气段。 */
  note?: string;
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
  /** 导演场景指导（优先于逐行意图）；缺省 = 无指导。 */
  direction?: VoiceDirectionTarget;
  /** 画像层表演先验（低于逐行意图与导演指导）；缺省 = 无。 */
  baseline?: VoicePerformanceBaseline;
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

const PACE_RATE: Record<Pace, number> = {
  very_slow: 0.85,
  slow: 0.92,
  normal: 1.0,
  fast: 1.08,
  very_fast: 1.15,
};

const ENERGY_PITCH: Record<Energy, number> = {
  very_low: 0.9,
  low: 0.95,
  normal: 1.0,
  high: 1.05,
  very_high: 1.1,
};

const VOLUME_LEVEL: Record<VolumeLevel, number> = {
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
 * Filter delivery tag candidates against the character profile (§14.1): a
 * tag survives only when it is explicitly allowed (an empty / absent allowed
 * list means "no restriction") and never forbidden. Unknown tags and
 * duplicates are dropped so identical inputs stay identical.
 */
function filterDelivery(input: PerformanceCompileInput, raw: unknown): DeliveryTag[] {
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
 * high intensity (2–3) adds `情绪强烈。`; the director's free note is the
 * last clause. Trailing clauses are dropped first, then the base is
 * truncated, to stay within the vendor's weighted 100-char budget — so the
 * note yields before the voice anchor. Deterministic — identical inputs
 * produce identical output, which is what makes the result cacheKey-safe.
 */
function buildInstruction(
  base: string,
  delivery: DeliveryTag[],
  intensity: LinePerformance["intensity"],
  note: string | undefined,
): string | undefined {
  const parts: string[] = [];
  if (base.length > 0) parts.push(base);
  if (delivery.length > 0) {
    parts.push(`语气：${delivery.map((tag) => DELIVERY_LABELS[tag]).join("、")}。`);
  }
  if (intensity === 2 || intensity === 3) {
    parts.push("情绪强烈。");
  }
  if (note !== undefined && note.length > 0) {
    parts.push(note);
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

/**
 * Weighted length matching the DashScope counting rule: 汉字 (incl. CJK
 * Extension A) count 2; everything else — punctuation, letters, digits,
 * kana, Hangul — counts 1. This is ≥ the vendor's count for every input
 * (never undercounts), so an instruction we deem ≤ 100 never exceeds the
 * vendor limit.
 */
function weightedLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    n += code >= 0x3400 && code <= 0x9fff ? 2 : 1;
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
      const direction =
        input.direction !== null && typeof input.direction === "object" ? input.direction : undefined;
      const baseline =
        input.baseline !== null && typeof input.baseline === "object" ? input.baseline : undefined;
      // 合并优先级：导演指导 > 演员逐行意图 > 画像基线（角色音频特征设计
      // §3.3）；delivery 候选里导演标签前置，仍受同一调色板过滤（§14.1）。
      const deliveryCandidates =
        direction?.delivery !== undefined
          ? [direction.delivery, ...(validPerf?.delivery ?? [])]
          : validPerf?.delivery;
      const kept = filterDelivery(input, deliveryCandidates);

      const mode: InstructionMode = input.instructionMode ?? "free";
      let instruction: string | undefined;
      if (mode === "fixed_emotion") {
        instruction = buildFixedEmotionInstruction(validPerf);
      } else if (mode === "free") {
        instruction = buildInstruction(base, kept, validPerf?.intensity, direction?.note);
      }
      // 三轴同一优先级链（§3.3）：导演 > 逐行意图 > 画像基线。
      const axis = {
        pace: direction?.pace ?? validPerf?.pace ?? baseline?.pace,
        energy: direction?.energy ?? validPerf?.energy ?? baseline?.energy,
        volume: direction?.volume ?? validPerf?.volume ?? baseline?.volume,
      };
      const result: CompiledPerformance = {
        rate: lookup(PACE_RATE, axis.pace, IDENTITY_PARAMS.rate),
        pitch: lookup(ENERGY_PITCH, axis.energy, IDENTITY_PARAMS.pitch),
        volume: lookup(VOLUME_LEVEL, axis.volume, IDENTITY_PARAMS.volume),
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
