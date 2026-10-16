import { describe, expect, it } from "vitest";
import {
  MUSIC_MAX_TOTAL_NOTES,
  MusicScoreSchema,
  midiToFreq,
  scoreLoopBeats,
  type MusicScore,
  type MusicTrack,
} from "./score.js";

function makeScore(overrides: Partial<MusicScore> = {}): MusicScore {
  return {
    version: 1,
    bpm: 92,
    key: 0,
    mode: "major",
    bars: 16,
    tracks: [
      {
        instrument: "piano",
        gain: 0.8,
        notes: [
          { beat: 0, dur: 1, midi: 60, vel: 90 },
          { beat: 2, dur: 0.5, midi: 64, vel: 70 },
        ],
      },
    ],
    ...overrides,
  };
}

describe("MusicScoreSchema", () => {
  it("接受合法谱面", () => {
    expect(MusicScoreSchema.safeParse(makeScore()).success).toBe(true);
  });

  it("拒绝循环外的音符起拍", () => {
    const result = MusicScoreSchema.safeParse(
      makeScore({
        tracks: [
          {
            instrument: "piano",
            gain: 0.8,
            notes: [{ beat: 64, dur: 1, midi: 60, vel: 90 }], // 16 小节 = 64 拍
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("允许音符时值跨过循环点（尾巴由渲染层卷回头部）", () => {
    const result = MusicScoreSchema.safeParse(
      makeScore({
        tracks: [
          {
            instrument: "piano",
            gain: 0.8,
            notes: [{ beat: 63.5, dur: 2, midi: 60, vel: 90 }],
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("拒绝同乐器多条轨道", () => {
    const track: MusicTrack = {
      instrument: "piano",
      gain: 0.8,
      notes: [{ beat: 0, dur: 1, midi: 60, vel: 90 }],
    };
    const result = MusicScoreSchema.safeParse(makeScore({ tracks: [track, track] }));
    expect(result.success).toBe(false);
  });

  it("拒绝音符总量超上限", () => {
    const notes = Array.from({ length: MUSIC_MAX_TOTAL_NOTES + 1 }, (_, i) => ({
      beat: i % 64,
      dur: 1,
      midi: 60,
      vel: 90,
    }));
    const result = MusicScoreSchema.safeParse(
      makeScore({ tracks: [{ instrument: "piano", gain: 1, notes }] }),
    );
    expect(result.success).toBe(false);
  });

  it("拒绝未知字段（strict）与非法枚举", () => {
    expect(
      MusicScoreSchema.safeParse({ ...makeScore(), extra: 1 }).success,
    ).toBe(false);
    expect(
      MusicScoreSchema.safeParse(makeScore({ mode: "phrygian" as never })).success,
    ).toBe(false);
  });
});

describe("music math", () => {
  it("scoreLoopBeats 按 4/4 折算", () => {
    expect(scoreLoopBeats({ bars: 16 })).toBe(64);
    expect(scoreLoopBeats({ bars: 8 })).toBe(32);
  });

  it("midiToFreq 以 A4=440 为基准", () => {
    expect(midiToFreq(69)).toBeCloseTo(440);
    expect(midiToFreq(60)).toBeCloseTo(261.63, 1);
    expect(midiToFreq(81)).toBeCloseTo(880);
  });
});
