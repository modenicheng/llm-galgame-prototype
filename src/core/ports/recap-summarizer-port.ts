/**
 * 滚动前情梗概（recap）压缩端口。
 *
 * 历史窗口（game.history_events，chunk 对齐滑动）向前跳时，滑出窗口的
 * 事件对模型永久不可见。Game 把这批事件交给本端口压缩成短事实记录，
 * 追加进 StoryState.recent_summary（提示词中的 [Recap]），让"前情"常驻
 * 上下文。返回 null 表示压缩不可用（失败/空输入），调用方回退到确定性
 * 摘要（src/story/recap.ts）。
 */
import type { StoredEvent } from "../../schema.js";

/** 压缩附加上下文：让记录员知道框架已有哪些内容，避免重复。 */
export interface RecapSummarizeContext {
  /**
   * 框架已常驻提示词的状态台账 + 既有梗概（summarizeState 输出）。
   * 其中已有条目（人物情绪/目标/关系、canon、线索、已记前情）不应在
   * 新记录里复述。
   */
  frameworkDigest?: string;
}

export interface RecapSummarizerPort {
  /**
   * 把一批滑出历史窗口的事件压缩成中文事实记录（细节优先，单行分号
   * 要点式）。事件按 seq 升序；返回 null 表示无法产出（调用方自行回退）。
   */
  summarize(
    events: readonly StoredEvent[],
    context?: RecapSummarizeContext,
  ): Promise<string | null>;
}
