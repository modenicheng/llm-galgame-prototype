import { describe, expect, it } from "vitest";
import type { MusicScore } from "./score.js";
import {
  ComposerDecisionSchema,
  MusicThemeMetaSchema,
  extractMotifHint,
  themeScoreStats,
} from "./theme.js";

const score: MusicScore = {
  version: 1,
  bpm: 92,
  key: 9,
  mode: "minor",
  bars: 16,
  tracks: [
    {
      instrument: "pad",
      gain: 0.5,
      notes: [
        { beat: 0, dur: 8, midi: 45, vel: 50 },
        { beat: 8, dur: 8, midi: 52, vel: 50 },
        { beat: 16, dur: 8, midi: 45, vel: 50 },
        { beat: 24, dur: 8, midi: 52, vel: 50 },
      ],
    },
    {
      instrument: "piano",
      gain: 0.8,
      notes: [
        { beat: 0, dur: 1, midi: 69, vel: 90 },
        { beat: 2, dur: 1, midi: 72, vel: 90 },
        { beat: 4, dur: 1, midi: 71, vel: 90 },
        { beat: 6, dur: 1, midi: 67, vel: 90 },
        { beat: 8, dur: 1, midi: 69, vel: 90 },
        { beat: 10, dur: 1, midi: 74, vel: 90 },
      ],
    },
    {
      instrument: "bell",
      gain: 0.4,
      notes: [
        { beat: 1, dur: 0.5, midi: 84, vel: 60 },
        { beat: 5, dur: 0.5, midi: 88, vel: 60 },
        { beat: 9, dur: 0.5, midi: 84, vel: 60 },
        { beat: 13, dur: 0.5, midi: 91, vel: 60 },
      ],
    },
  ],
};

describe("MusicThemeMetaSchema", () => {
  it("接受合法元数据（可选字段缺省）", () => {
    const parsed = MusicThemeMetaSchema.safeParse({
      id: "fortress-echo",
      title: "堡垒回响",
      concept: "地下堡垒——压抑的机械回响",
    });
    expect(parsed.success).toBe(true);
  });

  it("拒收坏 slug / 超长 / 多余键 / 幻觉 motifHint 形状", () => {
    expect(
      MusicThemeMetaSchema.safeParse({ id: "Bad_Slug", title: "t", concept: "c" }).success,
    ).toBe(false);
    expect(
      MusicThemeMetaSchema.safeParse({
        id: "x/../escape",
        title: "t",
        concept: "c",
      }).success,
    ).toBe(false);
    expect(
      MusicThemeMetaSchema.safeParse({
        id: "ok",
        title: "t".repeat(21),
        concept: "c",
      }).success,
    ).toBe(false);
    expect(
      MusicThemeMetaSchema.safeParse({ id: "ok", title: "t", concept: "c", extra: 1 }).success,
    ).toBe(false);
    // motifHint 必须是 4–8 个逗号分隔数字（服务层提取，非 LLM 自由文本）。
    expect(
      MusicThemeMetaSchema.safeParse({
        id: "ok",
        title: "t",
        concept: "c",
        motifHint: "60,64",
      }).success,
    ).toBe(false);
    expect(
      MusicThemeMetaSchema.safeParse({
        id: "ok",
        title: "t",
        concept: "c",
        motifHint: "60,64,67,72",
      }).success,
    ).toBe(true);
  });
});

describe("ComposerDecisionSchema", () => {
  it("reuse 分支：themeId + reason", () => {
    const parsed = ComposerDecisionSchema.safeParse({
      action: "reuse",
      themeId: "fortress-echo",
      reason: "同一地下堡垒区域，日夜共用主题",
    });
    expect(parsed.success).toBe(true);
  });

  it("compose 分支：theme 输入 + 谱面；LLM 写 motifHint 被拒（防幻觉）", () => {
    const themeInput = {
      id: "market-dawn",
      title: "晨市",
      concept: "港口晨市——市井喧嚣渐醒",
      style: "五声音阶、bell 前置",
    };
    const composeBody = {
      action: "compose",
      theme: themeInput,
      score,
      reason: "新区域无相近主题",
    };
    expect(ComposerDecisionSchema.safeParse(composeBody).success).toBe(true);
    expect(
      ComposerDecisionSchema.safeParse({
        ...composeBody,
        theme: { ...themeInput, motifHint: "60,61,62,63" },
      }).success,
    ).toBe(false);
  });

  it("未知 action 拒收", () => {
    expect(ComposerDecisionSchema.safeParse({ action: "remix" }).success).toBe(false);
  });
});

describe("extractMotifHint", () => {
  it("取非铺底轨中平均音高最高者，按起拍排序取头 8 音", () => {
    // bell 平均音高最高（84+88+84+91)/4 ≈ 86.75 > piano 70.33 → 取 bell。
    expect(extractMotifHint(score)).toBe("84,88,84,91");
  });

  it("铺底轨不承载动机；音符 <4 的轨不参与；无候选 = undefined", () => {
    const padOnly: MusicScore = {
      ...score,
      tracks: [score.tracks[0]!], // pad
    };
    expect(extractMotifHint(padOnly)).toBeUndefined();
    const sparse: MusicScore = {
      ...score,
      tracks: [
        {
          instrument: "piano",
          gain: 0.8,
          notes: [
            { beat: 0, dur: 1, midi: 60, vel: 90 },
            { beat: 4, dur: 1, midi: 64, vel: 90 },
          ],
        },
      ],
    };
    expect(extractMotifHint(sparse)).toBeUndefined();
  });

  it("同谱恒同值（确定性）", () => {
    expect(extractMotifHint(score)).toBe(extractMotifHint(score));
  });
});

describe("themeScoreStats", () => {
  it("统计 bpm/key/mode/乐器/音符数/循环秒数", () => {
    const stats = themeScoreStats(score);
    expect(stats).toEqual({
      bpm: 92,
      key: 9,
      mode: "minor",
      bars: 16,
      instruments: ["pad", "piano", "bell"],
      noteCount: 14,
      loopSeconds: (16 * 4 * 60) / 92,
    });
  });
});
