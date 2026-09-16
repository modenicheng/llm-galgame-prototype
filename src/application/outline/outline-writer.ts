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
import type { OutlineOp } from "../../core/ports/outline-store-port.js";

/** 角色卡（M3.3 渲染进 per-game characters.txt；spriteBinding 可缺省）。 */
export interface DraftCharacter {
  id: string;
  name: string;
  description: string;
  spriteBinding?: string;
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

/** 后台维护请求（M3.4 ②）：大纲现状 + 最近摘要 + 记忆 digest（+ M3.6 canon）。 */
export interface OutlineMaintenanceRequest {
  outline: OutlineNode[];
  recentSummary: string;
  memoryDigest: MemoryDigest;
  /** M3.6 ③：canon 快照（跨周目世界真相，编剧维护的约束输入）。 */
  canon?: CanonSnapshot;
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
