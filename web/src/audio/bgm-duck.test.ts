import { describe, expect, it } from "vitest";
import { defaultAudioDspParams, type DuckingParams } from "@shared/wire/audio-dsp.js";
import { BgmDucker, type BgmDuckerOutput } from "./bgm-duck.js";

/** 手动时钟（秒时基，与 AudioContext.currentTime 一致）。 */
function makeClock() {
  let now = 0;
  return {
    clock: { now: () => now },
    advanceSec(sec: number) {
      now += sec;
    },
  };
}

function makeOutput() {
  const calls: Array<{ value: number; at: number; tc: number }> = [];
  const output: BgmDuckerOutput = {
    setTarget: (value, at, tc) => calls.push({ value, at, tc }),
  };
  return { calls, output };
}

function duckingParams(overrides: Partial<DuckingParams> = {}): DuckingParams {
  return { ...defaultAudioDspParams().ducking, ...overrides };
}

describe("BgmDucker", () => {
  it("语音超阈：开门一次压到 depth（线性），持续语音不重复落盘", () => {
    const { clock, advanceSec } = makeClock();
    const { calls, output } = makeOutput();
    const ducker = new BgmDucker(output, clock, duckingParams());
    ducker.onVoiceLevel(-20); // > -42 阈值 → 开门
    expect(calls).toHaveLength(1);
    expect(calls[0]!.value).toBeCloseTo(10 ** (-12 / 20), 5); // -12dB → 0.2512
    expect(calls[0]!.at).toBe(0);
    expect(calls[0]!.tc).toBeCloseTo(150 / 3000, 6); // attack τ
    for (let i = 0; i < 50; i++) {
      advanceSec(0.02);
      ducker.onVoiceLevel(-20);
    }
    expect(calls).toHaveLength(1); // 目标未变 → 不再刷 AudioParam
  });

  it("语音停住：hold 内不回弹，超过 hold 释放回 1（release τ）", () => {
    const { clock, advanceSec } = makeClock();
    const { calls, output } = makeOutput();
    const ducker = new BgmDucker(output, clock, duckingParams());
    ducker.onVoiceLevel(-20);
    advanceSec(0.1);
    ducker.onVoiceLevel(-60); // 掉到阈下，但才 0.1s < hold 350ms
    expect(calls).toHaveLength(1);
    advanceSec(0.2); // 累计 0.3s 仍 < hold
    ducker.onVoiceLevel(-60);
    expect(calls).toHaveLength(1);
    advanceSec(0.1); // 累计 0.4s > hold → 释放
    ducker.onVoiceLevel(-60);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.value).toBe(1);
    expect(calls[1]!.tc).toBeCloseTo(900 / 3000, 6);
  });

  it("hold 窗口内语音再来：保持压低不抖动", () => {
    const { clock, advanceSec } = makeClock();
    const { calls, output } = makeOutput();
    const ducker = new BgmDucker(output, clock, duckingParams({ hold_ms: 350 }));
    ducker.onVoiceLevel(-20);
    advanceSec(0.2);
    ducker.onVoiceLevel(-60);
    advanceSec(0.1); // 0.3s
    ducker.onVoiceLevel(-20); // 回来 → 重置 lastActive
    advanceSec(0.2);
    ducker.onVoiceLevel(-60); // 距上次活跃 0.2s < hold
    expect(calls).toHaveLength(1);
  });

  it("禁用时 no-op；压低态下切禁用立即释放", () => {
    const { clock, advanceSec } = makeClock();
    const { calls, output } = makeOutput();
    const ducker = new BgmDucker(output, clock, duckingParams({ enabled: false }));
    ducker.onVoiceLevel(-20);
    expect(calls).toHaveLength(0);
    // 先开门再禁用
    ducker.setParams(duckingParams());
    ducker.onVoiceLevel(-20);
    expect(calls).toHaveLength(1);
    ducker.setParams(duckingParams({ enabled: false }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.value).toBe(1);
    advanceSec(1);
    ducker.onVoiceLevel(-20);
    expect(calls).toHaveLength(2);
  });

  it("depth 深度映射：-24dB → 线性 0.0631", () => {
    const { clock } = makeClock();
    const { calls, output } = makeOutput();
    const ducker = new BgmDucker(output, clock, duckingParams({ depth_db: -24 }));
    ducker.onVoiceLevel(-10);
    expect(calls[0]!.value).toBeCloseTo(10 ** (-24 / 20), 5);
  });
});
