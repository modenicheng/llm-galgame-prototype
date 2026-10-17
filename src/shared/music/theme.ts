/**
 * MusicTheme — 主题制配乐的共享契约（V2，Node/Web 两侧共用单一真源）。
 *
 * 主题（theme）= 一局游戏中的一段可复用配乐身份：同一场景日夜共用一个
 * 主题、同一游戏区域（如地下堡垒）共用一个主题；一局游戏最终形成数首
 * 曲目（像一张 OST 专辑）。复用与否由作曲家 agent 在看过场景 brief 与
 * 已有主题目录后决定（ComposerDecision），目录数据在
 * games/<gameId>/music/（themes.json + scores/）。
 *
 * 与 V1 复用键（region:mood:intensity → mood:intensity）的根本差异：
 * 可听身份不再是情绪档位的函数，而是作曲家命名的主题实体——mood 只是
 * brief 的输入维度之一。
 */
import { z } from "zod";
import {
  MusicScoreSchema,
  type MusicInstrument,
  type MusicMood,
  type MusicScore,
} from "./score.js";

/**
 * 主题 id（slug）：小写字母/数字/连字符，字母或数字开头；无路径分隔符
 * （scores/<themeId>.json 文件名安全由 schema 保证）。
 */
export const ThemeIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "主题 id 必须是 kebab-case slug（≤40 字符）");

/** 主题元数据（themes.json 条目；LLM 只产出输入字段，motifHint 服务层补）。 */
export const MusicThemeMetaSchema = z
  .object({
    id: ThemeIdSchema,
    /** 中文短名（OST 曲目名，如「堡垒回响」）。 */
    title: z.string().min(1).max(20),
    /** 一句话主题概念（如「地下堡垒——压抑的机械回响」）。 */
    concept: z.string().min(1).max(80),
    /** 自由风格短语（如「east-asia 五声、bell 前置」；原地区知识降级为风格提示）。 */
    style: z.string().min(1).max(80).optional(),
    /**
     * 主题动机（服务层从谱面旋律轨确定性提取的头 4–8 音 MIDI 序列，
     * 逗号分隔；LLM 不写——防幻觉，复现时以此为准）。
     */
    motifHint: z
      .string()
      .regex(/^(?:\d{1,3})(?:,\d{1,3}){3,7}$/)
      .optional(),
    /** 变体主题引用的母题 id（如 fortress-calm ← fortress）。 */
    parentTheme: ThemeIdSchema.optional(),
  })
  .strict();
export type MusicThemeMeta = z.infer<typeof MusicThemeMetaSchema>;

/**
 * 作曲家产出的主题输入（compose 决策携带）：motifHint 由服务层从谱面
 * 确定性提取，LLM 不写（schema 拒收防幻觉）。
 */
export const ComposerThemeInputSchema = MusicThemeMetaSchema.omit({ motifHint: true });
export type ComposerThemeInput = z.infer<typeof ComposerThemeInputSchema>;

/** 场景配乐 brief（导演指导 → 作曲家决策请求的输入形状）。 */
export interface SceneMusicBrief {
  sceneId: string;
  sceneGoal?: string;
  mood: MusicMood;
  intensity: 1 | 2 | 3;
  note?: string;
}

/** 作曲家决策（判别联合；schema 校验 LLM 单次 JSON 输出）。 */
export const ComposerDecisionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("reuse"),
      themeId: ThemeIdSchema,
      /** 决策理由（会话留痕 + 诊断）。 */
      reason: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("compose"),
      theme: ComposerThemeInputSchema,
      score: MusicScoreSchema,
      reason: z.string().min(1).max(200),
    })
    .strict(),
]);
export type ComposerDecision = z.infer<typeof ComposerDecisionSchema>;

/** 主题谱面统计（服务层从谱面确定性提取，随目录喂给作曲家作参考）。 */
export interface ThemeScoreStats {
  bpm: number;
  key: number;
  mode: MusicScore["mode"];
  bars: number;
  instruments: MusicInstrument[];
  noteCount: number;
  loopSeconds: number;
}

/** 目录条目 = 主题元数据 + 谱面统计（作曲家决策输入）。 */
export interface ThemeCatalogEntry {
  meta: MusicThemeMeta;
  stats: ThemeScoreStats;
}

/** 作曲家持久会话轮次（music/session.jsonl 的行形状）。 */
export interface ComposerSessionTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * 会话窗口（最近轮数）：目录本身是持久记忆（音乐圣经），会话只辅助
 * 「最近为什么这么决策」；V2 不做 LLM 压缩，只做窗口截断——当单轮
 * 估算字符总量 > 300k 再引入压缩。
 */
export const COMPOSER_SESSION_WINDOW_TURNS = 30;

export function themeScoreStats(score: MusicScore): ThemeScoreStats {
  return {
    bpm: score.bpm,
    key: score.key,
    mode: score.mode,
    bars: score.bars,
    instruments: score.tracks.map((track) => track.instrument),
    noteCount: score.tracks.reduce((sum, track) => sum + track.notes.length, 0),
    loopSeconds: (score.bars * 4 * 60) / score.bpm,
  };
}

/** 铺底轨（长音和声层，不承载旋律动机）。 */
const PAD_INSTRUMENTS = new Set<MusicInstrument>(["pad", "choir"]);

/**
 * 主题动机提取（确定性纯函数）：从旋律轨取头 8 个音（按起拍排序）的
 * MIDI 序列。旋律轨 = 非铺底轨中「平均音高最高且 ≥4 音」的一条；无
 * 候选（铺底谱/过稀疏）= undefined。同谱恒同值——themes.json 里的
 * motifHint 是可复现的谱面指纹而非模型自述。
 */
export function extractMotifHint(score: MusicScore): string | undefined {
  let best:
    | { averageMidi: number; midis: number[] }
    | undefined;
  for (const track of score.tracks) {
    if (PAD_INSTRUMENTS.has(track.instrument) || track.notes.length < 4) continue;
    const sorted = [...track.notes].sort((a, b) => a.beat - b.beat);
    const midis = sorted.slice(0, 8).map((note) => note.midi);
    const averageMidi =
      track.notes.reduce((sum, note) => sum + note.midi, 0) / track.notes.length;
    if (best === undefined || averageMidi > best.averageMidi) {
      best = { averageMidi, midis };
    }
  }
  return best === undefined ? undefined : best.midis.join(",");
}
