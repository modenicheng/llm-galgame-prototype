/**
 * LLM context builder for the GalGame story engine.
 *
 * Assembles the full LLM prompt context from static prompts, dynamic story
 * state, recent event history, and author configuration. Used by the
 * `StoryGenerator` to construct system and user messages for each API call.
 */

import type { AuthorConfig } from "../config.js";
import { renderDirectorNote } from "../application/narrative/narrative-context-builder.js";
import type { NarrativeBrief } from "../core/narrative/narrative-brief.js";
import type { ModelAssetCatalog } from "../core/assets/types.js";
import type { VisualState } from "../core/presentation/types.js";
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
  /** Per-turn narrative director brief (rendered as a director note). */
  directorBrief?: NarrativeBrief;
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

  sections.push(input.prompts.dslProtocol);

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

// ---------------------------------------------------------------------------
// DSL serializers (docs/llm-outputs-refactor.md §69–§70)
//
// Plain-text projections that replace the old per-event JSON.stringify in
// DSL mode. Runtime metadata (seq/turn/timestamp/source/line_id) is never
// emitted — the model only needs the narrative content.
// ---------------------------------------------------------------------------

/**
 * One plain-text line per history event (docs §69). Interaction / choice /
 * end events are skipped: they are machine prompts, not narrative content.
 */
export function serializeStoryContext(events: StoryContextEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case "narration":
        lines.push(event.text);
        break;
      case "dialogue":
        // Portrait is a runtime visual directive — never sent to the model.
        lines.push(`${event.speaker}: ${event.text}`);
        break;
      case "player_choice":
        lines.push(`[玩家] 选择：${event.text}`);
        break;
      case "player_input":
        lines.push(`[玩家] 输入：${event.text}`);
        break;
      case "player_dialogue":
        lines.push(`[玩家] ${event.text}`);
        break;
      default:
        // interaction / choice / end — skip (docs §69).
        break;
    }
  }
  return lines.join("\n");
}

/**
 * Compact text projection of the visual state tail the model must continue
 * from (docs §70 TAIL_VISUAL_STATE). Omitted when the caller has none.
 */
export function serializeVisualContext(state: VisualState): string {
  const lines: string[] = [];
  if (state.background !== undefined) lines.push(`背景：${state.background}`);
  if (state.bgm !== undefined) lines.push(`BGM：${state.bgm}`);

  const characterIds = Object.keys(state.characters);
  if (characterIds.length > 0) {
    lines.push("角色：");
    for (const characterId of characterIds) {
      const character = state.characters[characterId]!;
      lines.push(
        `- ${characterId}（显示名：${character.displayName}）：立绘 ${character.spriteSet}/${character.variant}，位置 ${character.position}，${character.visible ? "可见" : "隐藏"}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Compact listing of the model-facing asset catalog (docs §59, §70): the
 * catalog guidance followed by one line per background / bgm / sound effect
 * / sprite-set variant and one line per character binding.
 */
export function serializeModelAssetCatalog(catalog: ModelAssetCatalog): string {
  const lines: string[] = [];
  if (catalog.guidance) lines.push(catalog.guidance.trim());

  for (const [id, asset] of Object.entries(catalog.backgrounds)) {
    lines.push(`背景：${id} — ${asset.description}`);
  }
  for (const [id, asset] of Object.entries(catalog.bgm)) {
    lines.push(`BGM：${id} — ${asset.description}`);
  }
  for (const [id, asset] of Object.entries(catalog.soundEffects)) {
    lines.push(`音效：${id} — ${asset.description}`);
  }
  for (const [id, set] of Object.entries(catalog.spriteSets)) {
    lines.push(`立绘组 ${id}：${set.description ?? ""}`);
    for (const [variantId, variant] of Object.entries(set.variants)) {
      lines.push(`  ${variantId} — ${variant.description ?? ""}`);
    }
  }

  const characterIds = Object.keys(catalog.characters);
  if (characterIds.length > 0) {
    lines.push("角色：");
    for (const id of characterIds) {
      const binding = catalog.characters[id]!;
      lines.push(
        `- ${id}（脚本名：${binding.scriptName}，默认显示名：${binding.displayName}，立绘组：${binding.spriteSet}，默认立绘：${binding.defaultVariant}，默认位置：${binding.defaultPosition}，可用立绘组：${binding.allowedSpriteSets.join("/")}）`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// DSL user prompt (docs §70)
// ---------------------------------------------------------------------------

/** Context input for DSL-mode generation requests. */
export interface DslContextInput extends ContextInput {
  /** Task type, e.g. "opening" / "continuation" (docs §70 TASK_TYPE). */
  taskType: string;
  /** The @end sentinel nonce this request must echo back (docs §45). */
  generationNonce: string;
  /** Approximate number of text lines to generate (docs §70). */
  targetLines: number;
  /** Visual state at the tail the model continues from (docs §70). */
  tailVisualState?: VisualState;
  /** Model-facing asset catalog (logical ids only, docs §59). */
  modelAssetCatalog?: ModelAssetCatalog;
}

/**
 * Build the per-request user prompt for DSL mode: task header, turn, story
 * state, plain-text history, tail visual state, asset catalog, then any
 * task-specific instructions (docs §70).
 */
export function buildDslUserPrompt(
  turn: number,
  input: DslContextInput,
  extraInstructions?: string,
): string {
  const sections: string[] = [];

  sections.push(`任务类型：${input.taskType}`);
  sections.push(`生成段 nonce：${input.generationNonce}`);
  sections.push(`本次续写目标行数：${input.targetLines}`);

  sections.push(`当前回合：${turn}`);

  sections.push("===== 当前故事状态 =====");
  sections.push(summarizeState(input.state));

  sections.push("===== 剧情历史 =====");
  sections.push(
    input.recentEvents.length > 0
      ? serializeStoryContext(input.recentEvents)
      : "（当前没有历史事件。）",
  );

  if (input.directorBrief) {
    sections.push(
      renderDirectorNote(input.directorBrief, input.recentEvents.length),
    );
  }

  if (input.tailVisualState) {
    sections.push("===== 当前舞台状态 =====");
    sections.push(serializeVisualContext(input.tailVisualState));
  }

  if (input.modelAssetCatalog) {
    sections.push("===== 可用素材 =====");
    sections.push(serializeModelAssetCatalog(input.modelAssetCatalog));
  }

  if (extraInstructions) {
    sections.push(extraInstructions);
  }

  return sections.join("\n\n");
}
