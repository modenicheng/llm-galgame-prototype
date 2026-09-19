/**
 * BgmDucker — 语音电平驱动的 BGM 闪避状态机。
 *
 * 消费语音链 dynamics worklet 的输出电平（dB，≈21ms 一次），高于阈值时把
 * BGM 的 duckGain 压到 depth（dB→线性），语音停住并超过 hold 后释放回 1。
 * attack/release 用 `setTargetAtTime` 语义（时间常数 τ = ms/3000，即 ms 内
 * 走完 ~95%），由底层 AudioParam 做采样级指数平滑，主线程只需在目标变化
 * 的边沿调用一次。
 *
 * 时钟与输出都注入：生产用 `context.currentTime` + duckGain 的 AudioParam，
 * 测试用手动时钟 + 记录数组。电平来自 worklet（音频线程），后台标签页
 * 计时器被节流也不影响闪避跟随。
 */
import type { DuckingParams } from "@shared/wire/audio-dsp.js";
import { dbToLinear, linearToDb } from "./dynamics-worklet.js";

/** 时钟抽象：now() 返回秒（与 AudioContext.currentTime 同时基）。 */
export interface BgmDuckerClock {
  now(): number;
}

/** 闪避增益落点：setTargetAtTime 语义（value, 生效时刻, 时间常数秒）。 */
export interface BgmDuckerOutput {
  setTarget(value: number, startTimeSec: number, timeConstantSec: number): void;
}

/** ms 时长折算 setTargetAtTime 时间常数：τ = ms/3000（~95% 收敛）。 */
function timeConstantSec(ms: number): number {
  return Math.max(ms, 1) / 3000;
}

export class BgmDucker {
  private params: DuckingParams;
  private readonly output: BgmDuckerOutput;
  private readonly clock: BgmDuckerClock;
  /** 当前是否处于压低态。 */
  private open = false;
  /** 电平最后一次高过阈值的时刻（clock 时基，秒）。 */
  private lastActiveAt = 0;
  /** 已落盘的增益目标，去重避免向 AudioParam 时间线刷重复事件。 */
  private targetValue = 1;

  constructor(output: BgmDuckerOutput, clock: BgmDuckerClock, params: DuckingParams) {
    this.output = output;
    this.clock = clock;
    this.params = params;
  }

  /** 热更参数；禁用时立即释放（闪避深度变化在下次开门时生效）。 */
  setParams(params: DuckingParams): void {
    this.params = params;
    if (!params.enabled && this.targetValue !== 1) {
      this.open = false;
      this.applyTarget(1, params.release_ms);
    }
  }

  /** 语音链输出电平（dBFS）。禁用时为纯 no-op。 */
  onVoiceLevel(levelDb: number): void {
    const p = this.params;
    if (!p.enabled) return;
    const now = this.clock.now();
    if (levelDb > p.threshold_db) {
      this.lastActiveAt = now;
      if (!this.open) {
        this.open = true;
        this.applyTarget(dbToLinear(p.depth_db), p.attack_ms);
      }
      return;
    }
    if (this.open && (now - this.lastActiveAt) * 1000 >= p.hold_ms) {
      this.open = false;
      this.applyTarget(1, p.release_ms);
    }
  }

  private applyTarget(value: number, rampMs: number): void {
    if (value === this.targetValue) return;
    this.targetValue = value;
    this.output.setTarget(value, this.clock.now(), timeConstantSec(rampMs));
  }

  /** 当前闪避深度（dB，≤0 为压低中，0 = 未闪避）；遥测仪表消费。 */
  get depthDb(): number {
    return linearToDb(this.targetValue);
  }
}
