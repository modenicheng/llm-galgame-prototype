/**
 * AudioDspParams — 音频动态处理参数（语音 gate/压缩/限幅、BGM 压缩/限幅、闪避）。
 *
 * 单一来源：zod schema 供 Node 端（audio-dsp.yaml 加载/保存路由）与浏览器端
 * （GET /api/config 初始参数、/ws/runtime 热更新推送）共用。纯数据校验，
 * 无 Node/DOM 依赖。
 *
 * 鲁棒性语义（配合 audio-dsp.yaml 可被程序写回、也可能被手改）：单个坏字段
 * ——类型错、越界、null——一律回落默认值并 clamp 进合法区间，绝不让整个
 * 解析失败（那会丢掉其余合法字段）；只有顶层不是对象才判非法（返回 null
 * 由调用方整体兜底）。未知键按 zod 默认剥除。
 */
import { z } from "zod";

/** 数值字段：字符串数字 coerce、null/空串/NaN 回默认、越界 clamp。 */
const num = (def: number, lo: number, hi: number) =>
  z.preprocess(
    (v) => {
      if (v === null || v === undefined || v === "") return undefined;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : undefined;
    },
    z.number().catch(def).transform((v) => Math.min(hi, Math.max(lo, v))),
  );

const bool = (def: boolean) => z.boolean().catch(def);
const db = (def: number) => num(def, -80, 0);
const ms = (def: number) => num(def, 0, 5000);

export const GateParamsSchema = z.object({
  /** 低于该电平（dBFS）视为静音段。 */
  threshold_db: db(-55),
  attack_ms: ms(5),
  /** 电平跌回阈值后保持开门的时长，防句内停顿抖动。 */
  hold_ms: ms(150),
  release_ms: ms(250),
  /** 闭门时的衰减下限（dB，≤0）；0 = 完全静音。 */
  range_db: db(-70),
  enabled: bool(true),
});
export type GateParams = z.output<typeof GateParamsSchema>;

export const CompressorParamsSchema = z.object({
  threshold_db: db(-26),
  ratio: num(2.5, 1, 20),
  attack_ms: ms(8),
  release_ms: ms(150),
  knee_db: num(6, 0, 24),
  makeup_db: num(0, -24, 24),
  enabled: bool(true),
});
export type CompressorParams = z.output<typeof CompressorParamsSchema>;

export const LimiterParamsSchema = z.object({
  /** 输出天花板（dBFS）。 */
  ceiling_db: db(-1.5),
  release_ms: ms(80),
  enabled: bool(true),
});
export type LimiterParams = z.output<typeof LimiterParamsSchema>;

export const DEFAULT_GATE: GateParams = {
  threshold_db: -55,
  attack_ms: 5,
  hold_ms: 150,
  release_ms: 250,
  range_db: -70,
  enabled: true,
};
export const DEFAULT_COMPRESSOR: CompressorParams = {
  threshold_db: -26,
  ratio: 2.5,
  attack_ms: 8,
  release_ms: 150,
  knee_db: 6,
  makeup_db: 0,
  enabled: true,
};
export const DEFAULT_LIMITER: LimiterParams = {
  ceiling_db: -1.5,
  release_ms: 80,
  enabled: true,
};
/** BGM 链默认：gate 关（音乐开门无意义），压缩/限幅保守关闭。 */
export const DEFAULT_BGM_GATE: GateParams = { ...DEFAULT_GATE, enabled: false };
export const DEFAULT_BGM_COMPRESSOR: CompressorParams = {
  ...DEFAULT_COMPRESSOR,
  enabled: false,
  threshold_db: -20,
  ratio: 2,
  attack_ms: 20,
  release_ms: 300,
};
export const DEFAULT_BGM_LIMITER: LimiterParams = { ...DEFAULT_LIMITER, enabled: false };

/** 单条总线的动态处理链（gate → compressor → limiter），语音/BGM 同构。 */
export const DynamicsChainSchema = z.object({
  enabled: bool(true),
  gate: GateParamsSchema.catch(DEFAULT_GATE),
  compressor: CompressorParamsSchema.catch(DEFAULT_COMPRESSOR),
  limiter: LimiterParamsSchema.catch(DEFAULT_LIMITER),
});
export type DynamicsChainParams = z.output<typeof DynamicsChainSchema>;

export const DEFAULT_VOICE_CHAIN: DynamicsChainParams = {
  enabled: true,
  gate: DEFAULT_GATE,
  compressor: DEFAULT_COMPRESSOR,
  limiter: DEFAULT_LIMITER,
};
export const DEFAULT_BGM_CHAIN: DynamicsChainParams = {
  enabled: true,
  gate: DEFAULT_BGM_GATE,
  compressor: DEFAULT_BGM_COMPRESSOR,
  limiter: DEFAULT_BGM_LIMITER,
};

export const DuckingParamsSchema = z.object({
  /** 语音链输出电平高于该值（dBFS）时闪避进入压低态。 */
  threshold_db: db(-42),
  /** 压低量（dB，≤0）。 */
  depth_db: num(-12, -60, 0),
  attack_ms: ms(150),
  hold_ms: num(350, 0, 5000),
  release_ms: num(900, 0, 5000),
  enabled: bool(true),
});
export type DuckingParams = z.output<typeof DuckingParamsSchema>;
export const DEFAULT_DUCKING: DuckingParams = {
  threshold_db: -42,
  depth_db: -12,
  attack_ms: 150,
  hold_ms: 350,
  release_ms: 900,
  enabled: true,
};

export const AudioDspParamsSchema = z.object({
  version: num(1, 1, 1),
  voice: DynamicsChainSchema.catch(DEFAULT_VOICE_CHAIN),
  bgm: DynamicsChainSchema.catch(DEFAULT_BGM_CHAIN),
  ducking: DuckingParamsSchema.catch(DEFAULT_DUCKING),
});
export type AudioDspParams = z.output<typeof AudioDspParamsSchema>;

/** 解析任意来源（yaml/HTTP body/WS 消息）的参数；顶层非对象返回 null 由调用方兜底。 */
export function parseAudioDspParams(raw: unknown): AudioDspParams | null {
  const result = AudioDspParamsSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function defaultAudioDspParams(): AudioDspParams {
  // structuredClone：调用方（UI 编辑/测试）改返回值不得污染 DEFAULT_* 常量。
  return structuredClone({
    version: 1,
    voice: DEFAULT_VOICE_CHAIN,
    bgm: DEFAULT_BGM_CHAIN,
    ducking: DEFAULT_DUCKING,
  });
}
