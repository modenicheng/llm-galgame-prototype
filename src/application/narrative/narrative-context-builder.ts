/**
 * Plain-text rendering of the NarrativeBrief for the writer prompt
 * (narrative director, Task 7).
 *
 * The director note is a compact "director's note" section: revision
 * annotation, optional director goal (phase / goal / beats), active threads,
 * setup directives, long-form episode memories, anchor progress, and reveal
 * locks. Each subsection is rendered only when its content is present.
 */

import type { NarrativeBrief } from "../../core/narrative/narrative-brief.js";

/**
 * Render the NarrativeBrief as a director-note section for the writer
 * prompt. `maxRecentRawEvents` is baked into the revision annotation so the
 * model knows how much raw history follows below.
 */
export function renderDirectorNote(
  brief: NarrativeBrief,
  maxRecentRawEvents: number,
): string {
  const lines: string[] = [];

  lines.push("===== 导演便签 =====");
  lines.push(
    `记忆已整理至事件 ${brief.consolidatedThroughEventSeq}（当前事件 ${brief.currentEventSeq}），最近 ${maxRecentRawEvents} 条原始事件见下方剧情历史。`,
  );

  if (brief.currentGoal !== undefined) {
    lines.push("[导演目标]");
    if (brief.phase !== undefined) {
      lines.push(`- 阶段：${brief.phase}`);
    }
    lines.push(`- 目标：${brief.currentGoal}`);
    if (brief.beats !== undefined && brief.beats.length > 0) {
      for (const [index, beat] of brief.beats.entries()) {
        lines.push(`- 节拍 ${index + 1}：${beat.purpose}`);
      }
    }
  }

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

  if (brief.revealLocks.length > 0) {
    lines.push("[禁止透露]");
    for (const lock of brief.revealLocks) {
      lines.push(`- ${lock}`);
    }
  }

  return lines.join("\n");
}
