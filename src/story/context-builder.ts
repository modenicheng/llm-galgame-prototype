/**
 * LLM context builder for the GalGame story engine.
 *
 * Assembles the full LLM prompt context from static prompts, dynamic story
 * state, recent event history, and author configuration. Used by the
 * `StoryGenerator` to construct system and user messages for each API call.
 */

import type { AuthorConfig } from "../config.js";
import type { PromptBundle } from "../prompts.js";
import type { StoryContextEvent } from "../schema.js";
import { summarizeState } from "./state.js";
import type { StoryState } from "./types.js";

// ---------------------------------------------------------------------------
// ContextInput
// ---------------------------------------------------------------------------

export interface ContextInput {
  /** Static world/character/narrative prompts. */
  prompts: PromptBundle;
  /** Current compiled story memory. */
  state: StoryState;
  /** Sliding window of recent events, ordered oldest first. */
  recentEvents: StoryContextEvent[];
  /** Optional author-enforced constraints. */
  authorConfig?: AuthorConfig;
  /**
   * Output format protocol for the system prompt.
   * Comes from `instructions.yaml` → `InstructionSet.output_protocol`.
   */
  outputProtocol: string;
}

// ---------------------------------------------------------------------------
// System context
// ---------------------------------------------------------------------------

/**
 * Build the system-level prompt block.
 *
 * Includes the output format protocol, character settings, story outline,
 * and writing constraints. Does NOT include dynamic state — that goes in
 * the user prompt so it can be refreshed per-turn without rebuilding the
 * system message.
 */
export function buildSystemContext(input: ContextInput): string {
  const sections: string[] = [];

  sections.push(input.outputProtocol);

  if (input.authorConfig) {
    sections.push(buildAuthorConfigSection(input.authorConfig));
  }

  sections.push("===== 角色设定 =====");
  sections.push(input.prompts.characters);

  sections.push("===== 故事大纲 =====");
  sections.push(input.prompts.storyLine);

  sections.push("===== 写作限制 =====");
  sections.push(input.prompts.guideline);

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

/**
 * Build the per-request user prompt.
 *
 * Includes the current turn number, a condensed story state snapshot,
 * the recent event history, and any extra instructions the caller
 * provides (e.g. generation mode hints, repair directives).
 */
export function buildUserPrompt(
  turn: number,
  input: ContextInput,
  extraInstructions?: string,
): string {
  const sections: string[] = [];

  sections.push(`当前回合：${turn}`);

  sections.push("===== 当前故事状态 =====");
  sections.push(summarizeState(input.state));

  sections.push("===== 剧情历史 =====");
  if (input.recentEvents.length > 0) {
    sections.push(serializeHistory(input.recentEvents));
  } else {
    sections.push("（当前没有历史事件。）");
  }

  if (extraInstructions) {
    sections.push(extraInstructions);
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAuthorConfigSection(config: AuthorConfig): string {
  const lines: string[] = [];
  lines.push("===== 作者控制配置 =====");

  const controls = [
    `world: ${config.control.world.mode}`,
    `characters: ${config.control.characters.mode}`,
    `plot: ${config.control.plot.mode}`,
    `endings: ${config.control.endings.mode}`,
    `style: ${config.control.style.mode}`,
  ];
  lines.push(`控制模式: ${controls.join(", ")}`);

  if (config.rules.locked.length > 0) {
    lines.push(`锁定规则:\n${config.rules.locked.map((r) => `  - ${r}`).join("\n")}`);
  }
  if (config.rules.preferred.length > 0) {
    lines.push(`偏好规则:\n${config.rules.preferred.map((r) => `  - ${r}`).join("\n")}`);
  }
  if (config.rules.seeds.length > 0) {
    lines.push(`种子剧情:\n${config.rules.seeds.map((s) => `  - ${s}`).join("\n")}`);
  }

  return lines.join("\n");
}

function serializeHistory(events: StoryContextEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}
