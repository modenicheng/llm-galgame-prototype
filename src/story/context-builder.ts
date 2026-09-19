/**
 * LLM context builder for the GalGame story engine.
 *
 * Assembles the full LLM prompt context from static prompts, dynamic story
 * state, recent event history, and author configuration. Used by the
 * `StoryGenerator` to construct system and user messages for each API call.
 */

import type { AuthorConfig } from "../config.js";
import type { ModelAssetCatalog } from "../core/assets/types.js";
import type { VisualState } from "../core/presentation/types.js";
import type { CharacterRegistry } from "../core/characters/types.js";
import type { GenerationIdentity } from "../core/ports/story-generator-port.js";
import type { PromptBundle } from "../prompts.js";
import type { StoryContextEvent } from "../schema.js";
import { summarizeState } from "./state.js";
import type { StoryState } from "./types.js";
import {
  projectWriterHistory,
  renderProjectedEvents,
} from "./event-projection.js";

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
  /**
   * C2 角色注册表：在场时历史走身份稳定事件 JSON（§5.1）。缺席 = 兼容
   * 路径（窄测试直连 writer），使用冻结的 legacy 渲染。
   */
  registry?: CharacterRegistry;
  /** Optional author-enforced constraints. */
  authorConfig?: AuthorConfig;
  /** Per-turn narrative director brief (rendered as a director note). */
  /**
   * M4.2 剪报通道（actor-briefing 组装产物）。D9 布局不变——历史区仍置前。
   */
  actorBriefing?: string;
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

  // M3.7：storyLine 只由 per-game 世界提供；无世界启动时省略该段。
  if (input.prompts.storyLine !== undefined) {
    sections.push("===== 故事大纲 =====");
    sections.push(input.prompts.storyLine);
  }

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
 * One plain-text line per history event (docs §69) — LEGACY 兼容渲染
 * （C5 冻结）：只服务无 registry 的兼容边界（窄测试夹具）。运行时 writer
 * 历史一律走 `serializeStoryContext`（身份稳定的事件 JSON，§5.1）——
 * legacy 路径的 `名牌: 台词` 形态可被误解析为新角色，不得回流进生产
 * prompt。Interaction / choice / end events are skipped.
 */
export function serializeStoryContextLegacy(events: StoryContextEvent[]): string {
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
 * C5 §5.1：writer/prefetch/recovery 的历史投影——`projectWriterHistory`
 * 的身份稳定事件 JSON（JSONL）。对白行携带稳定 characterId 与发射时刻
 * 名牌，杜绝 `神秘女子: 台词` 这类可被误解析为新角色的行头格式；未提交
 * 预取事件用 attempt 引用（与已提交 event:<seq> 分开标记）。
 */
export function serializeStoryContext(
  events: StoryContextEvent[],
  registry: CharacterRegistry,
): string {
  return renderProjectedEvents(projectWriterHistory(events, registry));
}

/**
 * Compact text projection of the visual state tail the model must continue
 * from (docs §70 TAIL_VISUAL_STATE). Every dimension is stated explicitly —
 * including "nothing is set": an omitted line used to read as "unknown",
 * which is why the model re-emitted `bgm stop` after the music had already
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
        : `隐藏（说话不会自动显示，需 @ch ${characterId} show 恢复）`;
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
  /** Model-facing asset catalog (logical ids only, docs §59). */
  modelAssetCatalog?: ModelAssetCatalog;
  /**
   * C5 §5.1 身份上下文：协议版本 / roster revision / cast / 名牌状态。
   * 缺席 = 兼容路径（无 registry 的窄测试夹具；运行时请求一律携带）。
   */
  identity?: GenerationIdentity;
}

/**
 * C5 §3.4：本段 cast 段落——允许发声 cast 与场景参与者分列，绝不从
 * 「当前可见立绘」推导。空 allowedSpeakerIds 就是本段不能输出 NPC 台词。
 */
export function renderCastSection(identity: GenerationIdentity): string {
  const label = (id: string): string => {
    const own = identity.characterState.labels[id];
    return Object.hasOwn(identity.characterState.labels, id) && own !== undefined
      ? `${id}（当前名牌：${own}）`
      : id;
  };
  const lines: string[] = [];
  const allowed = identity.cast.allowedSpeakerIds;
  lines.push(
    allowed.length > 0
      ? `允许发声（本段 NPC 台词仅限这些角色 ID）：${allowed.map(label).join("、")}`
      : "允许发声：本段没有可发声 NPC——不要输出任何角色台词，只写旁白。",
  );
  lines.push(
    `场景参与者（含电话/画外角色，不等于台上可见）：${identity.cast.sceneParticipantIds
      .map(label)
      .join("、")}`,
  );
  return lines.join("\n");
}

/**
 * Build the per-request user prompt for DSL mode (docs §70).
 *
 * 段落按「稳定 → 易变」排序，使相邻请求的公共前缀尽可能长（provider 前缀缓存友好）：
 * 剧情历史单调追加（回溯 = 恢复重放天然截尾）、素材目录每世界静态，两者构成
 * 公共前缀；故事状态 / 导演便签 / 舞台状态每回合变化；任务头（回合数、
 * nonce）每请求更换，置于末尾。历史区不做窗口截断——截断或摘要会移动
 * 公共前缀起点，反而破坏缓存局部性（执行清单决议 D9）。
 */
export function buildDslUserPrompt(
  turn: number,
  input: DslContextInput,
  extraInstructions?: string,
): string {
  const sections: string[] = [];

  sections.push("===== 剧情历史 =====");
  sections.push(
    input.recentEvents.length > 0
      ? input.registry !== undefined
        ? serializeStoryContext(input.recentEvents, input.registry)
        : serializeStoryContextLegacy(input.recentEvents)
      : "（当前没有历史事件。）",
  );

  if (input.modelAssetCatalog) {
    sections.push("===== 可用素材 =====");
    sections.push(serializeModelAssetCatalog(input.modelAssetCatalog));
  }

  sections.push("===== 当前故事状态 =====");
  sections.push(summarizeState(input.state));

  if (input.actorBriefing !== undefined && input.actorBriefing !== "") {
    sections.push(input.actorBriefing);
  }

  if (input.tailVisualState) {
    sections.push("===== 当前舞台状态 =====");
    // §3.4：视觉段按 visible 真值列舞台状态——在场名单（不在场清单）由
    // cast 段单独给出，不从素材目录推导。无 identity 的兼容路径保持旧
    // 素材目录推导（字节不变）。
    sections.push(
      serializeVisualContext(
        input.tailVisualState,
        input.identity === undefined ? input.modelAssetCatalog?.characters : undefined,
      ),
    );
  }

  if (input.identity !== undefined) {
    sections.push("===== 本段 cast =====");
    sections.push(renderCastSection(input.identity));
  }

  sections.push(`任务类型：${input.taskType}`);
  sections.push(`当前回合：${turn}`);
  sections.push(`本次续写目标行数：${input.targetLines}`);
  sections.push(`生成段 nonce：${input.generationNonce}`);
  if (input.identity !== undefined) {
    // 身份版本与协议版本进任务头（易变区尾部，不打散稳定前缀）。
    sections.push(`DSL 协议版本：${input.identity.protocolVersion}`);
    sections.push(`身份版本（roster revision）：${input.identity.rosterRevision}`);
  }

  if (extraInstructions) {
    sections.push(extraInstructions);
  }

  return sections.join("\n\n");
}
