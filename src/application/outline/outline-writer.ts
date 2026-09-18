/**
 * OutlineWriter port（执行清单 M3.2，决议 D1）——编剧 = 单次 JSON 调用
 * adapter（沿用单次 JSON 调用 adapter 模式），不引入外部 agent 框架。
 *
 * 用户文本 → 世界设定 + 角色卡 + 初版大纲（一至两个结局）。产物 schema
 * 定义在本文件（非冻结契约）；大纲节点结构复用 `core/outline/types.ts`
 * 的冻结契约（OutlineNode）。
 */

import type { OutlineNode } from "../../core/outline/types.js";
import type { MemoryDigest } from "../../core/graph/types.js";
import type { CanonSnapshot } from "../../core/ports/canon-store-port.js";
import type { RunReview } from "../../core/ports/review-store-port.js";
import type { OutlineOp } from "../../core/ports/outline-store-port.js";
import {
  DELIVERY_TAGS,
  ENERGY_VALUES,
  PACE_VALUES,
  VOLUME_VALUES,
  type VoicePerformanceBaseline,
} from "../audio/performance-compiler.js";
import { z } from "zod";

/**
 * 角色音频画像（角色音频特征设计 §3.1，编剧产出）：描述性词汇，不涉
 * 供应商参数。timbre 是 free 档 instruction 的画像锚；delivery/avoid 是
 * 表达调色板（§14.1 过滤语义同 allowed/forbidden）；baseline 是表演先验。
 */
export interface CharacterVoiceDesign {
  /** 声学画像一句话（≤120 字）：年龄感/质感/音区/口音。 */
  timbre: string;
  /** 表达调色板：该角色"怎么说话"的允许集合。 */
  delivery: string[];
  /** 明确禁止的表达。 */
  avoid?: string[];
  /** 表演基线档位（低于演员逐行意图与导演指导）。 */
  baseline?: VoicePerformanceBaseline;
}

/**
 * 画像的唯一 zod 真源：编剧 LLM 输出校验（outline-writer-adapter）与
 * voice-design.json 落盘校验（voice-design-store）共用；词表从
 * performance-compiler 的运行时常量派生，防手抄漂移。
 */
export const CharacterVoiceDesignSchema = z
  .object({
    timbre: z.string().min(1).max(120),
    delivery: z.array(z.enum(DELIVERY_TAGS)).min(1).max(8),
    avoid: z.exactOptional(z.array(z.enum(DELIVERY_TAGS)).max(8)),
    baseline: z.exactOptional(
      z
        .object({
          pace: z.exactOptional(z.enum(PACE_VALUES)),
          energy: z.exactOptional(z.enum(ENERGY_VALUES)),
          volume: z.exactOptional(z.enum(VOLUME_VALUES)),
        })
        .strict(),
    ),
  })
  .strict();

/** 角色卡（M3.3 渲染进 per-game characters.txt；spriteBinding 可缺省）。 */
export interface DraftCharacter {
  id: string;
  name: string;
  description: string;
  spriteBinding?: string;
  /** 编剧设计的音频画像；缺省 = 无设计，回落既有链路。 */
  voice?: CharacterVoiceDesign;
}

/** 编剧初版产物。outline 全部 planned；act 链 + 1–2 个 ending。 */
export interface WorldDraft {
  worldSetting: string;
  characters: DraftCharacter[];
  outline: OutlineNode[];
}

export interface OutlineWriterRequest {
  /** 玩家的世界描述（自由文本）。 */
  userText: string;
  /** 可选的故事主线种子（作者附加约束）。 */
  seedStoryLine?: string;
}

/** 后台维护请求（M3.4 ②）：大纲现状 + 最近摘要 + 记忆 digest（+ M3.6 canon / M5.5 评注）。 */
export interface OutlineMaintenanceRequest {
  outline: OutlineNode[];
  recentSummary: string;
  memoryDigest: MemoryDigest;
  /** M3.6 ③：canon 快照（跨周目世界真相，编剧维护的约束输入）。 */
  canon?: CanonSnapshot;
  /** M5.5 ②：历史通关评注（评价喂回——编剧校准后续走向的参照）。 */
  reviews?: RunReview[];
}

export interface OutlineWriterPort {
  writeOutline(request: OutlineWriterRequest): Promise<WorldDraft>;
}

/**
 * 大纲后台维护 port（M3.4 ②）：单次 JSON 调用产出候选 OutlineOp[]
 * （只允许 add(planned)/prune；activate/realize 为确定性迁移独占）。
 * 实现方（OutlineWriterAdapter）与 writeOutline 共用同一 LLM client。
 */
export interface OutlineMaintainerPort {
  maintainOutline(request: OutlineMaintenanceRequest): Promise<OutlineOp[]>;
}
