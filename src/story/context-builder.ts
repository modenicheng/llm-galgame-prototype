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
// Prompt segments (monitor audit view)
// ---------------------------------------------------------------------------

/**
 * One labeled slice of a prompt message. `text` is a verbatim slice of the
 * final prompt string — leading separators included — so
 * `joinPromptSegments(segments)` reproduces the exact bytes sent to the
 * provider and the audit view cannot drift from the real request.
 */
export interface PromptSegment {
  /** Origin: a repo file path or the producing runtime pipeline. */
  source: string;
  /** Human-readable label for the monitor UI. */
  label: string;
  /** Verbatim prompt slice, including its leading "\n\n" separator. */
  text: string;
}

/** Reassemble the prompt bytes from segments (identity invariant). */
export function joinPromptSegments(segments: readonly PromptSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

/**
 * Accumulates prompt sections as labeled segments while reproducing the
 * legacy `sections.join("\n\n")` byte-for-byte: every section after the
 * first carries its leading "\n\n" inside its segment text, and an optional
 * `===== X =====` header is merged into the same segment as its body.
 */
class SegmentAssembler {
  private readonly segments: PromptSegment[] = [];
  private started = false;

  section(source: string, label: string, body: string, header?: string): void {
    const prefix = this.started ? "\n\n" : "";
    this.started = true;
    this.segments.push({
      source,
      label,
      text: `${prefix}${header !== undefined ? `${header}\n\n` : ""}${body}`,
    });
  }

  result(): PromptSegment[] {
    return this.segments;
  }
}

// ---------------------------------------------------------------------------
// System context
// ---------------------------------------------------------------------------

/**
 * Build the system-level prompt block as labeled segments (see
 * `buildSystemContext` for content and ordering).
 */
export function buildSystemContextSegments(input: ContextInput): PromptSegment[] {
  const assembler = new SegmentAssembler();

  assembler.section("prompts/dsl-protocol.txt", "DSL 协议", input.prompts.dslProtocol);

  if (input.authorConfig) {
    assembler.section(
      "author.yaml",
      "作者控制配置",
      buildAuthorConfigSection(input.authorConfig),
    );
  }

  assembler.section(
    "prompts/characters.txt",
    "角色设定",
    input.prompts.characters,
    "===== 角色设定 =====",
  );
  assembler.section(
    "prompts/story_line.txt",
    "故事大纲",
    input.prompts.storyLine,
    "===== 故事大纲 =====",
  );
  assembler.section(
    "prompts/guideline.txt",
    "写作限制",
    input.prompts.guideline,
    "===== 写作限制 =====",
  );

  return assembler.result();
}

/**
 * Build the system-level prompt block.
 *
 * Includes the output format protocol, character settings, story outline,
 * and writing constraints. Does NOT include dynamic state — that goes in the
 * user prompt so it can be refreshed per-turn without rebuilding the
 * system message. Derived from `buildSystemContextSegments` so the audit
 * view and the sent bytes share one source.
 */
export function buildSystemContext(input: ContextInput): string {
  return joinPromptSegments(buildSystemContextSegments(input));
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
 * One plain-text line per history event (docs §69). Interaction prompts are
 * included as `[交互] …` (truncated): they are the model's own questions, and
 * without them the sliding window loses track of which topics were already
 * raised/resolved — a direct cause of aimless continuation. `choice` and
 * `end` remain skipped (pure machine records).
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
      case "interaction":
        lines.push(`[交互] ${truncateForHistory(event.prompt, 80)}`);
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
        // choice / end — skip (docs §69).
        break;
    }
  }
  return lines.join("\n");
}

/** Cap a single history line so interaction prompts cannot bloat the window. */
function truncateForHistory(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized;
}

/**
 * Compact text projection of the visual state tail the model must continue
 * from (docs §70 TAIL_VISUAL_STATE). Every dimension is stated explicitly —
 * including "nothing is set": an omitted line used to read as "unknown",
 * which is why the model re-emitted `@bgm stop` after the music had already
 * stopped. `roster` (the registered cast) adds an off-stage line so
 * entrances and exits stay grounded in the known cast.
 */
export function serializeVisualContext(
  state: VisualState,
  roster?: ModelAssetCatalog["characters"],
): string {
  const lines: string[] = [
    "以下舞台画面已生效，本段从这一画面继续。只输出发生变化的指令，状态不变时不要重复输出 @bg / @bgm / @ch 或台词头括号。",
  ];
  lines.push(
    state.background !== undefined
      ? `背景：${state.background}`
      : "背景：无（尚未设置）",
  );
  lines.push(
    state.bgm !== undefined
      ? `BGM：${state.bgm}（正在播放）`
      : "BGM：无（当前没有音乐播放，不要再输出 @bgm stop）",
  );

  const characterIds = Object.keys(state.characters);
  if (characterIds.length > 0) {
    lines.push("角色：");
    for (const characterId of characterIds) {
      const character = state.characters[characterId]!;
      const visibility = character.visible
        ? "可见"
        : `隐藏（开口会自动重新登台；正式回场请先 @ch ${characterId} show，并留意其位置是否已被占用）`;
      lines.push(
        `- ${characterId}（显示名：${character.displayName}）：立绘 ${character.spriteSet}/${character.variant}，位置 ${character.position}，${visibility}`,
      );
    }
  } else {
    lines.push("角色：台上无人");
  }

  if (roster !== undefined) {
    const offStage = Object.entries(roster)
      .filter(([id]) => !Object.hasOwn(state.characters, id))
      .map(([, binding]) => binding.displayName);
    if (offStage.length > 0) {
      lines.push(`不在场：${offStage.join("、")}`);
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
  /**
   * 舞台警告（一次性）：上一段播出中系统自动纠正的舞台异常（如隐藏
   * 角色说话被强制登台）。注入一次即清空——提醒模型核对可见性状态。
   */
  stageWarnings?: readonly string[];
  /** Model-facing asset catalog (logical ids only, docs §59). */
  modelAssetCatalog?: ModelAssetCatalog;
  /** Event mode：本局交互进度（让模型感知收束节奏）。 */
  interactionProgress?: { count: number; target?: number };
}

/**
 * Build the per-request user prompt for DSL mode as labeled segments.
 *
 * `extraSegments` are separator-free texts (task template fill, guidance
 * pieces); each becomes its own trailing section joined by "\n\n" — exactly
 * the bytes the legacy string path produced when those pieces were
 * pre-concatenated into one `extraInstructions` string.
 */
export function buildDslUserPromptSegments(
  turn: number,
  input: DslContextInput,
  extraSegments?: readonly PromptSegment[],
): PromptSegment[] {
  const assembler = new SegmentAssembler();

  if (input.modelAssetCatalog) {
    assembler.section(
      "assets/resources.yaml",
      "可用素材",
      serializeModelAssetCatalog(input.modelAssetCatalog),
      "===== 可用素材 =====",
    );
  }

  assembler.section(
    "runtime/history-window",
    `剧情历史（滑窗 ${input.recentEvents.length} 条）`,
    input.recentEvents.length > 0
      ? serializeStoryContext(input.recentEvents)
      : "（当前没有历史事件。）",
    "===== 剧情历史 =====",
  );

  if (input.directorBrief) {
    assembler.section(
      "narrative/director-brief",
      "导演便签",
      renderDirectorNote(input.directorBrief, input.recentEvents.length),
    );
  }

  assembler.section(
    "story/state.ts",
    "当前故事状态（种子 / 前情梗概 / 线索）",
    summarizeState(input.state),
    "===== 当前故事状态 =====",
  );

  if (input.tailVisualState) {
    assembler.section(
      "presentation/visual-state",
      "当前舞台状态",
      serializeVisualContext(input.tailVisualState, input.modelAssetCatalog?.characters),
      "===== 当前舞台状态 =====",
    );
  }

  if (input.stageWarnings !== undefined && input.stageWarnings.length > 0) {
    const warningLines = [
      "上一段发生了系统自动纠正的舞台异常，可能造成预期外的舞台效果。请先对照上方「当前舞台状态」核实各角色可见性，必要时用 @ch <内部id> show / exit 显式调整，之后不要让隐藏状态的角色直接开口：",
      ...input.stageWarnings.map((warning) => `- ${warning}`),
    ];
    assembler.section(
      "runtime/stage-warning",
      "舞台警告",
      warningLines.join("\n"),
      "===== 舞台警告 =====",
    );
  }

  const taskHeaderLines = [
    `任务类型：${input.taskType}`,
    `生成段 nonce：${input.generationNonce}`,
    input.targetLines > 0
      ? `本次续写行数上限：${input.targetLines}`
      : "本次续写行数上限：0（正文预算已用尽，只收尾，不推进剧情）",
    `当前回合：${turn}`,
  ];
  if (input.interactionProgress) {
    const { count, target } = input.interactionProgress;
    taskHeaderLines.push(
      target !== undefined
        ? `本局交互进度：${count} / 收束目标 ${target}`
        : `本局交互进度：${count}`,
    );
  }
  // The legacy assembly pushed each metadata line as its own section, so the
  // lines are "\n\n"-separated inside the prompt.
  assembler.section(
    "runtime/task-header",
    "本段任务（元信息）",
    taskHeaderLines.join("\n\n"),
    "===== 本段任务 =====",
  );

  for (const segment of extraSegments ?? []) {
    assembler.section(segment.source, segment.label, segment.text);
  }

  return assembler.result();
}

/**
 * Build the per-request user prompt for DSL mode.
 *
 * Section order is provider-cache-aware (DeepSeek prefix caching bills a
 * cached prefix much cheaper): the session-static asset catalog leads, the
 * append-mostly history follows, and everything that changes per request
 * (state summary, visual tail, task header with nonce/turn/progress, task
 * instructions) is clustered at the tail. Never insert volatile content
 * before a stable section — it would invalidate the shared prefix.
 * Derived from `buildDslUserPromptSegments` so the audit view and the sent
 * bytes share one source.
 */
export function buildDslUserPrompt(
  turn: number,
  input: DslContextInput,
  extraInstructions?: string,
): string {
  const extra =
    extraInstructions !== undefined && extraInstructions !== ""
      ? [{ source: "runtime/extra", label: "附加指令", text: extraInstructions }]
      : undefined;
  return joinPromptSegments(buildDslUserPromptSegments(turn, input, extra));
}
