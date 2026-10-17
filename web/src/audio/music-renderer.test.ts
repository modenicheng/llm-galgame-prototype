import { describe, expect, it } from "vitest";
import type { MusicScore } from "@shared/music/score.js";
import {
  MUSIC_LOUDNESS_PEAK_DB,
  MUSIC_LOUDNESS_TARGET_DB,
  MUSIC_RENDER_SAMPLE_RATE,
  MUSIC_REVERB_SECONDS,
  audioBufferToWavBlob,
  beatSeconds,
  foldTailIntoLoop,
  loopSeconds,
  nearestSampleMidi,
  normalizeLoudness,
  tailSamples,
} from "./music-renderer.js";

const score: MusicScore = {
  version: 1,
  bpm: 96,
  key: 0,
  mode: "major",
  bars: 16,
  tracks: [
    { instrument: "piano", gain: 0.8, notes: [{ beat: 0, dur: 1, midi: 60, vel: 90 }] },
  ],
};

describe("music renderer 时值数学", () => {
  it("loopSeconds 按 4/4 小节折算", () => {
    expect(loopSeconds(score)).toBeCloseTo((64 * 60) / 96); // 40s
  });

  it("beatSeconds 与 loopSeconds 同基准", () => {
    expect(beatSeconds(score, 64)).toBeCloseTo(loopSeconds(score));
    expect(beatSeconds(score, 1)).toBeCloseTo(60 / 96);
  });

  it("尾部区 ≥ 混响 RT60", () => {
    expect(tailSamples(MUSIC_RENDER_SAMPLE_RATE)).toBe(
      Math.ceil(MUSIC_REVERB_SECONDS * MUSIC_RENDER_SAMPLE_RATE),
    );
  });
});

describe("nearestSampleMidi", () => {
  it("取包内最近采样键", () => {
    expect(nearestSampleMidi([60, 64, 67], 62)).toBe(60);
    expect(nearestSampleMidi([60, 64, 67], 66)).toBe(67);
    expect(nearestSampleMidi([60], 60)).toBe(60);
    expect(nearestSampleMidi([], 60)).toBeUndefined();
  });
});

describe("foldTailIntoLoop", () => {
  function fakeBuffer(channels: Float32Array<ArrayBuffer>[]): Pick<
    AudioBuffer,
    "numberOfChannels" | "length" | "getChannelData"
  > {
    return {
      numberOfChannels: channels.length,
      length: channels[0]!.length,
      getChannelData: (ch: number) => channels[ch]!,
    };
  }

  it("尾部样本叠回头部对应位置", () => {
    const folded = foldTailIntoLoop(
      fakeBuffer([new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.25])]),
      4,
    );
    expect(folded).toHaveLength(1);
    const channel = Array.from(folded[0]!);
    expect(channel).toHaveLength(4);
    expect(channel[0]).toBeCloseTo(0.6); // 0.1 + 尾部 0.5
    expect(channel[1]).toBeCloseTo(0.45); // 0.2 + 尾部 0.25
    expect(channel[2]).toBeCloseTo(0.3);
    expect(channel[3]).toBeCloseTo(0.4);
  });

  it("V2 起折叠不再做峰值护栏（归一化交 normalizeLoudness）", () => {
    const folded = foldTailIntoLoop(fakeBuffer([new Float32Array([2, -2, 0.5, 0.25, 3, -3])]), 4);
    expect(Array.from(folded[0]!)[0]).toBeCloseTo(5); // 2 + 尾部 3，原样保留
  });
});

describe("normalizeLoudness（母带后处理纯函数）", () => {
  function rms(channels: Float32Array<ArrayBuffer>[]): number {
    let sum = 0;
    let count = 0;
    for (const channel of channels) {
      for (const sample of channel) {
        sum += sample * sample;
        count += 1;
      }
    }
    return Math.sqrt(sum / count);
  }

  function peak(channels: Float32Array<ArrayBuffer>[]): number {
    let peak = 0;
    for (const channel of channels) {
      for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
    }
    return peak;
  }

  it("RMS 归一到 -16 dBFS（响度增益主导）", () => {
    // 峰值 0.2 的中等信号：RMS 远低于目标，增益不被峰值钳制。
    const channels = [new Float32Array(Array.from({ length: 1000 }, (_, i) => 0.2 * Math.sin(i)))];
    normalizeLoudness(channels);
    const expected = 10 ** (MUSIC_LOUDNESS_TARGET_DB / 20);
    expect(rms(channels)).toBeCloseTo(expected, 2);
  });

  it("峰值钳 -1 dBFS：响度增益被钳制时不削波", () => {
    // 稀疏尖峰：RMS 很小 → 目标增益巨大，但峰值钳制优先（峰值正好贴上限）。
    const samples = new Float32Array(200);
    samples[0] = 0.9;
    const channels = [samples];
    normalizeLoudness(channels);
    const ceiling = 10 ** (MUSIC_LOUDNESS_PEAK_DB / 20);
    expect(peak(channels)).toBeCloseTo(ceiling, 6);
    expect(peak(channels)).toBeLessThanOrEqual(1);
  });

  it("全通道联合归一（立体声左右同增益，声像保持）", () => {
    const left = new Float32Array([0.1, 0.1, 0.1, 0.1]);
    const right = new Float32Array([0.2, 0.2, 0.2, 0.2]);
    normalizeLoudness([left, right]);
    // 左右同乘一个增益（联合 RMS），相对能量比不变。
    expect(left[0]! / 0.1).toBeCloseTo(right[0]! / 0.2, 6);
  });

  it("静音与空输入不动（除零防御）", () => {
    const silence = [new Float32Array([0, 0, 0])];
    normalizeLoudness(silence);
    expect(Array.from(silence[0]!)).toEqual([0, 0, 0]);
    expect(() => normalizeLoudness([])).not.toThrow();
  });
});

describe("audioBufferToWavBlob", () => {
  it("PCM16 WAV 头与数据块长度正确", async () => {
    const buffer = {
      numberOfChannels: 1,
      length: 2,
      sampleRate: 8000,
      getChannelData: () => Float32Array.of(0.5, -0.5),
    } as unknown as AudioBuffer;
    const blob = audioBufferToWavBlob(buffer);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // 单声道
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true)).toBe(4); // 2 样本 × 2 字节
    expect(view.getInt16(44, true)).toBeCloseTo(0.5 * 0x7fff, -1);
    expect(view.getInt16(46, true)).toBeCloseTo(-0.5 * 0x8000, -1);
  });
});
