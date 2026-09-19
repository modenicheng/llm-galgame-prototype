/**
 * Plain-text rendering of the MemoryProjection for the writer prompt
 * (narrative director, Task 7).
 *
 * The director note is a compact "director's note" section: revision
 * annotation, optional director goal (phase / goal / beats), active threads,
 * setup directives, long-form episode memories, anchor progress, and reveal
 * locks. Each subsection is rendered only when its content is present.
 *
 * C8 §6.2：长线记忆（recap 梗概）按固定格式渲染为纯文本——本模块绝不
 * 从自然语言解析角色标签/实体表（反向建表），角色身份只走稳定 ID 标签
 * （见 episode-retriever）。
 */

import type { MemoryProjection } from "../../core/narrative/memory-projection.js";

/**
 * Render the MemoryProjection as a director-note section for the writer
 * prompt. `maxRecentRawEvents` is baked into the revision annotation so the
 * model knows how much raw history follows below.
 */
export function renderMemoryProjection(
  projection: MemoryProjection,
  maxRecentRawEvents: number,
): string {
  const lines: string[] = [];
  const brief = projection;

  lines.push("===== 导演便签 =====");
  lines.push(
    `记忆已整理至事件 ${brief.consolidatedThroughEventSeq}（当前事件 ${brief.currentEventSeq}），最近 ${maxRecentRawEvents} 条原始事件见上方剧情历史。`,
  );

  if (brief.activeThreads.length > 0) {
    lines.push("[活跃剧情线]");
    for (const thread of brief.activeThreads) {
      let line = `- ${thread.id}（${thread.kind}，${thread.status}，${thread.importance}）：${thread.summary}`;
      if (thread.nextPressure !== undefined) {
        line += ` 压力：${thread.nextPressure}`;
      }
      lines.push(line);
    }
  }

  if (brief.setupDirectives.length > 0) {
    lines.push("[伏笔任务]");
    for (const setup of brief.setupDirectives) {
      let line = `- ${setup.action.toUpperCase()} ${setup.id}（${setup.urgency}）`;
      if (setup.premise !== undefined) {
        line += `；前提：${setup.premise}`;
      }
      if (setup.payoff !== undefined) {
        line += `；目标：${setup.payoff}`;
      }
      if (setup.action === "resolve_or_drop") {
        line += "；该伏笔已超期，本段必须推进回收或显式放弃，不得继续悬置";
      }
      if (setup.payoffMissing === true) {
        line += "；未定回收计划";
      }
      lines.push(line);
    }
  }

  if (brief.relevantEpisodes.length > 0) {
    lines.push("[相关长线记忆]");
    for (const episode of brief.relevantEpisodes) {
      lines.push(
        `- 事件 ${episode.fromEventSeq}-${episode.toEventSeq}：${episode.summary}`,
      );
    }
  }

  if (brief.anchors.length > 0) {
    lines.push("[锚点进度]");
    for (const anchor of brief.anchors) {
      lines.push(`- ${anchor.id}：${anchor.status}`);
    }
  }

  if (brief.relatedFacts.length > 0) {
    lines.push("[相关既定事实]");
    for (const fact of brief.relatedFacts) {
      lines.push(`- ${fact.content}`);
    }
  }

  if (brief.characterBeliefs.length > 0) {
    lines.push("[角色认知]");
    for (const belief of brief.characterBeliefs) {
      lines.push(`- ${belief.characterId}：${belief.content}`);
    }
  }

  if (brief.avoidanceLessons.length > 0) {
    lines.push("[规避清单]");
    for (const lesson of brief.avoidanceLessons) {
      lines.push(`- ${lesson.content}（${lesson.tag}，×${lesson.occurrences}）`);
    }
  }

  return lines.join("\n");
}
