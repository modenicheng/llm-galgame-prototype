/**
 * Event 模式会话记忆代理端口（2026-09-18 落地 2026-09-17 记忆审计定稿）。
 *
 * 定位是**事件流投影器而非第二作者**：从增量提交事件中提取人物状态 /
 * 世界设定（canon）/ 线程推进，写进 StoryState 作后续生成上下文——
 * 绝不产出剧情文本、绝不回写事件流。失败返回 null / 抛异常均可，
 * 调用方（Game）负责失败隔离与水位推进。
 */
import type { StoredEvent } from "../../schema.js";
import type { StoryState, StoryThread } from "../../story/types.js";

/** 人物状态提案——merge-only，只接受非空字段，绝不删除已有字段。 */
export interface MemoryCharacterProposal {
  emotion?: string;
  current_goal?: string;
  relationship_to_player?: string;
}

/** 线程推进提案：按 id 匹配；status 缺省 = 只更新摘要。 */
export interface MemoryThreadProposal {
  id: string;
  summary?: string;
  status?: StoryThread["status"];
}

export interface MemoryAgentProposal {
  characters?: Record<string, MemoryCharacterProposal>;
  /** 世界事实键值对（字符串值）；应用侧按 ≤12 键限额合并。 */
  canon?: Record<string, string>;
  open_threads?: MemoryThreadProposal[];
}

export interface SessionMemoryAgentPort {
  /**
   * 从一批新提交事件（seq 升序）提取状态提案。
   * `state` 是当前 StoryState——adapter 用它渲染紧凑摘要，让模型在
   * 已有认知上做增量更新而不是凭空重写。
   * 返回 null 表示本批无可提取内容或提取失败（调用方失败隔离）。
   */
  derive(events: readonly StoredEvent[], state: StoryState): Promise<MemoryAgentProposal | null>;
}
