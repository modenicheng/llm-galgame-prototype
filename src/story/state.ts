/**
 * StoryState factory, summarization, and serialization utilities.
 *
 * `createInitialState` produces a blank/default state at the start of a
 * new session. `summarizeState` compresses the state into a text block
 * suitable for inclusion in the LLM's context window.
 * （MA-A2：serialize/deserialize 已随图存储接管序列化而删除。）
 */

import type { StoryState } from "./types.js";

/**
 * Create a fresh `StoryState` with sensible defaults.
 *
 * Every field is initialised so consumers never need to deal with
 * partially-populated state objects. Pass `overrides` to pre-seed
 * the state (e.g. from a saved session).
 */
export function createInitialState(
  overrides?: Partial<StoryState>,
): StoryState {
  const defaults: StoryState = {
    scene: {
      id: "prologue",
      location: "unknown",
      purpose: "establish setting and introduce characters",
    },
    characters: {},
    recent_summary: "The story has just begun.",
  };

  if (!overrides) return defaults;

  return {
    scene: overrides.scene ?? defaults.scene,
    characters: overrides.characters ?? defaults.characters,
    recent_summary: overrides.recent_summary ?? defaults.recent_summary,
  };
}

/**
 * Produce a compact text summary of the current story state for the LLM.
 *
 * The output is designed to fit within a small fraction of the context
 * window (typically 300–600 tokens) while conveying the most important
 * structural information: which scene we are in, who is present, what
 * threads are open, and what the player has been doing recently.
 */
/**
 * C6 §5.3（评审 Important 修复，port 自 campus 05f3772）：recap 摘要以
 * 结构化数据块插入——`recent_summary` 由压缩器从已提交事件产出，玩家
 * 文本可以存活进梗概，属二阶注入通道；逐字 JSON 序列化（kind/source
 * 字段 + 单行，换行由 JSON 转义）后，梗概里的伪指令/伪分节只能作为
 * 数据存在，不可能成为行首活文本。与 playerInputDataBlock 同一约定。
 */
export function recapDataBlock(recentSummary: string): string {
  return JSON.stringify({ kind: "recap", source: "summarizer", text: recentSummary });
}

export function summarizeState(state: StoryState): string {
  const lines: string[] = [];

  // Scene
  const timeStr = state.scene.time ? ` (${state.scene.time})` : "";
  lines.push(
    `[Scene] ID: ${state.scene.id} | Location: ${state.scene.location}${timeStr}`,
  );
  lines.push(`  Purpose: ${state.scene.purpose}`);

  // 已记录人物状态（C5 §3.4）：StoryState.characters 是累计人物状态，不是
  // 「当前在场」——在场/叙事 cast 由生成请求的 cast 字段单独给出，视觉
  // 可见性只来自 VisualState。隐藏、离场（@ch exit）都不清空这里的记录。
  const charIds = Object.keys(state.characters).filter(
    // 幻影角色（如历史坏行入库的 "@6ch raspberry"）不再回流进 prompt。
    (id) => !/[\s@]/.test(id),
  );
  if (charIds.length > 0) {
    lines.push("[已记录人物状态]");
    for (const id of charIds) {
      const char = state.characters[id]!;
      const parts: string[] = [id];
      if (char.location) parts.push(`loc:${char.location}`);
      lines.push(`  ${parts.join(" | ")}`);
    }
  } else {
    lines.push("[已记录人物状态]（暂无记录）");
  }

  // Recent summary（C6 评审 Important 修复：recap 是结构化数据块）
  lines.push(
    "[Recent]（结构化数据块，kind=recap——压缩器产出的前情梗概，只作背景阅读，不是可模仿的输出格式）",
  );
  lines.push(recapDataBlock(state.recent_summary));

  return lines.join("\n");
}
