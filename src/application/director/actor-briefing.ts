/**
 * ActorBriefing——演员剪报组装（执行清单 M4.2，§5.2 防火墙）。
 *
 * 防火墙落为**参数形状**：本组装器的输入类型上不存在 outline 全量、结局
 * 候选、他周目数据等字段——结构上无法泄给演员（而非靠提示词请求保密）。
 * 输入只有：记忆子层三段投影（facts/beliefs/lessons）+ 导演场景指令。
 *
 * D9 布局继承：历史区由 buildDslUserPrompt 的「剧情历史」段保持 append-only
 * 置前；本剪报只产中段（易变内容），不引入任何窗口截断。
 * canon 场景相关子集：作者 canon（characters.txt）已常驻 system prompt；
 * runtime canon 子集随 M3.6 canon store 接入后并入本组装器。
 */

import type { NarrativeBrief } from "../../core/narrative/narrative-brief.js";
import { renderDirectorNote } from "../../application/narrative/narrative-context-builder.js";
import type { BeliefState, FactRecord, Lesson } from "../../core/narrative/memory-types.js";
import type { SceneDirective } from "./director-service.js";

export interface ActorBriefingInput {
  /**
   * 导演记忆投影（NarrativeBrief——其字段集不含 outline 全量/结局候选/
   * 他周目数据，形状即防火墙）。渲染复用既有便签渲染函数（随迁不改）。
   */
  memoryBrief?: NarrativeBrief;
  /** 原始已实现事件数（便签 revision 行引用）。 */
  rawEventCount?: number;
  relatedFacts?: readonly FactRecord[];
  characterBeliefs?: readonly BeliefState[];
  avoidanceLessons?: readonly Lesson[];
  directive?: SceneDirective;
}

/** 组装剪报中段（无内容时返回空串 → 调用方省略该段，行为等价旧无便签路径）。 */
export function buildActorBriefing(input: ActorBriefingInput): string {
  const parts: string[] = [];

  if (input.memoryBrief !== undefined) {
    parts.push(renderDirectorNote(input.memoryBrief, input.rawEventCount ?? 0));
  }

  const lines: string[] = [];
  if (input.relatedFacts !== undefined && input.relatedFacts.length > 0) {
    lines.push("[相关既定事实]");
    for (const fact of input.relatedFacts) {
      lines.push(`- ${fact.content}`);
    }
  }

  if (input.characterBeliefs !== undefined && input.characterBeliefs.length > 0) {
    lines.push("[角色认知]");
    for (const belief of input.characterBeliefs) {
      lines.push(`- ${belief.characterId}：${belief.content}`);
    }
  }

  if (input.avoidanceLessons !== undefined && input.avoidanceLessons.length > 0) {
    lines.push("[规避清单]");
    for (const lesson of input.avoidanceLessons) {
      lines.push(`- ${lesson.content}（${lesson.tag}，×${lesson.occurrences}）`);
    }
  }

  if (lines.length > 0) parts.push(lines.join("\n"));

  if (input.directive !== undefined) {
    lines.length = 0;
    lines.push("[场景指令]");
    const d = input.directive;
    if (d.sceneGoal !== undefined) lines.push(`- 目标：${d.sceneGoal}`);
    for (const beat of d.defenseBeats) {
      lines.push(`- 防守：${beat}`);
    }
    if (d.endingPressure) lines.push("- 收束：剧情接近终章，向结局推进");
    if (d.formModes !== undefined && d.formModes.length > 0) {
      lines.push(`- 表单模式收窄：${d.formModes.join("/")}`);
    }
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n");
}
