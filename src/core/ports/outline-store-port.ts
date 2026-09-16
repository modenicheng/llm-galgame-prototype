/**
 * OutlineStore port（执行清单 M3.1）——大纲图持久化与修订留痕的唯一入口。
 *
 * 大纲是结构层（设计 §4）：状态机 planned → active → realized（pruned 终态）
 * 的校验复用 `src/core/outline/types.ts` 的冻结谓词；store 对整批 ops 做
 * 事务校验——任何一条非法 op 拒绝整批并大声抛错，不落盘。
 */

import type { OutlineNode } from "../outline/types.js";
import type { SceneId } from "../graph/ids.js";

/** 大纲修订 op（判别联合）。add 只接受 planned 节点（决议 D5）。 */
export type OutlineOp =
  | { type: "add"; node: OutlineNode }
  | { type: "activate"; id: string }
  | { type: "realize"; id: string; instantiatedBy: SceneId }
  | { type: "prune"; id: string };

export interface OutlineSnapshot {
  nodes: OutlineNode[];
  revision: number;
}

export interface OutlineStorePort {
  /** 当前大纲全量 + 修订号（同步内存读取；须先 load）。 */
  getOutline(): OutlineSnapshot;

  /** 启动路径的显式加载：缺文件 = 空大纲 revision 0；损坏抛错。 */
  load(): Promise<OutlineSnapshot>;

  /**
   * 应用一批修订：整批校验 → 落盘（原子写）→ 追加修订日志。任何非法 op
   * 拒绝整批（大声抛错，不写盘）。成功返回新修订号。
   */
  applyRevision(ops: OutlineOp[], reason: string): Promise<number>;
}
