import { describe, expect, it } from "vitest";
import {
  CompressorStage,
  DynamicsChain,
  DynamicsProcessor,
  GateStage,
  LimiterStage,
  dbToLinear,
  linearToDb,
  normalizeChain,
} from "./dynamics-worklet.js";

const SR = 48000;
const FRAME = 128;

/**
 * 以稳态正弦驱动链路，先丢 settleMs 让球面滚动收敛（attack 期间的未压缩
 * 瞬态不得计入），再在测量窗内返回输出峰值电平 dB。
 */
function steadyOutputDb(chain: DynamicsChain, inputDb: number, ms = 600, settleMs = 900): number {
  const amp = dbToLinear(inputDb);
  const input = [new Float32Array(FRAME)];
  const output = [new Float32Array(FRAME)];
  const fill = (b: number) => {
    for (let i = 0; i < FRAME; i++) {
      const t = (b * FRAME + i) / SR;
      input[0]![i] = amp * Math.sin(2 * Math.PI * 220 * t);
    }
  };
  const settleBlocks = Math.ceil((settleMs / 1000) * SR / FRAME);
  for (let b = 0; b < settleBlocks; b++) {
    fill(b);
    chain.processBlock(input, output);
  }
  const base = settleBlocks * FRAME;
  const measureBlocks = Math.ceil((ms / 1000) * SR / FRAME);
  let peak = 0;
  for (let b = 0; b < measureBlocks; b++) {
    fill(base + b);
    chain.processBlock(input, output);
    for (let i = 0; i < FRAME; i++) {
      const v = Math.abs(output[0]![i]!);
      if (v > peak) peak = v;
    }
  }
  return linearToDb(peak);
}

function voiceChain(overrides: Record<string, unknown> = {}): DynamicsChain {
  const chain = new DynamicsChain(SR);
  chain.setParams(
    {
      enabled: true,
      gate: { enabled: false },
      compressor: { enabled: false },
      limiter: { enabled: false },
      ...overrides,
    },
    SR,
  );
  return chain;
}

describe("compressor static curve", () => {
  it("reduces above-threshold level by the ratio", () => {
    // -6dB 入、阈 -26、比 2.5 → out = -26 + 20/2.5 = -18
    const chain = voiceChain({ compressor: { enabled: true, threshold_db: -26, ratio: 2.5, knee_db: 6 } });
    expect(steadyOutputDb(chain, -6)).toBeCloseTo(-18, 0);
  });

  it("leaves below-threshold level untouched", () => {
    const chain = voiceChain({ compressor: { enabled: true, threshold_db: -26, ratio: 2.5 } });
    expect(steadyOutputDb(chain, -40)).toBeCloseTo(-40, 0);
  });

  it("applies makeup gain", () => {
    const chain = voiceChain({ compressor: { enabled: true, threshold_db: -26, ratio: 2.5, makeup_db: 6 } });
    expect(steadyOutputDb(chain, -6)).toBeCloseTo(-12, 0);
  });

  it("curveGr is zero in knee-bottom, full slope in knee-top", () => {
    expect(CompressorStage.curveGr(0.6, 6, -10)).toBe(0);
    expect(CompressorStage.curveGr(0.6, 6, 10)).toBeCloseTo(6, 6);
    // 膝中心 = slope·knee/4（二次软膝，非线性爬升）
    expect(CompressorStage.curveGr(0.6, 6, 0)).toBeCloseTo(0.9, 6);
    // 膝边界连续
    expect(CompressorStage.curveGr(0.6, 6, 5.999)).toBeCloseTo(CompressorStage.curveGr(0.6, 6, 6.001), 2);
  });
});

describe("gate", () => {
  it("closes below threshold after hold and reopens above it", () => {
    const chain = voiceChain({
      gate: { enabled: true, threshold_db: -55, hold_ms: 50, attack_ms: 2, release_ms: 50, range_db: -70 },
    });
    // -70dB 远低于阈 -55：hold 过后闭门，输出贴到 range 底
    expect(steadyOutputDb(chain, -70, 600)).toBeLessThan(-55);
    // -20dB 稳态开门：输出≈输入（±摆动容差）
    expect(steadyOutputDb(chain, -20, 600)).toBeGreaterThan(-24);
  });

  it("stage-level open flag tracks the envelope", () => {
    const gate = new GateStage();
    gate.setParams({ enabled: true, threshold_db: -40, attack_ms: 1, hold_ms: 0, release_ms: 10, range_db: -70 }, SR);
    for (let i = 0; i < 4800; i++) gate.process(-60);
    expect(gate.open).toBe(false);
    for (let i = 0; i < 480; i++) gate.process(-20);
    expect(gate.open).toBe(true);
  });
});

describe("limiter", () => {
  it("converges to the ceiling and never slams above 0dBFS", () => {
    const chain = voiceChain({ limiter: { enabled: true, ceiling_db: -1.5, release_ms: 80 } });
    let maxPeak = 0;
    const amp = dbToLinear(0);
    const input = [new Float32Array(FRAME)];
    const output = [new Float32Array(FRAME)];
    const blocks = Math.ceil((1.2 * SR) / FRAME);
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < FRAME; i++) {
        const t = (b * FRAME + i) / SR;
        input[0]![i] = amp * Math.sin(2 * Math.PI * 220 * t);
      }
      chain.processBlock(input, output);
      for (let i = 0; i < FRAME; i++) {
        const v = Math.abs(output[0]![i]!);
        if (v > maxPeak) maxPeak = v;
      }
    }
    expect(maxPeak).toBeLessThanOrEqual(dbToLinear(0));
    // 后 300ms 已稳定在天花板附近
    const tailDb = steadyOutputDb(chain, 0, 300);
    expect(tailDb).toBeLessThanOrEqual(-0.5);
    expect(tailDb).toBeGreaterThanOrEqual(-3.5);
  });
});

describe("chain bypass and routing", () => {
  it("disabled chain passes audio through bit-exact", () => {
    const chain = voiceChain();
    chain.setParams({ enabled: false }, SR);
    const input = [new Float32Array(FRAME)];
    const output = [new Float32Array(FRAME)];
    for (let i = 0; i < FRAME; i++) input[0]![i] = Math.sin(i / 7) * 0.4;
    chain.processBlock(input, output);
    for (let i = 0; i < FRAME; i++) {
      expect(output[0]![i]).toBe(input[0]![i]);
    }
  });

  it("linked stereo envelope applies one gain to every channel", () => {
    const chain = voiceChain({ limiter: { enabled: true, ceiling_db: -6, release_ms: 50 } });
    const input = [new Float32Array(FRAME), new Float32Array(FRAME)];
    const output = [new Float32Array(FRAME), new Float32Array(FRAME)];
    for (let i = 0; i < FRAME; i++) {
      input[0]![i] = 0.9 * Math.sin((2 * Math.PI * 220 * i) / SR); // -1dB 峰
      input[1]![i] = 0; // R 静音，但 linked 包络仍由 L 驱动
    }
    // 跑若干块进入限幅态
    for (let b = 0; b < 400; b++) chain.processBlock(input, output);
    let lPeak = 0;
    let rMax = 0;
    for (let i = 0; i < FRAME; i++) {
      lPeak = Math.max(lPeak, Math.abs(output[0]![i]!));
      rMax = Math.max(rMax, Math.abs(output[1]![i]!));
    }
    // R 原本无声，同增益后仍无声；L 被压向天花板
    expect(rMax).toBe(0);
    expect(linearToDb(lPeak)).toBeLessThanOrEqual(-5);
  });

  it("mono input duplicates into stereo output when upsizing", () => {
    const chain = voiceChain();
    const input = [new Float32Array(FRAME)];
    const output = [new Float32Array(FRAME), new Float32Array(FRAME)];
    for (let i = 0; i < FRAME; i++) input[0]![i] = Math.sin(i / 3) * 0.2;
    chain.processBlock(input, output);
    for (let i = 0; i < FRAME; i++) {
      expect(output[1]![i]).toBe(output[0]![i]);
    }
  });
});

describe("normalizeChain", () => {
  it("fills defaults from an empty object", () => {
    const p = normalizeChain({});
    expect(p.enabled).toBe(true);
    expect(p.gate.threshold_db).toBe(-55);
    expect(p.compressor.ratio).toBe(2.5);
    expect(p.limiter.ceiling_db).toBe(-1.5);
  });

  it("clamps out-of-range values", () => {
    const p = normalizeChain({ compressor: { ratio: 999, makeup_db: -99 }, limiter: { ceiling_db: 3 } });
    expect(p.compressor.ratio).toBe(20);
    expect(p.compressor.makeup_db).toBe(-24);
    expect(p.limiter.ceiling_db).toBe(0);
  });

  it("survives garbage input", () => {
    const p = normalizeChain(null);
    expect(p.enabled).toBe(true);
    expect(p.gate.hold_ms).toBe(150);
  });
});

describe("DynamicsProcessor", () => {
  it("accepts params messages and passes blocks through the chain", () => {
    const proc = new DynamicsProcessor();
    proc.handlePortMessage({
      data: { type: "params", params: { enabled: true, gate: { enabled: false }, compressor: { enabled: false }, limiter: { enabled: false } } },
    });
    expect(proc.chain.enabled).toBe(true);
    const output = [[new Float32Array(FRAME)]];
    const result = proc.process([[]], output);
    expect(result).toBe(true);
    // 无输入 → 输出静音
    for (let i = 0; i < FRAME; i++) {
      expect(output[0]![0]![i]).toBe(0);
    }
  });
});
