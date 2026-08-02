/**
 * PerformanceCompiler contract — LLM 演出意图 → 供应商参数。
 *
 * Types, interface, and the default implementation (`PerformanceCompilerImpl`)
 * live here (application layer, Node-side). The compiled result participates
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
  whisper: 0.4,
  soft: 0.7,
  normal: 1.0,
  loud: 1.3,
};

/** Identity parameters — ordinary lines compile to exactly these. */
const IDENTITY_PARAMS = {
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  pauseBeforeMs: 0,
  pauseAfterMs: 0,
} as const;

/** Lookup a numeric bound; unknown/absent keys fall back to 1.0. */
function lookup<T extends string>(table: Record<T, number>, key: T | undefined): number {
  if (key === undefined) return 1.0;
  return table[key] ?? 1.0;
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
 * high intensity (2–3) adds `情绪强烈。`. Empty result → undefined so the
 * caller can omit the field (cacheKey distinguishes absence vs. "").
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
  const text = parts.join("");
  return text.length > 0 ? text : undefined;
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

      const result: CompiledPerformance = {
        rate: lookup(PACE_RATE, validPerf?.pace),
        pitch: lookup(ENERGY_PITCH, validPerf?.energy),
        volume: lookup(VOLUME_LEVEL, validPerf?.volume),
        pauseBeforeMs: clampPause(validPerf?.pause_before_ms),
        pauseAfterMs: clampPause(validPerf?.pause_after_ms),
      };
      const instruction = buildInstruction(base, kept, validPerf?.intensity);
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
