/**
 * 试听基线谱面（真实 glm-5.3-flash 作曲产物，2026-10-16/17 经
 * scripts/probe-music-composer.ts --save 采集）——渲染器听感调参的固定
 * A/B 基线：改增益/混响/包络后重听对比，谱面恒定。覆盖对比维度：速度
 * 与密度（紧张/高潮 vs 悲伤）、音色组合（钢琴主导 vs 全奏）、风格语汇
 * （稀疏五声 vs dorian 竖琴，与同情绪默认曲 A/B）。
 */
import type { MusicScore, SceneMusicDirection } from "@shared/music/score.js";

export interface DemoScore {
  label: string;
  direction: SceneMusicDirection;
  score: MusicScore;
}

export const DEMO_SCORES: DemoScore[] = [
  {
    label: "紧张 · 强度 2",
    direction: { mood: "tense", intensity: 2, note: "弦乐持续低音铺垫，钢琴急促短音型制造压迫感" },
    score: {
      "version": 1,
      "bpm": 132,
      "key": 9,
      "mode": "minor",
      "bars": 16,
      "tracks": [
        {
          "instrument": "strings",
          "gain": 0.7,
          "notes": [
            {
              "beat": 0,
              "dur": 8,
              "midi": 57,
              "vel": 72
            },
            {
              "beat": 0,
              "dur": 8,
              "midi": 60,
              "vel": 60
            },
            {
              "beat": 8,
              "dur": 8,
              "midi": 56,
              "vel": 72
            },
            {
              "beat": 8,
              "dur": 8,
              "midi": 59,
              "vel": 60
            },
            {
              "beat": 16,
              "dur": 8,
              "midi": 52,
              "vel": 70
            },
            {
              "beat": 16,
              "dur": 8,
              "midi": 56,
              "vel": 58
            },
            {
              "beat": 24,
              "dur": 8,
              "midi": 55,
              "vel": 70
            },
            {
              "beat": 24,
              "dur": 8,
              "midi": 59,
              "vel": 58
            },
            {
              "beat": 32,
              "dur": 8,
              "midi": 57,
              "vel": 72
            },
            {
              "beat": 32,
              "dur": 8,
              "midi": 60,
              "vel": 60
            },
            {
              "beat": 40,
              "dur": 8,
              "midi": 56,
              "vel": 72
            },
            {
              "beat": 40,
              "dur": 8,
              "midi": 59,
              "vel": 60
            },
            {
              "beat": 48,
              "dur": 8,
              "midi": 52,
              "vel": 70
            },
            {
              "beat": 48,
              "dur": 8,
              "midi": 56,
              "vel": 58
            },
            {
              "beat": 56,
              "dur": 6,
              "midi": 55,
              "vel": 70
            },
            {
              "beat": 56,
              "dur": 6,
              "midi": 59,
              "vel": 58
            },
            {
              "beat": 62,
              "dur": 2,
              "midi": 58,
              "vel": 74
            },
            {
              "beat": 62,
              "dur": 2,
              "midi": 61,
              "vel": 60
            }
          ]
        },
        {
          "instrument": "piano",
          "gain": 0.8,
          "notes": [
            {
              "beat": 0,
              "dur": 0.5,
              "midi": 69,
              "vel": 100
            },
            {
              "beat": 0.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 92
            },
            {
              "beat": 1,
              "dur": 0.5,
              "midi": 69,
              "vel": 88
            },
            {
              "beat": 1.5,
              "dur": 0.5,
              "midi": 76,
              "vel": 96
            },
            {
              "beat": 2,
              "dur": 0.5,
              "midi": 72,
              "vel": 90
            },
            {
              "beat": 2.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 84
            },
            {
              "beat": 3,
              "dur": 0.5,
              "midi": 67,
              "vel": 92
            },
            {
              "beat": 3.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 86
            },
            {
              "beat": 4,
              "dur": 0.5,
              "midi": 68,
              "vel": 100
            },
            {
              "beat": 4.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 92
            },
            {
              "beat": 5,
              "dur": 0.5,
              "midi": 68,
              "vel": 88
            },
            {
              "beat": 5.5,
              "dur": 0.5,
              "midi": 75,
              "vel": 96
            },
            {
              "beat": 6,
              "dur": 0.5,
              "midi": 72,
              "vel": 90
            },
            {
              "beat": 6.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 84
            },
            {
              "beat": 7,
              "dur": 0.5,
              "midi": 67,
              "vel": 92
            },
            {
              "beat": 7.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 86
            },
            {
              "beat": 8,
              "dur": 0.5,
              "midi": 64,
              "vel": 100
            },
            {
              "beat": 8.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 92
            },
            {
              "beat": 9,
              "dur": 0.5,
              "midi": 64,
              "vel": 88
            },
            {
              "beat": 9.5,
              "dur": 0.5,
              "midi": 71,
              "vel": 96
            },
            {
              "beat": 10,
              "dur": 0.5,
              "midi": 68,
              "vel": 90
            },
            {
              "beat": 10.5,
              "dur": 0.5,
              "midi": 64,
              "vel": 84
            },
            {
              "beat": 11,
              "dur": 0.5,
              "midi": 62,
              "vel": 92
            },
            {
              "beat": 11.5,
              "dur": 0.5,
              "midi": 64,
              "vel": 86
            },
            {
              "beat": 12,
              "dur": 0.5,
              "midi": 67,
              "vel": 100
            },
            {
              "beat": 12.5,
              "dur": 0.5,
              "midi": 71,
              "vel": 92
            },
            {
              "beat": 13,
              "dur": 0.5,
              "midi": 67,
              "vel": 88
            },
            {
              "beat": 13.5,
              "dur": 0.5,
              "midi": 74,
              "vel": 96
            },
            {
              "beat": 14,
              "dur": 0.5,
              "midi": 71,
              "vel": 90
            },
            {
              "beat": 14.5,
              "dur": 0.5,
              "midi": 67,
              "vel": 84
            },
            {
              "beat": 15,
              "dur": 0.5,
              "midi": 66,
              "vel": 92
            },
            {
              "beat": 15.5,
              "dur": 0.5,
              "midi": 67,
              "vel": 86
            },
            {
              "beat": 16,
              "dur": 0.5,
              "midi": 69,
              "vel": 100
            },
            {
              "beat": 16.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 92
            },
            {
              "beat": 17,
              "dur": 0.5,
              "midi": 69,
              "vel": 88
            },
            {
              "beat": 17.5,
              "dur": 0.5,
              "midi": 76,
              "vel": 96
            },
            {
              "beat": 18,
              "dur": 0.5,
              "midi": 72,
              "vel": 90
            },
            {
              "beat": 18.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 84
            },
            {
              "beat": 19,
              "dur": 0.5,
              "midi": 67,
              "vel": 92
            },
            {
              "beat": 19.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 86
            },
            {
              "beat": 20,
              "dur": 0.5,
              "midi": 68,
              "vel": 100
            },
            {
              "beat": 20.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 92
            },
            {
              "beat": 21,
              "dur": 0.5,
              "midi": 68,
              "vel": 88
            },
            {
              "beat": 21.5,
              "dur": 0.5,
              "midi": 75,
              "vel": 96
            },
            {
              "beat": 22,
              "dur": 0.5,
              "midi": 72,
              "vel": 90
            },
            {
              "beat": 22.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 84
            },
            {
              "beat": 23,
              "dur": 0.5,
              "midi": 67,
              "vel": 92
            },
            {
              "beat": 23.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 86
            },
            {
              "beat": 24,
              "dur": 0.5,
              "midi": 64,
              "vel": 100
            },
            {
              "beat": 24.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 92
            },
            {
              "beat": 25,
              "dur": 0.5,
              "midi": 64,
              "vel": 88
            },
            {
              "beat": 25.5,
              "dur": 0.5,
              "midi": 71,
              "vel": 96
            },
            {
              "beat": 26,
              "dur": 0.5,
              "midi": 68,
              "vel": 90
            },
            {
              "beat": 26.5,
              "dur": 0.5,
              "midi": 64,
              "vel": 84
            },
            {
              "beat": 27,
              "dur": 0.5,
              "midi": 62,
              "vel": 92
            },
            {
              "beat": 27.5,
              "dur": 0.5,
              "midi": 64,
              "vel": 86
            },
            {
              "beat": 28,
              "dur": 0.5,
              "midi": 67,
              "vel": 100
            },
            {
              "beat": 28.5,
              "dur": 0.5,
              "midi": 71,
              "vel": 92
            },
            {
              "beat": 29,
              "dur": 0.5,
              "midi": 67,
              "vel": 88
            },
            {
              "beat": 29.5,
              "dur": 0.5,
              "midi": 74,
              "vel": 96
            },
            {
              "beat": 30,
              "dur": 0.5,
              "midi": 71,
              "vel": 90
            },
            {
              "beat": 30.5,
              "dur": 0.5,
              "midi": 67,
              "vel": 84
            },
            {
              "beat": 31,
              "dur": 0.5,
              "midi": 66,
              "vel": 92
            },
            {
              "beat": 31.5,
              "dur": 0.5,
              "midi": 67,
              "vel": 86
            },
            {
              "beat": 32,
              "dur": 0.5,
              "midi": 69,
              "vel": 104
            },
            {
              "beat": 32.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 96
            },
            {
              "beat": 33,
              "dur": 0.5,
              "midi": 76,
              "vel": 92
            },
            {
              "beat": 33.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 96
            },
            {
              "beat": 34,
              "dur": 0.5,
              "midi": 69,
              "vel": 100
            },
            {
              "beat": 34.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 92
            },
            {
              "beat": 35,
              "dur": 0.5,
              "midi": 76,
              "vel": 98
            },
            {
              "beat": 35.5,
              "dur": 0.5,
              "midi": 79,
              "vel": 100
            },
            {
              "beat": 36,
              "dur": 0.5,
              "midi": 68,
              "vel": 104
            },
            {
              "beat": 36.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 96
            },
            {
              "beat": 37,
              "dur": 0.5,
              "midi": 75,
              "vel": 92
            },
            {
              "beat": 37.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 96
            },
            {
              "beat": 38,
              "dur": 0.5,
              "midi": 68,
              "vel": 100
            },
            {
              "beat": 38.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 92
            },
            {
              "beat": 39,
              "dur": 0.5,
              "midi": 75,
              "vel": 98
            },
            {
              "beat": 39.5,
              "dur": 0.5,
              "midi": 78,
              "vel": 100
            },
            {
              "beat": 40,
              "dur": 0.5,
              "midi": 64,
              "vel": 104
            },
            {
              "beat": 40.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 96
            },
            {
              "beat": 41,
              "dur": 0.5,
              "midi": 71,
              "vel": 92
            },
            {
              "beat": 41.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 96
            },
            {
              "beat": 42,
              "dur": 0.5,
              "midi": 64,
              "vel": 100
            },
            {
              "beat": 42.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 92
            },
            {
              "beat": 43,
              "dur": 0.5,
              "midi": 71,
              "vel": 98
            },
            {
              "beat": 43.5,
              "dur": 0.5,
              "midi": 74,
              "vel": 100
            },
            {
              "beat": 44,
              "dur": 0.5,
              "midi": 67,
              "vel": 104
            },
            {
              "beat": 44.5,
              "dur": 0.5,
              "midi": 71,
              "vel": 96
            },
            {
              "beat": 45,
              "dur": 0.5,
              "midi": 74,
              "vel": 92
            },
            {
              "beat": 45.5,
              "dur": 0.5,
              "midi": 71,
              "vel": 96
            },
            {
              "beat": 46,
              "dur": 0.5,
              "midi": 67,
              "vel": 100
            },
            {
              "beat": 46.5,
              "dur": 0.5,
              "midi": 71,
              "vel": 92
            },
            {
              "beat": 47,
              "dur": 0.5,
              "midi": 74,
              "vel": 98
            },
            {
              "beat": 47.5,
              "dur": 0.5,
              "midi": 78,
              "vel": 100
            },
            {
              "beat": 48,
              "dur": 0.5,
              "midi": 69,
              "vel": 100
            },
            {
              "beat": 48.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 92
            },
            {
              "beat": 49,
              "dur": 0.5,
              "midi": 69,
              "vel": 88
            },
            {
              "beat": 49.5,
              "dur": 0.5,
              "midi": 76,
              "vel": 96
            },
            {
              "beat": 50,
              "dur": 0.5,
              "midi": 72,
              "vel": 90
            },
            {
              "beat": 50.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 84
            },
            {
              "beat": 51,
              "dur": 0.5,
              "midi": 67,
              "vel": 92
            },
            {
              "beat": 51.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 86
            },
            {
              "beat": 52,
              "dur": 0.5,
              "midi": 68,
              "vel": 100
            },
            {
              "beat": 52.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 92
            },
            {
              "beat": 53,
              "dur": 0.5,
              "midi": 68,
              "vel": 88
            },
            {
              "beat": 53.5,
              "dur": 0.5,
              "midi": 75,
              "vel": 96
            },
            {
              "beat": 54,
              "dur": 0.5,
              "midi": 72,
              "vel": 90
            },
            {
              "beat": 54.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 84
            },
            {
              "beat": 55,
              "dur": 0.5,
              "midi": 67,
              "vel": 92
            },
            {
              "beat": 55.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 86
            },
            {
              "beat": 56,
              "dur": 0.5,
              "midi": 64,
              "vel": 100
            },
            {
              "beat": 56.5,
              "dur": 0.5,
              "midi": 68,
              "vel": 92
            },
            {
              "beat": 57,
              "dur": 0.5,
              "midi": 64,
              "vel": 88
            },
            {
              "beat": 57.5,
              "dur": 0.5,
              "midi": 71,
              "vel": 96
            },
            {
              "beat": 58,
              "dur": 0.5,
              "midi": 68,
              "vel": 90
            },
            {
              "beat": 58.5,
              "dur": 0.5,
              "midi": 64,
              "vel": 84
            },
            {
              "beat": 59,
              "dur": 0.5,
              "midi": 62,
              "vel": 92
            },
            {
              "beat": 59.5,
              "dur": 0.5,
              "midi": 64,
              "vel": 86
            },
            {
              "beat": 60,
              "dur": 0.5,
              "midi": 67,
              "vel": 100
            },
            {
              "beat": 60.5,
              "dur": 0.5,
              "midi": 71,
              "vel": 92
            },
            {
              "beat": 61,
              "dur": 0.5,
              "midi": 67,
              "vel": 88
            },
            {
              "beat": 61.5,
              "dur": 0.5,
              "midi": 74,
              "vel": 96
            },
            {
              "beat": 62,
              "dur": 0.5,
              "midi": 73,
              "vel": 98
            },
            {
              "beat": 62.5,
              "dur": 0.5,
              "midi": 74,
              "vel": 100
            },
            {
              "beat": 63,
              "dur": 0.5,
              "midi": 76,
              "vel": 102
            },
            {
              "beat": 63.5,
              "dur": 0.5,
              "midi": 79,
              "vel": 104
            }
          ]
        },
        {
          "instrument": "bass",
          "gain": 0.8,
          "notes": [
            {
              "beat": 0,
              "dur": 0.9,
              "midi": 45,
              "vel": 96
            },
            {
              "beat": 1,
              "dur": 0.9,
              "midi": 45,
              "vel": 88
            },
            {
              "beat": 2,
              "dur": 0.9,
              "midi": 45,
              "vel": 94
            },
            {
              "beat": 3,
              "dur": 0.9,
              "midi": 45,
              "vel": 88
            },
            {
              "beat": 4,
              "dur": 0.9,
              "midi": 44,
              "vel": 96
            },
            {
              "beat": 5,
              "dur": 0.9,
              "midi": 44,
              "vel": 88
            },
            {
              "beat": 6,
              "dur": 0.9,
              "midi": 44,
              "vel": 94
            },
            {
              "beat": 7,
              "dur": 0.9,
              "midi": 44,
              "vel": 88
            },
            {
              "beat": 8,
              "dur": 0.9,
              "midi": 40,
              "vel": 96
            },
            {
              "beat": 9,
              "dur": 0.9,
              "midi": 40,
              "vel": 88
            },
            {
              "beat": 10,
              "dur": 0.9,
              "midi": 40,
              "vel": 94
            },
            {
              "beat": 11,
              "dur": 0.9,
              "midi": 40,
              "vel": 88
            },
            {
              "beat": 12,
              "dur": 0.9,
              "midi": 43,
              "vel": 96
            },
            {
              "beat": 13,
              "dur": 0.9,
              "midi": 43,
              "vel": 88
            },
            {
              "beat": 14,
              "dur": 0.9,
              "midi": 43,
              "vel": 94
            },
            {
              "beat": 15,
              "dur": 0.9,
              "midi": 43,
              "vel": 88
            },
            {
              "beat": 16,
              "dur": 0.9,
              "midi": 45,
              "vel": 96
            },
            {
              "beat": 17,
              "dur": 0.9,
              "midi": 45,
              "vel": 88
            },
            {
              "beat": 18,
              "dur": 0.9,
              "midi": 45,
              "vel": 94
            },
            {
              "beat": 19,
              "dur": 0.9,
              "midi": 45,
              "vel": 88
            },
            {
              "beat": 20,
              "dur": 0.9,
              "midi": 44,
              "vel": 96
            },
            {
              "beat": 21,
              "dur": 0.9,
              "midi": 44,
              "vel": 88
            },
            {
              "beat": 22,
              "dur": 0.9,
              "midi": 44,
              "vel": 94
            },
            {
              "beat": 23,
              "dur": 0.9,
              "midi": 44,
              "vel": 88
            },
            {
              "beat": 24,
              "dur": 0.9,
              "midi": 40,
              "vel": 96
            },
            {
              "beat": 25,
              "dur": 0.9,
              "midi": 40,
              "vel": 88
            },
            {
              "beat": 26,
              "dur": 0.9,
              "midi": 40,
              "vel": 94
            },
            {
              "beat": 27,
              "dur": 0.9,
              "midi": 40,
              "vel": 88
            },
            {
              "beat": 28,
              "dur": 0.9,
              "midi": 43,
              "vel": 96
            },
            {
              "beat": 29,
              "dur": 0.9,
              "midi": 43,
              "vel": 88
            },
            {
              "beat": 30,
              "dur": 0.9,
              "midi": 43,
              "vel": 94
            },
            {
              "beat": 31,
              "dur": 0.9,
              "midi": 43,
              "vel": 88
            },
            {
              "beat": 32,
              "dur": 0.9,
              "midi": 45,
              "vel": 96
            },
            {
              "beat": 33,
              "dur": 0.9,
              "midi": 45,
              "vel": 88
            },
            {
              "beat": 34,
              "dur": 0.9,
              "midi": 45,
              "vel": 94
            },
            {
              "beat": 35,
              "dur": 0.9,
              "midi": 45,
              "vel": 88
            },
            {
              "beat": 36,
              "dur": 0.9,
              "midi": 44,
              "vel": 96
            },
            {
              "beat": 37,
              "dur": 0.9,
              "midi": 44,
              "vel": 88
            },
            {
              "beat": 38,
              "dur": 0.9,
              "midi": 44,
              "vel": 94
            },
            {
              "beat": 39,
              "dur": 0.9,
              "midi": 44,
              "vel": 88
            },
            {
              "beat": 40,
              "dur": 0.9,
              "midi": 40,
              "vel": 96
            },
            {
              "beat": 41,
              "dur": 0.9,
              "midi": 40,
              "vel": 88
            },
            {
              "beat": 42,
              "dur": 0.9,
              "midi": 40,
              "vel": 94
            },
            {
              "beat": 43,
              "dur": 0.9,
              "midi": 40,
              "vel": 88
            },
            {
              "beat": 44,
              "dur": 0.9,
              "midi": 43,
              "vel": 96
            },
            {
              "beat": 45,
              "dur": 0.9,
              "midi": 43,
              "vel": 88
            },
            {
              "beat": 46,
              "dur": 0.9,
              "midi": 43,
              "vel": 94
            },
            {
              "beat": 47,
              "dur": 0.9,
              "midi": 43,
              "vel": 88
            },
            {
              "beat": 48,
              "dur": 0.9,
              "midi": 45,
              "vel": 96
            },
            {
              "beat": 49,
              "dur": 0.9,
              "midi": 45,
              "vel": 88
            },
            {
              "beat": 50,
              "dur": 0.9,
              "midi": 45,
              "vel": 94
            },
            {
              "beat": 51,
              "dur": 0.9,
              "midi": 45,
              "vel": 88
            },
            {
              "beat": 52,
              "dur": 0.9,
              "midi": 44,
              "vel": 96
            },
            {
              "beat": 53,
              "dur": 0.9,
              "midi": 44,
              "vel": 88
            },
            {
              "beat": 54,
              "dur": 0.9,
              "midi": 44,
              "vel": 94
            },
            {
              "beat": 55,
              "dur": 0.9,
              "midi": 44,
              "vel": 88
            },
            {
              "beat": 56,
              "dur": 0.9,
              "midi": 40,
              "vel": 96
            },
            {
              "beat": 57,
              "dur": 0.9,
              "midi": 40,
              "vel": 88
            },
            {
              "beat": 58,
              "dur": 0.9,
              "midi": 40,
              "vel": 94
            },
            {
              "beat": 59,
              "dur": 0.9,
              "midi": 40,
              "vel": 88
            },
            {
              "beat": 60,
              "dur": 0.9,
              "midi": 43,
              "vel": 96
            },
            {
              "beat": 61,
              "dur": 0.9,
              "midi": 43,
              "vel": 88
            },
            {
              "beat": 62,
              "dur": 0.9,
              "midi": 46,
              "vel": 98
            },
            {
              "beat": 63,
              "dur": 0.9,
              "midi": 46,
              "vel": 90
            }
          ]
        }
      ]
    },
  },
  {
    label: "悲伤 · 强度 1",
    direction: { mood: "sorrowful", intensity: 1, note: "钢琴独奏为主，弦乐长音远远铺底，慢速呼吸感" },
    score: {
      "version": 1,
      "bpm": 54,
      "key": 9,
      "mode": "minor",
      "bars": 16,
      "tracks": [
        {
          "instrument": "piano",
          "gain": 0.85,
          "notes": [
            {
              "beat": 0,
              "dur": 1,
              "midi": 57,
              "vel": 62
            },
            {
              "beat": 1,
              "dur": 1,
              "midi": 64,
              "vel": 58
            },
            {
              "beat": 2,
              "dur": 1,
              "midi": 69,
              "vel": 60
            },
            {
              "beat": 3,
              "dur": 1,
              "midi": 72,
              "vel": 66
            },
            {
              "beat": 4,
              "dur": 1,
              "midi": 76,
              "vel": 78
            },
            {
              "beat": 5,
              "dur": 1.5,
              "midi": 72,
              "vel": 64
            },
            {
              "beat": 6.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 50
            },
            {
              "beat": 7,
              "dur": 1,
              "midi": 64,
              "vel": 52
            },
            {
              "beat": 8,
              "dur": 1,
              "midi": 53,
              "vel": 58
            },
            {
              "beat": 9,
              "dur": 1,
              "midi": 60,
              "vel": 56
            },
            {
              "beat": 10,
              "dur": 1,
              "midi": 65,
              "vel": 58
            },
            {
              "beat": 11,
              "dur": 1,
              "midi": 69,
              "vel": 62
            },
            {
              "beat": 12,
              "dur": 2,
              "midi": 72,
              "vel": 70
            },
            {
              "beat": 14,
              "dur": 2,
              "midi": 67,
              "vel": 60
            },
            {
              "beat": 16,
              "dur": 1,
              "midi": 48,
              "vel": 56
            },
            {
              "beat": 17,
              "dur": 1,
              "midi": 55,
              "vel": 54
            },
            {
              "beat": 18,
              "dur": 1,
              "midi": 60,
              "vel": 56
            },
            {
              "beat": 19,
              "dur": 1,
              "midi": 64,
              "vel": 58
            },
            {
              "beat": 20,
              "dur": 1,
              "midi": 67,
              "vel": 72
            },
            {
              "beat": 21,
              "dur": 1.5,
              "midi": 64,
              "vel": 60
            },
            {
              "beat": 22.5,
              "dur": 0.5,
              "midi": 60,
              "vel": 48
            },
            {
              "beat": 23,
              "dur": 1,
              "midi": 55,
              "vel": 50
            },
            {
              "beat": 24,
              "dur": 1,
              "midi": 55,
              "vel": 56
            },
            {
              "beat": 25,
              "dur": 1,
              "midi": 62,
              "vel": 54
            },
            {
              "beat": 26,
              "dur": 1,
              "midi": 67,
              "vel": 56
            },
            {
              "beat": 27,
              "dur": 1,
              "midi": 71,
              "vel": 60
            },
            {
              "beat": 28,
              "dur": 2,
              "midi": 74,
              "vel": 68
            },
            {
              "beat": 30,
              "dur": 2,
              "midi": 71,
              "vel": 58
            },
            {
              "beat": 32,
              "dur": 1,
              "midi": 57,
              "vel": 62
            },
            {
              "beat": 33,
              "dur": 1,
              "midi": 64,
              "vel": 58
            },
            {
              "beat": 34,
              "dur": 1,
              "midi": 69,
              "vel": 60
            },
            {
              "beat": 35,
              "dur": 1,
              "midi": 72,
              "vel": 66
            },
            {
              "beat": 36,
              "dur": 1,
              "midi": 79,
              "vel": 82
            },
            {
              "beat": 37,
              "dur": 1.5,
              "midi": 77,
              "vel": 70
            },
            {
              "beat": 38.5,
              "dur": 0.5,
              "midi": 76,
              "vel": 58
            },
            {
              "beat": 39,
              "dur": 1,
              "midi": 72,
              "vel": 54
            },
            {
              "beat": 40,
              "dur": 1,
              "midi": 53,
              "vel": 58
            },
            {
              "beat": 41,
              "dur": 1,
              "midi": 60,
              "vel": 56
            },
            {
              "beat": 42,
              "dur": 1,
              "midi": 65,
              "vel": 58
            },
            {
              "beat": 43,
              "dur": 1,
              "midi": 69,
              "vel": 62
            },
            {
              "beat": 44,
              "dur": 2,
              "midi": 74,
              "vel": 74
            },
            {
              "beat": 46,
              "dur": 2,
              "midi": 72,
              "vel": 62
            },
            {
              "beat": 48,
              "dur": 1,
              "midi": 48,
              "vel": 56
            },
            {
              "beat": 49,
              "dur": 1,
              "midi": 55,
              "vel": 54
            },
            {
              "beat": 50,
              "dur": 1,
              "midi": 60,
              "vel": 56
            },
            {
              "beat": 51,
              "dur": 1,
              "midi": 64,
              "vel": 58
            },
            {
              "beat": 52,
              "dur": 1,
              "midi": 72,
              "vel": 70
            },
            {
              "beat": 53,
              "dur": 1.5,
              "midi": 71,
              "vel": 62
            },
            {
              "beat": 54.5,
              "dur": 0.5,
              "midi": 67,
              "vel": 50
            },
            {
              "beat": 55,
              "dur": 1,
              "midi": 64,
              "vel": 52
            },
            {
              "beat": 56,
              "dur": 1,
              "midi": 55,
              "vel": 56
            },
            {
              "beat": 57,
              "dur": 1,
              "midi": 62,
              "vel": 54
            },
            {
              "beat": 58,
              "dur": 1,
              "midi": 67,
              "vel": 56
            },
            {
              "beat": 59,
              "dur": 1,
              "midi": 71,
              "vel": 58
            },
            {
              "beat": 60,
              "dur": 3.5,
              "midi": 69,
              "vel": 66
            },
            {
              "beat": 63.5,
              "dur": 0.5,
              "midi": 76,
              "vel": 44
            }
          ]
        },
        {
          "instrument": "strings",
          "gain": 0.32,
          "notes": [
            {
              "beat": 0,
              "dur": 8,
              "midi": 57,
              "vel": 42
            },
            {
              "beat": 8,
              "dur": 8,
              "midi": 53,
              "vel": 40
            },
            {
              "beat": 16,
              "dur": 8,
              "midi": 48,
              "vel": 40
            },
            {
              "beat": 24,
              "dur": 8,
              "midi": 55,
              "vel": 42
            },
            {
              "beat": 32,
              "dur": 8,
              "midi": 57,
              "vel": 46
            },
            {
              "beat": 40,
              "dur": 8,
              "midi": 53,
              "vel": 44
            },
            {
              "beat": 48,
              "dur": 8,
              "midi": 48,
              "vel": 44
            },
            {
              "beat": 56,
              "dur": 8,
              "midi": 55,
              "vel": 42
            }
          ]
        }
      ]
    },
  },
  {
    label: "温暖 · 强度 1",
    direction: { mood: "warm", intensity: 1, note: "钢琴与 music box 互答，轻盈的日常感" },
    score: {
      "version": 1,
      "bpm": 76,
      "key": 0,
      "mode": "major",
      "bars": 16,
      "tracks": [
        {
          "instrument": "bass",
          "gain": 0.5,
          "notes": [
            {
              "beat": 0,
              "dur": 4,
              "midi": 36,
              "vel": 50
            },
            {
              "beat": 4,
              "dur": 4,
              "midi": 43,
              "vel": 48
            },
            {
              "beat": 8,
              "dur": 4,
              "midi": 33,
              "vel": 50
            },
            {
              "beat": 12,
              "dur": 4,
              "midi": 41,
              "vel": 48
            },
            {
              "beat": 16,
              "dur": 4,
              "midi": 36,
              "vel": 50
            },
            {
              "beat": 20,
              "dur": 4,
              "midi": 43,
              "vel": 48
            },
            {
              "beat": 24,
              "dur": 4,
              "midi": 33,
              "vel": 50
            },
            {
              "beat": 28,
              "dur": 4,
              "midi": 41,
              "vel": 48
            },
            {
              "beat": 32,
              "dur": 4,
              "midi": 36,
              "vel": 50
            },
            {
              "beat": 36,
              "dur": 4,
              "midi": 43,
              "vel": 48
            },
            {
              "beat": 40,
              "dur": 4,
              "midi": 33,
              "vel": 50
            },
            {
              "beat": 44,
              "dur": 4,
              "midi": 41,
              "vel": 48
            },
            {
              "beat": 48,
              "dur": 4,
              "midi": 36,
              "vel": 50
            },
            {
              "beat": 52,
              "dur": 4,
              "midi": 43,
              "vel": 48
            },
            {
              "beat": 56,
              "dur": 4,
              "midi": 33,
              "vel": 50
            },
            {
              "beat": 60,
              "dur": 4,
              "midi": 41,
              "vel": 48
            }
          ]
        },
        {
          "instrument": "piano",
          "gain": 0.85,
          "notes": [
            {
              "beat": 0,
              "dur": 1,
              "midi": 72,
              "vel": 80
            },
            {
              "beat": 1,
              "dur": 1,
              "midi": 76,
              "vel": 70
            },
            {
              "beat": 2,
              "dur": 2,
              "midi": 79,
              "vel": 75
            },
            {
              "beat": 4,
              "dur": 1,
              "midi": 74,
              "vel": 72
            },
            {
              "beat": 5,
              "dur": 1,
              "midi": 71,
              "vel": 65
            },
            {
              "beat": 6,
              "dur": 2,
              "midi": 67,
              "vel": 70
            },
            {
              "beat": 8,
              "dur": 1,
              "midi": 76,
              "vel": 78
            },
            {
              "beat": 9,
              "dur": 1,
              "midi": 72,
              "vel": 68
            },
            {
              "beat": 10,
              "dur": 2,
              "midi": 69,
              "vel": 72
            },
            {
              "beat": 12,
              "dur": 1,
              "midi": 69,
              "vel": 70
            },
            {
              "beat": 13,
              "dur": 1,
              "midi": 72,
              "vel": 66
            },
            {
              "beat": 14,
              "dur": 2,
              "midi": 76,
              "vel": 74
            },
            {
              "beat": 16,
              "dur": 1,
              "midi": 72,
              "vel": 80
            },
            {
              "beat": 17,
              "dur": 1,
              "midi": 76,
              "vel": 70
            },
            {
              "beat": 18,
              "dur": 2,
              "midi": 79,
              "vel": 75
            },
            {
              "beat": 20,
              "dur": 1,
              "midi": 74,
              "vel": 72
            },
            {
              "beat": 21,
              "dur": 1,
              "midi": 71,
              "vel": 65
            },
            {
              "beat": 22,
              "dur": 2,
              "midi": 67,
              "vel": 70
            },
            {
              "beat": 24,
              "dur": 1,
              "midi": 76,
              "vel": 78
            },
            {
              "beat": 25,
              "dur": 1,
              "midi": 72,
              "vel": 68
            },
            {
              "beat": 26,
              "dur": 2,
              "midi": 69,
              "vel": 72
            },
            {
              "beat": 28,
              "dur": 1,
              "midi": 69,
              "vel": 70
            },
            {
              "beat": 29,
              "dur": 1,
              "midi": 72,
              "vel": 66
            },
            {
              "beat": 30,
              "dur": 2,
              "midi": 76,
              "vel": 74
            },
            {
              "beat": 32,
              "dur": 1,
              "midi": 79,
              "vel": 82
            },
            {
              "beat": 33,
              "dur": 1,
              "midi": 76,
              "vel": 70
            },
            {
              "beat": 34,
              "dur": 2,
              "midi": 72,
              "vel": 75
            },
            {
              "beat": 36,
              "dur": 1,
              "midi": 71,
              "vel": 72
            },
            {
              "beat": 37,
              "dur": 1,
              "midi": 74,
              "vel": 66
            },
            {
              "beat": 38,
              "dur": 2,
              "midi": 79,
              "vel": 70
            },
            {
              "beat": 40,
              "dur": 1,
              "midi": 76,
              "vel": 78
            },
            {
              "beat": 41,
              "dur": 1,
              "midi": 72,
              "vel": 68
            },
            {
              "beat": 42,
              "dur": 2,
              "midi": 69,
              "vel": 72
            },
            {
              "beat": 44,
              "dur": 2,
              "midi": 72,
              "vel": 66
            },
            {
              "beat": 46,
              "dur": 2,
              "midi": 67,
              "vel": 64
            },
            {
              "beat": 48,
              "dur": 1,
              "midi": 72,
              "vel": 80
            },
            {
              "beat": 49,
              "dur": 1,
              "midi": 76,
              "vel": 70
            },
            {
              "beat": 50,
              "dur": 2,
              "midi": 79,
              "vel": 75
            },
            {
              "beat": 52,
              "dur": 1,
              "midi": 74,
              "vel": 72
            },
            {
              "beat": 53,
              "dur": 1,
              "midi": 71,
              "vel": 65
            },
            {
              "beat": 54,
              "dur": 2,
              "midi": 67,
              "vel": 70
            },
            {
              "beat": 56,
              "dur": 1,
              "midi": 76,
              "vel": 78
            },
            {
              "beat": 57,
              "dur": 1,
              "midi": 72,
              "vel": 68
            },
            {
              "beat": 58,
              "dur": 2,
              "midi": 69,
              "vel": 72
            },
            {
              "beat": 60,
              "dur": 2,
              "midi": 67,
              "vel": 70
            },
            {
              "beat": 62,
              "dur": 2,
              "midi": 64,
              "vel": 68
            }
          ]
        },
        {
          "instrument": "bell",
          "gain": 0.6,
          "notes": [
            {
              "beat": 3,
              "dur": 2,
              "midi": 84,
              "vel": 55
            },
            {
              "beat": 7,
              "dur": 2,
              "midi": 88,
              "vel": 52
            },
            {
              "beat": 11,
              "dur": 2,
              "midi": 84,
              "vel": 55
            },
            {
              "beat": 15,
              "dur": 2,
              "midi": 81,
              "vel": 50
            },
            {
              "beat": 19,
              "dur": 2,
              "midi": 84,
              "vel": 55
            },
            {
              "beat": 23,
              "dur": 2,
              "midi": 88,
              "vel": 52
            },
            {
              "beat": 27,
              "dur": 2,
              "midi": 84,
              "vel": 55
            },
            {
              "beat": 31,
              "dur": 2,
              "midi": 91,
              "vel": 50
            },
            {
              "beat": 35,
              "dur": 2,
              "midi": 84,
              "vel": 55
            },
            {
              "beat": 39,
              "dur": 2,
              "midi": 88,
              "vel": 52
            },
            {
              "beat": 43,
              "dur": 2,
              "midi": 84,
              "vel": 55
            },
            {
              "beat": 47,
              "dur": 2,
              "midi": 81,
              "vel": 50
            },
            {
              "beat": 51,
              "dur": 2,
              "midi": 84,
              "vel": 55
            },
            {
              "beat": 55,
              "dur": 2,
              "midi": 88,
              "vel": 52
            },
            {
              "beat": 59,
              "dur": 2,
              "midi": 84,
              "vel": 55
            },
            {
              "beat": 63,
              "dur": 1,
              "midi": 79,
              "vel": 48
            }
          ]
        }
      ]
    },
  },
  {
    label: "高潮 · 强度 3",
    direction: { mood: "climax", intensity: 3, note: "全奏推进，弦乐激昂上行，bass 沉稳定音" },
    score: {
      "version": 1,
      "bpm": 138,
      "key": 9,
      "mode": "minor",
      "bars": 16,
      "tracks": [
        {
          "instrument": "bass",
          "gain": 0.9,
          "notes": [
            {
              "beat": 0,
              "dur": 2,
              "midi": 45,
              "vel": 110
            },
            {
              "beat": 2,
              "dur": 1,
              "midi": 45,
              "vel": 95
            },
            {
              "beat": 3,
              "dur": 1,
              "midi": 45,
              "vel": 90
            },
            {
              "beat": 4,
              "dur": 2,
              "midi": 40,
              "vel": 110
            },
            {
              "beat": 6,
              "dur": 1,
              "midi": 40,
              "vel": 95
            },
            {
              "beat": 7,
              "dur": 1,
              "midi": 40,
              "vel": 90
            },
            {
              "beat": 8,
              "dur": 2,
              "midi": 48,
              "vel": 112
            },
            {
              "beat": 10,
              "dur": 1,
              "midi": 48,
              "vel": 95
            },
            {
              "beat": 11,
              "dur": 1,
              "midi": 48,
              "vel": 90
            },
            {
              "beat": 12,
              "dur": 2,
              "midi": 43,
              "vel": 110
            },
            {
              "beat": 14,
              "dur": 1,
              "midi": 43,
              "vel": 95
            },
            {
              "beat": 15,
              "dur": 1,
              "midi": 43,
              "vel": 90
            },
            {
              "beat": 16,
              "dur": 2,
              "midi": 45,
              "vel": 110
            },
            {
              "beat": 18,
              "dur": 1,
              "midi": 45,
              "vel": 95
            },
            {
              "beat": 19,
              "dur": 1,
              "midi": 45,
              "vel": 90
            },
            {
              "beat": 20,
              "dur": 2,
              "midi": 40,
              "vel": 110
            },
            {
              "beat": 22,
              "dur": 1,
              "midi": 40,
              "vel": 95
            },
            {
              "beat": 23,
              "dur": 1,
              "midi": 40,
              "vel": 90
            },
            {
              "beat": 24,
              "dur": 2,
              "midi": 48,
              "vel": 112
            },
            {
              "beat": 26,
              "dur": 1,
              "midi": 48,
              "vel": 95
            },
            {
              "beat": 27,
              "dur": 1,
              "midi": 48,
              "vel": 90
            },
            {
              "beat": 28,
              "dur": 2,
              "midi": 43,
              "vel": 110
            },
            {
              "beat": 30,
              "dur": 1,
              "midi": 43,
              "vel": 95
            },
            {
              "beat": 31,
              "dur": 1,
              "midi": 43,
              "vel": 90
            },
            {
              "beat": 32,
              "dur": 2,
              "midi": 45,
              "vel": 110
            },
            {
              "beat": 34,
              "dur": 1,
              "midi": 45,
              "vel": 95
            },
            {
              "beat": 35,
              "dur": 1,
              "midi": 45,
              "vel": 90
            },
            {
              "beat": 36,
              "dur": 2,
              "midi": 40,
              "vel": 110
            },
            {
              "beat": 38,
              "dur": 1,
              "midi": 40,
              "vel": 95
            },
            {
              "beat": 39,
              "dur": 1,
              "midi": 40,
              "vel": 90
            },
            {
              "beat": 40,
              "dur": 2,
              "midi": 48,
              "vel": 112
            },
            {
              "beat": 42,
              "dur": 1,
              "midi": 48,
              "vel": 95
            },
            {
              "beat": 43,
              "dur": 1,
              "midi": 48,
              "vel": 90
            },
            {
              "beat": 44,
              "dur": 2,
              "midi": 43,
              "vel": 110
            },
            {
              "beat": 46,
              "dur": 1,
              "midi": 43,
              "vel": 95
            },
            {
              "beat": 47,
              "dur": 1,
              "midi": 43,
              "vel": 90
            },
            {
              "beat": 48,
              "dur": 2,
              "midi": 45,
              "vel": 112
            },
            {
              "beat": 50,
              "dur": 1,
              "midi": 45,
              "vel": 95
            },
            {
              "beat": 51,
              "dur": 1,
              "midi": 45,
              "vel": 90
            },
            {
              "beat": 52,
              "dur": 2,
              "midi": 40,
              "vel": 112
            },
            {
              "beat": 54,
              "dur": 1,
              "midi": 40,
              "vel": 95
            },
            {
              "beat": 55,
              "dur": 1,
              "midi": 40,
              "vel": 90
            },
            {
              "beat": 56,
              "dur": 2,
              "midi": 48,
              "vel": 112
            },
            {
              "beat": 58,
              "dur": 1,
              "midi": 48,
              "vel": 95
            },
            {
              "beat": 59,
              "dur": 1,
              "midi": 48,
              "vel": 90
            },
            {
              "beat": 60,
              "dur": 2,
              "midi": 44,
              "vel": 112
            },
            {
              "beat": 62,
              "dur": 1,
              "midi": 44,
              "vel": 95
            },
            {
              "beat": 63,
              "dur": 1,
              "midi": 44,
              "vel": 90
            }
          ]
        },
        {
          "instrument": "pad",
          "gain": 0.45,
          "notes": [
            {
              "beat": 0,
              "dur": 4,
              "midi": 57,
              "vel": 45
            },
            {
              "beat": 0,
              "dur": 4,
              "midi": 60,
              "vel": 40
            },
            {
              "beat": 0,
              "dur": 4,
              "midi": 64,
              "vel": 40
            },
            {
              "beat": 4,
              "dur": 4,
              "midi": 52,
              "vel": 45
            },
            {
              "beat": 4,
              "dur": 4,
              "midi": 55,
              "vel": 40
            },
            {
              "beat": 4,
              "dur": 4,
              "midi": 60,
              "vel": 40
            },
            {
              "beat": 8,
              "dur": 4,
              "midi": 60,
              "vel": 45
            },
            {
              "beat": 8,
              "dur": 4,
              "midi": 64,
              "vel": 40
            },
            {
              "beat": 8,
              "dur": 4,
              "midi": 67,
              "vel": 40
            },
            {
              "beat": 12,
              "dur": 4,
              "midi": 55,
              "vel": 45
            },
            {
              "beat": 12,
              "dur": 4,
              "midi": 59,
              "vel": 40
            },
            {
              "beat": 12,
              "dur": 4,
              "midi": 62,
              "vel": 40
            },
            {
              "beat": 16,
              "dur": 4,
              "midi": 57,
              "vel": 45
            },
            {
              "beat": 16,
              "dur": 4,
              "midi": 60,
              "vel": 40
            },
            {
              "beat": 16,
              "dur": 4,
              "midi": 64,
              "vel": 40
            },
            {
              "beat": 20,
              "dur": 4,
              "midi": 52,
              "vel": 45
            },
            {
              "beat": 20,
              "dur": 4,
              "midi": 55,
              "vel": 40
            },
            {
              "beat": 20,
              "dur": 4,
              "midi": 60,
              "vel": 40
            },
            {
              "beat": 24,
              "dur": 4,
              "midi": 60,
              "vel": 45
            },
            {
              "beat": 24,
              "dur": 4,
              "midi": 64,
              "vel": 40
            },
            {
              "beat": 24,
              "dur": 4,
              "midi": 67,
              "vel": 40
            },
            {
              "beat": 28,
              "dur": 4,
              "midi": 55,
              "vel": 45
            },
            {
              "beat": 28,
              "dur": 4,
              "midi": 59,
              "vel": 40
            },
            {
              "beat": 28,
              "dur": 4,
              "midi": 62,
              "vel": 40
            },
            {
              "beat": 32,
              "dur": 4,
              "midi": 57,
              "vel": 45
            },
            {
              "beat": 32,
              "dur": 4,
              "midi": 60,
              "vel": 40
            },
            {
              "beat": 32,
              "dur": 4,
              "midi": 64,
              "vel": 40
            },
            {
              "beat": 36,
              "dur": 4,
              "midi": 52,
              "vel": 45
            },
            {
              "beat": 36,
              "dur": 4,
              "midi": 55,
              "vel": 40
            },
            {
              "beat": 36,
              "dur": 4,
              "midi": 60,
              "vel": 40
            },
            {
              "beat": 40,
              "dur": 4,
              "midi": 60,
              "vel": 45
            },
            {
              "beat": 40,
              "dur": 4,
              "midi": 64,
              "vel": 40
            },
            {
              "beat": 40,
              "dur": 4,
              "midi": 67,
              "vel": 40
            },
            {
              "beat": 44,
              "dur": 4,
              "midi": 56,
              "vel": 45
            },
            {
              "beat": 44,
              "dur": 4,
              "midi": 59,
              "vel": 40
            },
            {
              "beat": 44,
              "dur": 4,
              "midi": 64,
              "vel": 40
            }
          ]
        },
        {
          "instrument": "strings",
          "gain": 0.8,
          "notes": [
            {
              "beat": 0,
              "dur": 1,
              "midi": 64,
              "vel": 105
            },
            {
              "beat": 1,
              "dur": 0.5,
              "midi": 67,
              "vel": 100
            },
            {
              "beat": 1.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 100
            },
            {
              "beat": 2,
              "dur": 2,
              "midi": 72,
              "vel": 110
            },
            {
              "beat": 4,
              "dur": 1,
              "midi": 60,
              "vel": 100
            },
            {
              "beat": 5,
              "dur": 1,
              "midi": 64,
              "vel": 100
            },
            {
              "beat": 6,
              "dur": 2,
              "midi": 67,
              "vel": 108
            },
            {
              "beat": 8,
              "dur": 1,
              "midi": 67,
              "vel": 105
            },
            {
              "beat": 9,
              "dur": 0.5,
              "midi": 69,
              "vel": 100
            },
            {
              "beat": 9.5,
              "dur": 0.5,
              "midi": 71,
              "vel": 100
            },
            {
              "beat": 10,
              "dur": 2,
              "midi": 72,
              "vel": 112
            },
            {
              "beat": 12,
              "dur": 2,
              "midi": 74,
              "vel": 108
            },
            {
              "beat": 14,
              "dur": 2,
              "midi": 71,
              "vel": 100
            },
            {
              "beat": 16,
              "dur": 1,
              "midi": 64,
              "vel": 105
            },
            {
              "beat": 17,
              "dur": 0.5,
              "midi": 67,
              "vel": 100
            },
            {
              "beat": 17.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 100
            },
            {
              "beat": 18,
              "dur": 2,
              "midi": 72,
              "vel": 110
            },
            {
              "beat": 20,
              "dur": 1,
              "midi": 60,
              "vel": 100
            },
            {
              "beat": 21,
              "dur": 1,
              "midi": 64,
              "vel": 100
            },
            {
              "beat": 22,
              "dur": 2,
              "midi": 67,
              "vel": 108
            },
            {
              "beat": 24,
              "dur": 1,
              "midi": 67,
              "vel": 105
            },
            {
              "beat": 25,
              "dur": 0.5,
              "midi": 69,
              "vel": 100
            },
            {
              "beat": 25.5,
              "dur": 0.5,
              "midi": 71,
              "vel": 100
            },
            {
              "beat": 26,
              "dur": 2,
              "midi": 76,
              "vel": 112
            },
            {
              "beat": 28,
              "dur": 2,
              "midi": 74,
              "vel": 110
            },
            {
              "beat": 30,
              "dur": 2,
              "midi": 72,
              "vel": 105
            },
            {
              "beat": 32,
              "dur": 1,
              "midi": 64,
              "vel": 105
            },
            {
              "beat": 33,
              "dur": 0.5,
              "midi": 67,
              "vel": 100
            },
            {
              "beat": 33.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 100
            },
            {
              "beat": 34,
              "dur": 2,
              "midi": 72,
              "vel": 112
            },
            {
              "beat": 36,
              "dur": 1,
              "midi": 60,
              "vel": 100
            },
            {
              "beat": 37,
              "dur": 1,
              "midi": 64,
              "vel": 100
            },
            {
              "beat": 38,
              "dur": 2,
              "midi": 67,
              "vel": 110
            },
            {
              "beat": 40,
              "dur": 1,
              "midi": 72,
              "vel": 108
            },
            {
              "beat": 41,
              "dur": 1,
              "midi": 74,
              "vel": 108
            },
            {
              "beat": 42,
              "dur": 1,
              "midi": 76,
              "vel": 112
            },
            {
              "beat": 43,
              "dur": 1,
              "midi": 79,
              "vel": 112
            },
            {
              "beat": 44,
              "dur": 2,
              "midi": 81,
              "vel": 115
            },
            {
              "beat": 46,
              "dur": 2,
              "midi": 79,
              "vel": 108
            },
            {
              "beat": 48,
              "dur": 2,
              "midi": 76,
              "vel": 112
            },
            {
              "beat": 50,
              "dur": 2,
              "midi": 74,
              "vel": 108
            },
            {
              "beat": 52,
              "dur": 2,
              "midi": 72,
              "vel": 110
            },
            {
              "beat": 54,
              "dur": 2,
              "midi": 71,
              "vel": 105
            },
            {
              "beat": 56,
              "dur": 3,
              "midi": 69,
              "vel": 115
            },
            {
              "beat": 59,
              "dur": 1,
              "midi": 71,
              "vel": 100
            },
            {
              "beat": 60,
              "dur": 4,
              "midi": 68,
              "vel": 112
            },
            {
              "beat": 60,
              "dur": 4,
              "midi": 72,
              "vel": 108
            },
            {
              "beat": 60,
              "dur": 4,
              "midi": 75,
              "vel": 105
            }
          ]
        },
        {
          "instrument": "choir",
          "gain": 0.4,
          "notes": [
            {
              "beat": 0,
              "dur": 8,
              "midi": 48,
              "vel": 35
            },
            {
              "beat": 0,
              "dur": 8,
              "midi": 55,
              "vel": 30
            },
            {
              "beat": 8,
              "dur": 8,
              "midi": 52,
              "vel": 35
            },
            {
              "beat": 8,
              "dur": 8,
              "midi": 59,
              "vel": 30
            },
            {
              "beat": 16,
              "dur": 8,
              "midi": 48,
              "vel": 35
            },
            {
              "beat": 16,
              "dur": 8,
              "midi": 55,
              "vel": 30
            },
            {
              "beat": 24,
              "dur": 8,
              "midi": 52,
              "vel": 35
            },
            {
              "beat": 24,
              "dur": 8,
              "midi": 59,
              "vel": 30
            },
            {
              "beat": 32,
              "dur": 8,
              "midi": 48,
              "vel": 35
            },
            {
              "beat": 32,
              "dur": 8,
              "midi": 55,
              "vel": 30
            },
            {
              "beat": 40,
              "dur": 8,
              "midi": 52,
              "vel": 35
            },
            {
              "beat": 40,
              "dur": 8,
              "midi": 59,
              "vel": 30
            },
            {
              "beat": 48,
              "dur": 8,
              "midi": 50,
              "vel": 38
            },
            {
              "beat": 48,
              "dur": 8,
              "midi": 57,
              "vel": 32
            },
            {
              "beat": 56,
              "dur": 8,
              "midi": 52,
              "vel": 38
            },
            {
              "beat": 56,
              "dur": 8,
              "midi": 59,
              "vel": 32
            }
          ]
        },
        {
          "instrument": "bell",
          "gain": 0.35,
          "notes": [
            {
              "beat": 2,
              "dur": 1,
              "midi": 84,
              "vel": 70
            },
            {
              "beat": 10,
              "dur": 1,
              "midi": 88,
              "vel": 68
            },
            {
              "beat": 18,
              "dur": 1,
              "midi": 84,
              "vel": 70
            },
            {
              "beat": 26,
              "dur": 1,
              "midi": 91,
              "vel": 72
            },
            {
              "beat": 34,
              "dur": 1,
              "midi": 84,
              "vel": 70
            },
            {
              "beat": 42,
              "dur": 1,
              "midi": 88,
              "vel": 70
            },
            {
              "beat": 50,
              "dur": 1,
              "midi": 96,
              "vel": 75
            },
            {
              "beat": 54,
              "dur": 1,
              "midi": 91,
              "vel": 72
            }
          ]
        }
      ]
    },
  },
  {
    label: "悲伤 · 强度 1 · 稀疏五声",
    direction: { mood: "sorrowful", intensity: 1, note: "雨后古镇石板路，回忆浮现" },
    score: {
      "version": 1,
      "bpm": 58,
      "key": 9,
      "mode": "minor",
      "bars": 16,
      "tracks": [
        {
          "instrument": "bass",
          "gain": 0.35,
          "notes": [
            {
              "beat": 0,
              "dur": 4,
              "midi": 45,
              "vel": 55
            },
            {
              "beat": 4,
              "dur": 4,
              "midi": 41,
              "vel": 50
            },
            {
              "beat": 8,
              "dur": 4,
              "midi": 48,
              "vel": 50
            },
            {
              "beat": 12,
              "dur": 2,
              "midi": 43,
              "vel": 48
            },
            {
              "beat": 14,
              "dur": 2,
              "midi": 45,
              "vel": 52
            },
            {
              "beat": 16,
              "dur": 4,
              "midi": 45,
              "vel": 55
            },
            {
              "beat": 20,
              "dur": 4,
              "midi": 41,
              "vel": 50
            },
            {
              "beat": 24,
              "dur": 4,
              "midi": 48,
              "vel": 50
            },
            {
              "beat": 28,
              "dur": 4,
              "midi": 43,
              "vel": 48
            }
          ]
        },
        {
          "instrument": "pad",
          "gain": 0.3,
          "notes": [
            {
              "beat": 0,
              "dur": 8,
              "midi": 57,
              "vel": 35
            },
            {
              "beat": 0,
              "dur": 8,
              "midi": 60,
              "vel": 30
            },
            {
              "beat": 8,
              "dur": 8,
              "midi": 60,
              "vel": 35
            },
            {
              "beat": 8,
              "dur": 8,
              "midi": 64,
              "vel": 30
            },
            {
              "beat": 16,
              "dur": 8,
              "midi": 57,
              "vel": 35
            },
            {
              "beat": 16,
              "dur": 8,
              "midi": 60,
              "vel": 30
            },
            {
              "beat": 24,
              "dur": 4,
              "midi": 62,
              "vel": 32
            },
            {
              "beat": 24,
              "dur": 4,
              "midi": 65,
              "vel": 28
            },
            {
              "beat": 28,
              "dur": 4,
              "midi": 60,
              "vel": 32
            },
            {
              "beat": 28,
              "dur": 4,
              "midi": 64,
              "vel": 28
            }
          ]
        },
        {
          "instrument": "piano",
          "gain": 0.55,
          "notes": [
            {
              "beat": 0,
              "dur": 1.5,
              "midi": 72,
              "vel": 70
            },
            {
              "beat": 1.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 58
            },
            {
              "beat": 2,
              "dur": 2,
              "midi": 67,
              "vel": 62
            },
            {
              "beat": 4,
              "dur": 1,
              "midi": 65,
              "vel": 60
            },
            {
              "beat": 5,
              "dur": 1,
              "midi": 67,
              "vel": 55
            },
            {
              "beat": 6,
              "dur": 2,
              "midi": 65,
              "vel": 58
            },
            {
              "beat": 8,
              "dur": 2.5,
              "midi": 72,
              "vel": 66
            },
            {
              "beat": 10.5,
              "dur": 1.5,
              "midi": 67,
              "vel": 56
            },
            {
              "beat": 12,
              "dur": 2,
              "midi": 69,
              "vel": 60
            },
            {
              "beat": 14,
              "dur": 2,
              "midi": 67,
              "vel": 52
            },
            {
              "beat": 16,
              "dur": 1.5,
              "midi": 72,
              "vel": 70
            },
            {
              "beat": 17.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 58
            },
            {
              "beat": 18,
              "dur": 2,
              "midi": 67,
              "vel": 62
            },
            {
              "beat": 20,
              "dur": 1,
              "midi": 65,
              "vel": 60
            },
            {
              "beat": 21,
              "dur": 1,
              "midi": 67,
              "vel": 55
            },
            {
              "beat": 22,
              "dur": 2,
              "midi": 74,
              "vel": 64
            },
            {
              "beat": 24,
              "dur": 2.5,
              "midi": 72,
              "vel": 66
            },
            {
              "beat": 26.5,
              "dur": 1.5,
              "midi": 69,
              "vel": 56
            },
            {
              "beat": 28,
              "dur": 2,
              "midi": 67,
              "vel": 60
            },
            {
              "beat": 30,
              "dur": 2,
              "midi": 69,
              "vel": 54
            }
          ]
        }
      ]
    },
  },
  {
    label: "希望 · 强度 2 · dorian 竖琴",
    direction: { mood: "hopeful", intensity: 2, note: "晨光穿过薄雾，旅程开启" },
    score: {
      "version": 1,
      "bpm": 96,
      "key": 2,
      "mode": "dorian",
      "bars": 16,
      "tracks": [
        {
          "instrument": "bass",
          "gain": 0.7,
          "notes": [
            {
              "beat": 0,
              "dur": 4,
              "midi": 38,
              "vel": 70
            },
            {
              "beat": 4,
              "dur": 4,
              "midi": 45,
              "vel": 70
            },
            {
              "beat": 8,
              "dur": 4,
              "midi": 40,
              "vel": 70
            },
            {
              "beat": 12,
              "dur": 4,
              "midi": 47,
              "vel": 70
            },
            {
              "beat": 16,
              "dur": 4,
              "midi": 38,
              "vel": 70
            },
            {
              "beat": 20,
              "dur": 4,
              "midi": 45,
              "vel": 70
            },
            {
              "beat": 24,
              "dur": 4,
              "midi": 40,
              "vel": 70
            },
            {
              "beat": 28,
              "dur": 2,
              "midi": 47,
              "vel": 70
            },
            {
              "beat": 30,
              "dur": 2,
              "midi": 38,
              "vel": 72
            }
          ]
        },
        {
          "instrument": "pad",
          "gain": 0.6,
          "notes": [
            {
              "beat": 0,
              "dur": 8,
              "midi": 54,
              "vel": 45
            },
            {
              "beat": 0,
              "dur": 8,
              "midi": 61,
              "vel": 45
            },
            {
              "beat": 8,
              "dur": 8,
              "midi": 52,
              "vel": 45
            },
            {
              "beat": 8,
              "dur": 8,
              "midi": 59,
              "vel": 45
            },
            {
              "beat": 16,
              "dur": 8,
              "midi": 54,
              "vel": 45
            },
            {
              "beat": 16,
              "dur": 8,
              "midi": 61,
              "vel": 45
            },
            {
              "beat": 24,
              "dur": 8,
              "midi": 52,
              "vel": 45
            },
            {
              "beat": 24,
              "dur": 8,
              "midi": 64,
              "vel": 45
            }
          ]
        },
        {
          "instrument": "piano",
          "gain": 0.9,
          "notes": [
            {
              "beat": 0,
              "dur": 0.5,
              "midi": 66,
              "vel": 88
            },
            {
              "beat": 0.5,
              "dur": 0.5,
              "midi": 73,
              "vel": 80
            },
            {
              "beat": 1,
              "dur": 0.5,
              "midi": 78,
              "vel": 80
            },
            {
              "beat": 1.5,
              "dur": 0.5,
              "midi": 73,
              "vel": 75
            },
            {
              "beat": 2,
              "dur": 1,
              "midi": 78,
              "vel": 85
            },
            {
              "beat": 3,
              "dur": 1,
              "midi": 73,
              "vel": 70
            },
            {
              "beat": 4,
              "dur": 0.5,
              "midi": 76,
              "vel": 88
            },
            {
              "beat": 4.5,
              "dur": 0.5,
              "midi": 73,
              "vel": 80
            },
            {
              "beat": 5,
              "dur": 0.5,
              "midi": 69,
              "vel": 80
            },
            {
              "beat": 5.5,
              "dur": 0.5,
              "midi": 76,
              "vel": 75
            },
            {
              "beat": 6,
              "dur": 1,
              "midi": 73,
              "vel": 85
            },
            {
              "beat": 7,
              "dur": 1,
              "midi": 69,
              "vel": 70
            },
            {
              "beat": 8,
              "dur": 0.5,
              "midi": 67,
              "vel": 88
            },
            {
              "beat": 8.5,
              "dur": 0.5,
              "midi": 74,
              "vel": 80
            },
            {
              "beat": 9,
              "dur": 0.5,
              "midi": 79,
              "vel": 80
            },
            {
              "beat": 9.5,
              "dur": 0.5,
              "midi": 74,
              "vel": 75
            },
            {
              "beat": 10,
              "dur": 1,
              "midi": 79,
              "vel": 85
            },
            {
              "beat": 11,
              "dur": 1,
              "midi": 74,
              "vel": 70
            },
            {
              "beat": 12,
              "dur": 0.5,
              "midi": 76,
              "vel": 88
            },
            {
              "beat": 12.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 80
            },
            {
              "beat": 13,
              "dur": 0.5,
              "midi": 79,
              "vel": 80
            },
            {
              "beat": 13.5,
              "dur": 0.5,
              "midi": 72,
              "vel": 75
            },
            {
              "beat": 14,
              "dur": 1,
              "midi": 74,
              "vel": 85
            },
            {
              "beat": 15,
              "dur": 1,
              "midi": 72,
              "vel": 70
            },
            {
              "beat": 16,
              "dur": 0.5,
              "midi": 78,
              "vel": 90
            },
            {
              "beat": 16.5,
              "dur": 0.5,
              "midi": 73,
              "vel": 80
            },
            {
              "beat": 17,
              "dur": 0.5,
              "midi": 81,
              "vel": 80
            },
            {
              "beat": 17.5,
              "dur": 0.5,
              "midi": 78,
              "vel": 75
            },
            {
              "beat": 18,
              "dur": 1,
              "midi": 83,
              "vel": 88
            },
            {
              "beat": 19,
              "dur": 1,
              "midi": 78,
              "vel": 72
            },
            {
              "beat": 20,
              "dur": 0.5,
              "midi": 76,
              "vel": 88
            },
            {
              "beat": 20.5,
              "dur": 0.5,
              "midi": 73,
              "vel": 80
            },
            {
              "beat": 21,
              "dur": 0.5,
              "midi": 81,
              "vel": 80
            },
            {
              "beat": 21.5,
              "dur": 0.5,
              "midi": 76,
              "vel": 75
            },
            {
              "beat": 22,
              "dur": 1,
              "midi": 78,
              "vel": 85
            },
            {
              "beat": 23,
              "dur": 1,
              "midi": 73,
              "vel": 70
            },
            {
              "beat": 24,
              "dur": 0.5,
              "midi": 74,
              "vel": 88
            },
            {
              "beat": 24.5,
              "dur": 0.5,
              "midi": 79,
              "vel": 80
            },
            {
              "beat": 25,
              "dur": 0.5,
              "midi": 74,
              "vel": 80
            },
            {
              "beat": 25.5,
              "dur": 0.5,
              "midi": 79,
              "vel": 75
            },
            {
              "beat": 26,
              "dur": 1,
              "midi": 81,
              "vel": 85
            },
            {
              "beat": 27,
              "dur": 1,
              "midi": 76,
              "vel": 70
            },
            {
              "beat": 28,
              "dur": 0.5,
              "midi": 72,
              "vel": 88
            },
            {
              "beat": 28.5,
              "dur": 0.5,
              "midi": 79,
              "vel": 80
            },
            {
              "beat": 29,
              "dur": 0.5,
              "midi": 74,
              "vel": 80
            },
            {
              "beat": 29.5,
              "dur": 0.5,
              "midi": 69,
              "vel": 75
            },
            {
              "beat": 30,
              "dur": 2,
              "midi": 66,
              "vel": 82
            }
          ]
        },
        {
          "instrument": "strings",
          "gain": 0.5,
          "notes": [
            {
              "beat": 0,
              "dur": 4,
              "midi": 64,
              "vel": 55
            },
            {
              "beat": 4,
              "dur": 4,
              "midi": 71,
              "vel": 55
            },
            {
              "beat": 8,
              "dur": 4,
              "midi": 62,
              "vel": 55
            },
            {
              "beat": 12,
              "dur": 4,
              "midi": 69,
              "vel": 55
            },
            {
              "beat": 16,
              "dur": 4,
              "midi": 66,
              "vel": 58
            },
            {
              "beat": 20,
              "dur": 4,
              "midi": 71,
              "vel": 58
            },
            {
              "beat": 24,
              "dur": 4,
              "midi": 67,
              "vel": 58
            },
            {
              "beat": 28,
              "dur": 4,
              "midi": 64,
              "vel": 55
            }
          ]
        }
      ]
    },
  },
];
