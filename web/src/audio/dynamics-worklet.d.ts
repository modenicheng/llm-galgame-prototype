/**
 * dynamics-worklet.js 的类型声明。该文件是自包含纯 JS（blob URL 加载的
 * AudioWorklet 模块），但数学核心同时被 vitest 在 Node 里直接 import 测
 * 曲线——这里给出消费方（协调器/测试）需要的最小类型面。
 */

export interface GateStageParams {
  enabled: boolean;
  threshold_db: number;
  attack_ms: number;
  hold_ms: number;
  release_ms: number;
  range_db: number;
}

export interface CompressorStageParams {
  enabled: boolean;
  threshold_db: number;
  ratio: number;
  attack_ms: number;
  release_ms: number;
  knee_db: number;
  makeup_db: number;
}

export interface LimiterStageParams {
  enabled: boolean;
  ceiling_db: number;
  release_ms: number;
}

export interface DynamicsChainParams {
  enabled: boolean;
  gate: GateStageParams;
  compressor: CompressorStageParams;
  limiter: LimiterStageParams;
}

export interface DynamicsSnapshot {
  outDb: number;
  gateOpen: boolean;
  compGrDb: number;
  limGrDb: number;
}

export declare function dbToLinear(db: number): number;
export declare function linearToDb(x: number): number;
export declare function smoothingCoef(ms: number, sampleRate: number): number;
export declare function normalizeChain(raw: unknown): DynamicsChainParams;

export declare class EnvelopeFollower {
  constructor(sampleRate: number);
  setBallistics(attackMs: number, releaseMs: number): void;
  process(x: number): number;
  env: number;
  readonly sampleRate: number;
  readonly db: number;
}

export declare class GateStage {
  constructor();
  setParams(p: GateStageParams, sampleRate: number): void;
  process(envDb: number): number;
  enabled: boolean;
  open: boolean;
  gain: number;
}

export declare class CompressorStage {
  constructor();
  static curveGr(slope: number, kneeDb: number, over: number): number;
  setParams(p: CompressorStageParams, sampleRate: number): void;
  process(envDb: number): number;
  enabled: boolean;
  grDb: number;
}

export declare class LimiterStage {
  constructor();
  setParams(p: LimiterStageParams, sampleRate: number): void;
  process(envDb: number): number;
  enabled: boolean;
  grDb: number;
}

export declare class DynamicsChain {
  constructor(sampleRate: number);
  setParams(raw: unknown, sampleRate: number): void;
  processBlock(input: Float32Array[], output: Float32Array[]): boolean;
  snapshot(): DynamicsSnapshot;
  enabled: boolean;
}

export interface DynamicsStateMessage {
  type: "state";
  outDb: number;
  gateOpen: boolean;
  compGrDb: number;
  limGrDb: number;
}

export declare class DynamicsProcessor {
  constructor(options?: { processorOptions?: unknown });
  handlePortMessage(event: { data: unknown }): void;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
  ): boolean;
  readonly chain: DynamicsChain;
  readonly sampleRate: number;
  port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(message: unknown): void;
  };
}
