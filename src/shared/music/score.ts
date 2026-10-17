/**
 * MusicScore — 场景配乐符号谱（动态音乐生成三层契约的中间层）。
 *
 * 三层范式与角色音频特征（character-voice-design）同构：
 *   导演指导（SceneDirective.music：情绪/强度/注记）
 *   → 作曲层（LLM 单次 JSON 调用产出本符号谱，词表/校验单一真源）
 *   → 渲染层（web 侧 OfflineAudioContext + soundfont 确定性渲染成 WAV，
 *     结果进 IndexedDB 缓存，blob URL 注册给 BgmController 播放）。
 *
 * 本文件在 shared/ 因为两侧都要：Node 作曲适配器校验产出，浏览器渲染器
 * 消费。谱面是纯数据——同一谱 + 同一渲染器版本 = 同一音频（多周目回放
 * 一致性的根基；渲染器行为变化必须升 MUSIC_RENDERER_VERSION 使缓存失效）。
 */
import { z } from "zod";

/**
 * 乐器调色板（渲染层映射到 soundfont 采样包）。作曲提示、谱面校验、
 * 渲染器三处共用——新增乐器 = 加枚举 + vendor 脚本 PACKS 补 GM 映射
 * （重采）+ 渲染层补声像/增益/混响映射（typecheck 强制穷尽）。
 */
export const MUSIC_INSTRUMENTS = [
  "piano",
  "strings",
  "pad",
  "bass",
  "bell",
  "choir",
  "guitar",
  "harp",
  "flute",
  "marimba",
  "organ",
  "synth",
] as const;
export type MusicInstrument = (typeof MUSIC_INSTRUMENTS)[number];

/** 导演情绪词表（插值进 DIRECTIVE_SYSTEM_PROMPT，作曲 prompt 同源引用）。 */
export const MUSIC_MOODS = [
  "daily",
  "warm",
  "tense",
  "sorrowful",
  "mysterious",
  "hopeful",
  "climax",
] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];

/** 强度档位（1=铺垫，2=主体，3=高潮）。 */
export const MUSIC_INTENSITY_MIN = 1;
export const MUSIC_INTENSITY_MAX = 3;
export const MUSIC_INTENSITY_DEFAULT = 2;

/** 单曲音符总量上限（作曲输出预算 + 渲染性能护栏）。 */
export const MUSIC_MAX_TOTAL_NOTES = 600;

export const MusicNoteSchema = z
  .object({
    /** 起拍（四分音符为单位，0=循环起点；必须落在循环内）。 */
    beat: z.number().min(0),
    /** 时值（四分音符为单位；允许跨过循环点，渲染层把尾巴卷回头部）。 */
    dur: z.number().min(0.1).max(8),
    /** MIDI 音高（21=A0，108=C8）。 */
    midi: z.number().int().min(21).max(108),
    /** 力度（1–127，渲染层换算为音符增益）。 */
    vel: z.number().int().min(1).max(127),
  })
  .strict();

export const MusicTrackSchema = z
  .object({
    instrument: z.enum(MUSIC_INSTRUMENTS),
    /** 轨道增益（0–1，渲染时与音符力度相乘）。 */
    gain: z.number().min(0).max(1),
    notes: z.array(MusicNoteSchema).min(1),
  })
  .strict();

export const MusicScoreSchema = z
  .object({
    version: z.literal(1),
    bpm: z.number().int().min(50).max(170),
    /** 主音半音（0=C … 11=B）。 */
    key: z.number().int().min(0).max(11),
    mode: z.enum(["major", "minor", "dorian"]),
    /** 循环长度（小节数，恒为 4/4 拍）。 */
    bars: z.number().int().min(8).max(48),
    tracks: z.array(MusicTrackSchema).min(1).max(MUSIC_INSTRUMENTS.length),
  })
  .superRefine((score, context) => {
    const loopBeats = score.bars * 4;
    const instruments = new Set<string>();
    let totalNotes = 0;
    for (const track of score.tracks) {
      if (instruments.has(track.instrument)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tracks"],
          message: `乐器 ${track.instrument} 出现多条轨道（每乐器至多一条）。`,
        });
      }
      instruments.add(track.instrument);
      totalNotes += track.notes.length;
      for (const [index, note] of track.notes.entries()) {
        if (note.beat >= loopBeats) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tracks", index, "notes"],
            message: `音符起拍 ${note.beat} 超出循环长度（${loopBeats} 拍 = ${score.bars} 小节）。`,
          });
          break;
        }
      }
    }
    if (totalNotes > MUSIC_MAX_TOTAL_NOTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tracks"],
        message: `音符总量 ${totalNotes} 超上限 ${MUSIC_MAX_TOTAL_NOTES}。`,
      });
    }
  })
  .strict();

export type MusicNote = z.infer<typeof MusicNoteSchema>;
export type MusicTrack = z.infer<typeof MusicTrackSchema>;
export type MusicScore = z.infer<typeof MusicScoreSchema>;

/** 导演音乐指导（SceneDirective.music；mood 缺失 = 本场景无音乐指导）。 */
export interface SceneMusicDirection {
  mood: MusicMood;
  intensity: 1 | 2 | 3;
  /** 作曲提示（≤60 字：场景情境一句话 + 编配提示——作曲家复用/新作决策的关键输入）。 */
  note?: string;
}

/** 循环总拍数（4/4）。 */
export function scoreLoopBeats(score: Pick<MusicScore, "bars">): number {
  return score.bars * 4;
}

/** MIDI 音高 → 频率（Hz，A4=440）。 */
export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}
