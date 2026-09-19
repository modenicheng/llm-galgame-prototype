/**
 * 真机语义回归：在符合规范的 AudioWorkletGlobalScope 模拟下跑 processor。
 *
 * 背景（真机全静音 P0）：规范里 sampleRate 是 scope 的全局只读量，不在
 * AudioWorkletProcessor 实例或原型链上；曾用 `this.sampleRate` 读取，真机
 * 得 undefined → 平滑系数全 NaN → 输出全 NaN → destination 非有限值防护
 * 把整条总线静音。Node 回退基类恰好自带 sampleRate=48000 实例字段，vitest
 * 全绿——本文件在"无实例字段 + 有 scope 全局"的环境下重新求值模块锁语义。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { defaultAudioDspParams } from "@shared/wire/audio-dsp.js";
import { dbToLinear, linearToDb } from "./dynamics-worklet.js";

const SR = 48000;
const FRAME = 128;

interface ProcLike {
  sampleRate: number;
  handlePortMessage(event: { data: unknown }): void;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

describe("dynamics worklet under a spec-compliant AudioWorkletGlobalScope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reads the scope-global sampleRate and outputs finite audio", async () => {
    // 规范 scope：AudioWorkletProcessor 无 sampleRate 实例字段
    vi.stubGlobal(
      "AudioWorkletProcessor",
      class {
        port = new MessageChannel().port1;
      },
    );
    const registry: Record<string, unknown> = {};
    vi.stubGlobal("registerProcessor", (name: string, ctor: unknown) => {
      registry[name] = ctor;
    });
    vi.stubGlobal("sampleRate", SR);
    vi.resetModules();
    const mod = await import("./dynamics-worklet.js");

    // 模块求值时应注册处理器
    expect(registry["dynamics"]).toBeDefined();

    const proc = new mod.DynamicsProcessor() as unknown as ProcLike;
    // 锁定语义：实例上的 sampleRate 必须被解析为 scope 全局，而非 undefined
    expect(proc.sampleRate).toBe(SR);

    // 全开参数（真机默认即三级全开）——修复前此处产出全 NaN
    proc.handlePortMessage({
      data: { type: "params", params: defaultAudioDspParams().voice },
    });

    const input = new Float32Array(FRAME);
    const output = new Float32Array(FRAME);
    const amp = dbToLinear(-6);
    let finite = true;
    let peak = 0;
    const blocks = SR / FRAME; // 1s，覆盖 attack 瞬态与稳态
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < FRAME; i++) {
        input[i] = amp * Math.sin((2 * Math.PI * 220 * (b * FRAME + i)) / SR);
      }
      expect(proc.process([[input]], [[output]])).toBe(true);
      for (let i = 0; i < FRAME; i++) {
        const v = output[i]!;
        if (!Number.isFinite(v)) finite = false;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
    }
    expect(finite).toBe(true);
    // -6dB 入、压缩到约 -18dB：有限且处于合理区间（非静音、非爆音）
    const peakDb = linearToDb(peak);
    expect(peakDb).toBeLessThan(-5);
    expect(peakDb).toBeGreaterThan(-40);

    // 空闲（全零输入）也不得产 NaN——0×NaN=NaN 曾把空闲期总线也毒化
    input.fill(0);
    proc.process([[input]], [[output]]);
    for (let i = 0; i < FRAME; i++) {
      expect(output[i]).toBe(0);
    }
  });
});
