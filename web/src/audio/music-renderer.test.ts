import { describe, expect, it } from "vitest";
import type { MusicScore } from "@shared/music/score.js";
import {
  MUSIC_RENDER_SAMPLE_RATE,
  MUSIC_REVERB_SECONDS,
  audioBufferToWavBlob,
  beatSeconds,
  foldTailIntoLoop,
  loopSeconds,
  nearestSampleMidi,
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
    // 值全部 <1，不触发峰值护栏（护栏行为另测）。
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

  it("峰值超 1 时整体缩到 0.98 护栏内", () => {
    const folded = foldTailIntoLoop(fakeBuffer([new Float32Array([2, -2, 0.5, 0.25, 3, -3])]), 4);
    const peak = Math.max(...Array.from(folded[0]!).map(Math.abs));
    expect(peak).toBeCloseTo(0.98);
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
