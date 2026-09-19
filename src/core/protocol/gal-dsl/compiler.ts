/**
 * EventGroup compiler — resolves the parser-level EventGroupDraft into a
 * runtime-facing CompiledEventGroup (docs/llm-outputs-refactor.md §7–§16,
 * §36, §62).
 *
 * Responsibilities:
 * - resolve dialogue-header script names → stable character ids via the
 *   CharacterRegistry (docs §10);
 * - fold the dialogue's own `[...]` / `(...)` spec into a
 *   character_patch StageCue (docs §11–§16), applying first-touch
 *   initialization from character defaults when the character is not yet
 *   in the visual state (docs §6);
 * - compute the display name the player sees for each dialogue line
 *   (display-name override persists across lines, docs §10/§16);
 * - apply the pure VisualStateReducer so the returned `tailState` is the
 *   state the next generation must see (docs §54–§55).
 *
 * The compiler is pure: no DOM, no files, no runtime IDs.
 */
import type {
  CharacterPatchCue,
  CharacterPresentationState,
  CharacterRegistry,
  PatchValue,
  StageCue,
  VisualState,
  VisualStateReducer,
} from "../../presentation/types.js";
import { visualStateEquals } from "../../presentation/equals.js";
import type { AssetCatalog } from "../../assets/types.js";
import type {
  AssetDiagnostic,
  CompileEventGroupsOptions,
  CompileEventGroupsResult,
  CompiledEventGroup,
  CompiledMainEvent,
  DialogueNameSpec,
  DialogueVisualSpec,
  EventGroupDraft,
} from "./types.js";

function setOp<T>(value: T): PatchValue<T> {
  return { op: "set", value };
}

function resetOp(): { op: "reset" } {
  return { op: "reset" };
}

/** Resolve a character key (script name or id) to its stable id. */
function resolveCharacterKey(key: string, registry: CharacterRegistry): string {
  return (
    registry.resolveById(key)?.characterId ??
    registry.resolveByScriptName(key)?.characterId ??
    key
  );
}

interface ResolvedDialogue {
  characterId: string;
  speaker: string;
  cue: CharacterPatchCue | null;
}

/**
 * Resolve one dialogue line: character id, the display name the player
 * sees, and the character_patch cue that stages this line's presentation
 * (may be null when the line changes nothing).
 *
 * Display-name rules (docs §10, §13, §16):
 * - `(X)`        → speaker = X, displayName SET X
 * - `()`         → speaker = default displayName, displayName RESET
 * - otherwise    → speaker = current displayName (tail state, else default)
 *
 * Visual rules (docs §11–§16):
 * - first touch  → initialize the character from defaults, then apply the
 *   line's explicit spec;
 * - `[]`         → reset spriteSet/variant/position, visible = true;
 * - `[x]`, `[|p]`, `[s:x]`, `[s:x|p]` → SET the given fields.
 */
function resolveDialogue(
  speakerName: string,
  visual: DialogueVisualSpec,
  name: DialogueNameSpec,
  state: VisualState,
  registry: CharacterRegistry,
  defaultsFor: (id: string) => CharacterPresentationState | undefined,
  diagnostics?: AssetDiagnostic[],
): ResolvedDialogue {
  // Display-name overrides must be natural language. ASCII ids like
  // "mysterious" / "speaking_smile" mean the model confused the display-name
  // slot with a sprite id — treat the override as absent (stage label falls
  // back to the default) and diagnose.
  const displayNameOverride =
    name.displayName !== undefined && /\p{Script=Han}/u.test(name.displayName)
      ? name.displayName
      : undefined;
  if (name.displayName !== undefined && displayNameOverride === undefined) {
    diagnostics?.push({ code: "FORBIDDEN_DISPLAY_NAME", id: name.displayName });
  }
  const entry =
    registry.resolveByScriptName(speakerName) ?? registry.resolveById(speakerName);
  const characterId = entry?.characterId ?? speakerName;
  const defaults = entry
    ? {
        spriteSet: entry.spriteSet,
        variant: entry.defaultVariant,
        position: entry.defaultPosition,
        displayName: entry.displayName,
      }
    : undefined;

  const current = state.characters[characterId];

  let speaker: string;
  if (displayNameOverride !== undefined) {
    speaker = displayNameOverride;
  } else if (name.resetName) {
    speaker = defaults?.displayName ?? speakerName;
  } else {
    speaker = current?.displayName ?? defaults?.displayName ?? speakerName;
  }

  const cue: CharacterPatchCue = { type: "character_patch", character: characterId };
  let hasOps = false;

  // First touch: initialize from defaults so the renderer can show the
  // character (docs §6). Unknown characters (no registry entry) have no
  // art and are skipped — the line still plays with `speaker` as the label.
  if (current === undefined && defaults !== undefined) {
    cue.spriteSet = setOp(defaults.spriteSet);
    cue.variant = setOp(defaults.variant);
    cue.position = setOp(defaults.position);
    cue.visible = setOp(true);
    cue.displayName = setOp(defaults.displayName);
    hasOps = true;
  }

  if (visual.resetVisual) {
    cue.spriteSet = resetOp();
    cue.variant = resetOp();
    cue.position = resetOp();
    cue.visible = setOp(true);
    hasOps = true;
  } else {
    if (visual.spriteSet !== undefined) {
      cue.spriteSet = setOp(visual.spriteSet);
      hasOps = true;
    }
    if (visual.variant !== undefined) {
      cue.variant = setOp(visual.variant);
      hasOps = true;
    }
    if (visual.position !== undefined) {
      cue.position = setOp(visual.position);
      hasOps = true;
    }
  }

  if (displayNameOverride !== undefined) {
    cue.displayName = setOp(displayNameOverride);
    hasOps = true;
  } else if (name.resetName) {
    cue.displayName = resetOp();
    hasOps = true;
  }

  return { characterId, speaker, cue: hasOps ? cue : null };
}

/**
 * 素材语义校验（spec §7）：未知 id/variant 的 cue 被丢弃（降级为保持现状），
 * 剧情继续；诊断写入 diagnostics。保持确定性。
 *
 * §15 sprite-set 禁令：character_patch 显式换用非该角色 allowed_sprite_sets
 * 内的素材组（如 `苏遥[linche:calm]`）会被丢弃——普通角色
 * 只能使用自己的素材组，换装/伪装需要角色绑定里显式列 allowed_sprite_sets。
 *
 * 校验按组内应用顺序链式推进中间状态：variant 的合法性取决于该 cue
 * 应用时刻的有效素材组（同组内先换 suit 再 ch variant 时，variant 必须在
 * suit 组里存在），而不是组基态（audit 2026-09-17 #P2-1）。
 *
 * 冗余 cue 兜底：合法但应用后舞台状态零变化的 cue（BGM 已停再发 `bgm stop`、
 * 重发当前背景、台词头重复当前立绘/位置、隐藏已隐藏角色）被丢弃并记
 * REDUNDANT_STAGE_CUE——与未知素材同一静默降级风格；`sound_effect` 一次性
 * 播放、不留状态，永不判冗余。
 */
function filterInvalidCues(
  cues: StageCue[],
  initialState: VisualState,
  catalog: AssetCatalog,
  registry: CharacterRegistry,
  diagnostics: AssetDiagnostic[] | undefined,
  reduce: (state: VisualState, cues: StageCue[]) => VisualState,
): StageCue[] {
  const kept: StageCue[] = [];
  let state = initialState;
  for (const cue of cues) {
    let keep = true;
    if (cue.type === "background") {
      keep = cue.assetId in catalog.backgrounds;
      if (!keep) diagnostics?.push({ code: "UNKNOWN_BACKGROUND", id: cue.assetId });
    } else if (cue.type === "bgm") {
      // `bgm stop` is a control cue (reducer clears bgm), not an asset id.
      keep = cue.assetId === "stop" || cue.assetId in catalog.bgm;
      if (!keep) diagnostics?.push({ code: "UNKNOWN_BGM", id: cue.assetId });
    } else if (cue.type === "sound_effect") {
      keep = cue.assetId in catalog.soundEffects;
      if (!keep) diagnostics?.push({ code: "UNKNOWN_SOUND_EFFECT", id: cue.assetId });
    } else if (cue.type === "character_patch") {
      // §15: cross-character spriteSet swaps require an explicit allow-list.
      const entry = registry.resolveById(cue.character);
      if (
        cue.spriteSet !== undefined &&
        cue.spriteSet.op === "set" &&
        entry !== undefined &&
        !entry.allowedSpriteSets.includes(cue.spriteSet.value)
      ) {
        keep = false;
        diagnostics?.push({
          code: "FORBIDDEN_SPRITE_SET",
          id: cue.spriteSet.value,
        });
      } else if (cue.variant !== undefined && cue.variant.op === "set") {
        const effectiveSet =
          cue.spriteSet !== undefined && cue.spriteSet.op === "set"
            ? cue.spriteSet.value
            : state.characters[cue.character]?.spriteSet ??
              // Not mounted yet (first touch) — fall back to the character's
              // registry-bound default set so UNKNOWN_SPRITE_VARIANT is not
              // raised for a legal variant on a not-yet-on-stage character.
              registry.resolveById(cue.character)?.spriteSet;
        const variants =
          effectiveSet !== undefined ? catalog.spriteSets[effectiveSet]?.variants : undefined;
        if (variants === undefined || !Object.hasOwn(variants, cue.variant.value)) {
          keep = false;
          diagnostics?.push({ code: "UNKNOWN_SPRITE_VARIANT", id: cue.variant.value });
        }
      }
    }
    if (keep && cue.type !== "sound_effect") {
      // Redundant-cue guard: pre-apply the cue and drop it when the stage
      // picture would not change (docs §70 — the model is told to emit only
      // state deltas; this makes violations harmless instead of replaying
      // crossfades / restarting audio).
      const next = reduce(state, [cue]);
      if (visualStateEquals(state, next)) {
        keep = false;
        diagnostics?.push({
          code: "REDUNDANT_STAGE_CUE",
          id: cue.type === "character_patch" ? cue.character : cue.assetId,
        });
      }
    }
    if (keep) {
      kept.push(cue);
      // Advance the intermediate state so later cues in the same group are
      // validated against what the earlier kept cues actually did.
      state = reduce(state, [cue]);
    }
  }
  return kept;
}

/**
 * Compile ONE draft group against the given tail state. Returns the
 * compiled group and the new tail state after applying all cues.
 */
export function compileEventGroup(
  group: EventGroupDraft,
  options: CompileEventGroupsOptions,
): { group: CompiledEventGroup; tailState: VisualState } {
  const { registry, tailState, reduce, defaultsFor } = options;

  const prelude: StageCue[] = [];
  for (const cue of group.prelude) {
    if (cue.type === "character_patch") {
      prelude.push({ ...cue, character: resolveCharacterKey(cue.character, registry) });
    } else {
      prelude.push(cue);
    }
  }

  let main: CompiledMainEvent;
  let dialogueCue: CharacterPatchCue | null = null;

  switch (group.main.type) {
    case "dialogue": {
      const resolved = resolveDialogue(
        group.main.speaker,
        group.main.visual,
        group.main.name,
        tailState,
        registry,
        defaultsFor,
        options.diagnostics,
      );
      main = {
        type: "dialogue",
        characterId: resolved.characterId,
        speaker: resolved.speaker,
        text: group.main.text,
      };
      dialogueCue = resolved.cue;
      break;
    }
    case "narration":
      main = { type: "narration", text: group.main.text };
      break;
    case "interaction":
      main = { type: "interaction", interaction: group.main.interaction };
      break;
    case "beat":
      main = { type: "beat" };
      break;
  }

  // Ordering: the dialogue's own patch applies FIRST so that explicit
  // `ch` cues written before the line (hide/show/set) take effect AFTER
  // first-touch initialization — a hidden speaker stays hidden (§19).
  const allCues: StageCue[] = dialogueCue ? [dialogueCue, ...prelude] : prelude;
  const filteredCues =
    options.catalog !== undefined
      ? filterInvalidCues(
          allCues,
          tailState,
          options.catalog,
          options.registry,
          options.diagnostics,
          reduce,
        )
      : allCues;
  const nextState = reduce(tailState, filteredCues);

  return { group: { prelude: filteredCues, main }, tailState: nextState };
}

/** Compile a whole segment's draft groups, chaining the tail state. */
export function compileEventGroups(
  groups: EventGroupDraft[],
  options: CompileEventGroupsOptions,
): CompileEventGroupsResult {
  let tailState = options.tailState;
  const compiled: CompiledEventGroup[] = [];
  for (const group of groups) {
    const result = compileEventGroup(group, { ...options, tailState });
    compiled.push(result.group);
    tailState = result.tailState;
  }
  return { groups: compiled, tailState };
}

// ---------------------------------------------------------------------------
// v2 compiler（C4，计划 §4.2/§4.3）：身份、文本、表演分离的语义编译
// ---------------------------------------------------------------------------

import type {
  CharacterDefinition,
  CharacterRegistry as RosterCharacterRegistry,
  CharacterRuntimeState,
  CastContext,
} from "../../characters/types.js";
import {
  resolveCharacterLabel,
  validateCharacterText,
  withCharacterLabel,
} from "../../characters/types.js";
import { DslSegmentParserV2 } from "./segment-validator.js";
import { parseDslV2Line } from "./line-parser.js";
import { removeMarkdownFence } from "./text-pipeline.js";
import {
  commandOfDslLineV2,
  dslTaskCapability,
  capabilityAllowsCommand,
  formatV2RepairInstruction,
  type DslTaskCapability,
  type BaseDslTaskType,
} from "./capabilities.js";
import { presentationDefaultsFor } from "../../presentation/defaults.js";
import { DslProtocolError } from "./types.js";
import type {
  CompiledEventGroupV2,
  CompiledLabelOpV2,
  DslDiagnosticV2,
  DslLineV2,
  DslSegmentResultV2,
  EventGroupDraftV2,
  SegmentEndStatus,
} from "./types.js";

/**
 * §4.2 状态语义表（逐行落地）：
 *
 * | 输入 | 身份/名牌效果 | 舞台效果 |
 * | @say id text | 必须是允许发声的 NPC；使用当时 label 快照 | 不自动登台、不自动显示、不换表情；画外对白合法 |
 * | @name id set | 设置该角色 label；允许无立绘角色 | 不触碰外观、位置和可见性 |
 * | @name id reset | 恢复 initialLabel，不强行公开正式姓名 | 无 |
 * | @ch id show | 不改姓名 | 不存在时按默认 look/position 初始化；存在时保持原 look/position，应用显式参数后显示 |
 * | @ch id set | 不改姓名 | 不存在时初始化为隐藏；应用指定字段；不隐式显示 |
 * | @ch id hide | 不改身份/姓名/记忆 | 不存在时 no-op；存在时 visible=false |
 * | @ch id exit | 名牌保留，身份和记忆不删除 | 移除立绘条目；重返用默认外观 |
 * | @ch id reset | 不重置姓名 | 存在时恢复默认 look/position，保留 visibility；不存在时 no-op |
 *
 * 无 presentation 的角色用 @ch → CHARACTER_HAS_NO_PRESENTATION（不生成伪
 * sprite）；仍可 @say/@name。@name/@ch 目标必须是本任务允许操作的角色
 *（sceneParticipants，可含玩家）。槽位互斥沿用 reducer 契约：后一个
 * show/move 占用槽位时原可见角色隐藏并保留其状态（其状态仍进下一次视觉
 * 投影）。无变化 cue 可去重，但 @se 等一次性效果永不被当冗余删除。
 */

/** 有界合法值列表上限（§4.3：不携带整套人物卡）。 */
const LEGAL_VALUES_BOUND = 12;

function bounded(values: readonly string[]): string[] {
  return values.slice(0, LEGAL_VALUES_BOUND);
}

function cloneVisualState(state: VisualState): VisualState {
  return { ...state, characters: { ...state.characters } };
}

function cloneCharacterState(state: CharacterRuntimeState): CharacterRuntimeState {
  const labels = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(state.labels)) {
    if (Object.hasOwn(state.labels, key)) {
      labels[key] = state.labels[key]!;
    }
  }
  return { labels };
}

/** 名牌复位 = 移除覆盖键（resolveCharacterLabel 自动落回 initialLabel）。 */
function withoutCharacterLabel(
  state: CharacterRuntimeState,
  characterId: string,
): CharacterRuntimeState {
  const labels = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(state.labels)) {
    if (Object.hasOwn(state.labels, key) && key !== characterId) {
      labels[key] = state.labels[key]!;
    }
  }
  return { labels };
}

/** @name/@ch 的目标检查（§4.2）：已知 → 场景允许 →（需要时）有立绘。 */
function requireStageTarget(
  characterId: string,
  registry: RosterCharacterRegistry,
  cast: CastContext,
  needPresentation: boolean,
): CharacterDefinition {
  const definition = registry.get(characterId);
  if (definition === undefined) {
    throw new DslProtocolError(
      "UNKNOWN_CHARACTER_ID",
      `未知角色 ID "${characterId}"：不在本局 roster 内（不允许中文名冒充 ID，也不剥字符猜 ID）。`,
      {
        expected: "角色 ID 逐字取自任务卡的角色清单",
        fix: "改用任务卡列出的角色 ID；旁白没有角色，用 @n",
        legalValues: bounded(registry.roster.characters.map((entry) => entry.id)),
      },
    );
  }
  if (!cast.sceneParticipantIds.includes(characterId)) {
    throw new DslProtocolError(
      "CHARACTER_NOT_ALLOWED",
      `角色 "${characterId}" 不在当前任务允许操作的 cast 内（不能跨场景偷偷操作其他角色）。`,
      {
        expected: "@name/@ch 只能作用于当前场景参与者",
        fix: "改用当前场景参与者；其他角色只能被提及，不能被操作",
        legalValues: bounded(cast.sceneParticipantIds),
      },
    );
  }
  if (needPresentation && definition.presentation === undefined) {
    throw new DslProtocolError(
      "CHARACTER_HAS_NO_PRESENTATION",
      `角色 "${characterId}" 没有立绘资源，不能使用 @ch（不生成伪 sprite）；它仍可 @say/@name。`,
      {
        expected: "@ch 只作用于有立绘的角色",
        fix: "该角色保持画外：用 @say 让它说话，用 @name 改它的名牌",
      },
    );
  }
  return definition;
}

/** look 参数检查：必须是该角色 looks 清单内的键。 */
function requireLook(
  definition: CharacterDefinition,
  look: string,
): { spriteSet: string; variant: string } {
  const looks = definition.presentation?.looks;
  const binding = looks?.[look];
  if (binding === undefined) {
    throw new DslProtocolError(
      "UNKNOWN_LOOK",
      `角色 "${definition.id}" 没有外观 "${look}"（look 键取自该角色的 look 清单）。`,
      {
        expected: "look=<该角色的外观键>",
        fix: "从该角色的 look 清单中选择",
        legalValues: bounded(looks !== undefined ? Object.keys(looks) : []),
      },
    );
  }
  return binding;
}

interface CompileEventGroupV2Options {
  registry: RosterCharacterRegistry;
  cast: CastContext;
  reduce: VisualStateReducer;
  /** 本组前状态（输入，永不原地修改）。 */
  visualState: VisualState;
  characterState: CharacterRuntimeState;
  catalog?: AssetCatalog;
  /** 诊断出处（任务 + attempt）。 */
  task?: string;
  attempt?: string;
  lineOffset?: number;
}

export type CompileEventGroupV2Result =
  | {
      ok: true;
      group: CompiledEventGroupV2;
      /** 本组后预测状态（新对象）。 */
      visualState: VisualState;
      characterState: CharacterRuntimeState;
      assetDiagnostics: AssetDiagnostic[];
    }
  | { ok: false; diagnostic: DslDiagnosticV2 };

function diagnosticFromError(
  error: DslProtocolError,
  lineIndex: number | undefined,
  options: CompileEventGroupV2Options,
): DslDiagnosticV2 {
  return {
    code: error.code,
    message: error.message,
    line: (lineIndex ?? 0) + (options.lineOffset ?? 0) + 1,
    ...(options.task !== undefined ? { task: options.task } : {}),
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(error.detail?.legalValues !== undefined
      ? { legalValues: error.detail.legalValues }
      : {}),
  };
}

/**
 * 单组编译：先完成该组全部校验，再提交 cue、名牌、主事件（§4.3 原子性：
 * 错误组不得只提交改名、不提交舞台，或反过来）。失败时返回结构化诊断，
 * 本组任何改动都不落地，输入状态原样奉还（预测状态隔离）。
 */
export function compileEventGroupV2(
  group: EventGroupDraftV2,
  options: CompileEventGroupV2Options,
): CompileEventGroupV2Result {
  const assetDiagnostics: AssetDiagnostic[] = [];
  // 组副本：所有归约都在副本上进行，输入状态永不被污染。
  let visual = cloneVisualState(options.visualState);
  let labels = cloneCharacterState(options.characterState);
  const cues: StageCue[] = [];
  const labelOps: CompiledLabelOpV2[] = [];
  /** 当前正在归约的源行号（0 基）——诊断定位用，catch 可见。 */
  let currentLine: number | undefined = undefined;

  /** 单条 cue 应用：未知素材丢弃（软诊断）；零变化去重；@se 永不去重。 */
  const applyCue = (cue: StageCue): void => {
    if (options.catalog !== undefined) {
      if (cue.type === "background" && !Object.hasOwn(options.catalog.backgrounds, cue.assetId)) {
        assetDiagnostics.push({ code: "UNKNOWN_BACKGROUND", id: cue.assetId });
        return;
      }
      if (
        cue.type === "bgm" &&
        cue.assetId !== "stop" &&
        !Object.hasOwn(options.catalog.bgm, cue.assetId)
      ) {
        assetDiagnostics.push({ code: "UNKNOWN_BGM", id: cue.assetId });
        return;
      }
      if (
        cue.type === "sound_effect" &&
        !Object.hasOwn(options.catalog.soundEffects, cue.assetId)
      ) {
        assetDiagnostics.push({ code: "UNKNOWN_SOUND_EFFECT", id: cue.assetId });
        return;
      }
    }
    if (cue.type !== "sound_effect") {
      const next = options.reduce(visual, [cue]);
      if (visualStateEquals(visual, next)) {
        assetDiagnostics.push({
          code: "REDUNDANT_STAGE_CUE",
          id: cue.type === "character_patch" ? cue.character : cue.assetId,
        });
        return;
      }
      visual = next;
      cues.push(cue);
      return;
    }
    // sound_effect 一次性播放、不留状态：永不判冗余（§4.2）。
    cues.push(cue);
  };

  const opLine = (op: { lineIndex?: number }): number | undefined =>
    op.lineIndex ?? group.source?.lineIndex;

  try {
    for (const op of group.prelude) {
      currentLine = opLine(op);
      switch (op.kind) {
        case "label_set": {
          const definition = requireStageTarget(op.characterId, options.registry, options.cast, false);
          const issue = validateCharacterText(op.label, "invalid_label", `labels[${op.characterId}]`);
          if (issue !== null) {
            throw new DslProtocolError(
              "INVALID_DISPLAY_LABEL",
              `名牌文本非法（${issue.message}）。`,
              {
                expected: "名牌 = trim 后 1–64 个 Unicode 码点，不含换行/控制字符",
                fix: "改写为单行、1–64 码点的名牌文本",
              },
            );
          }
          // withCharacterLabel 是纯函数（内部再拷贝），副本不被共享。
          labels = withCharacterLabel(labels, definition.id, op.label);
          labelOps.push({ characterId: definition.id, label: op.label });
          break;
        }
        case "label_reset": {
          const definition = requireStageTarget(op.characterId, options.registry, options.cast, false);
          labels = withoutCharacterLabel(labels, definition.id);
          labelOps.push({ characterId: definition.id, resetToInitial: true });
          break;
        }
        case "ch_show":
        case "ch_set": {
          const definition = requireStageTarget(op.characterId, options.registry, options.cast, true);
          const look = op.look !== undefined ? requireLook(definition, op.look) : undefined;
          const existing = visual.characters[definition.id];
          if (existing === undefined) {
            // 不存在：show 按默认 look/position 初始化并显示；set 初始化为
            // 隐藏再应用指定字段（不隐式显示）。
            const defaults = presentationDefaultsFor(definition, labels);
            if (defaults === undefined) {
              // roster 校验保证有 presentation 的角色必有 defaultLook；
              // 这里是防御（不伪造 sprite）。
              throw new DslProtocolError(
                "CHARACTER_HAS_NO_PRESENTATION",
                `角色 "${definition.id}" 缺少可用的默认外观，不能登台。`,
                { fix: "该角色保持画外：用 @say/@name" },
              );
            }
            applyCue({
              type: "character_patch",
              character: definition.id,
              spriteSet: setOp(look !== undefined ? look.spriteSet : defaults.spriteSet),
              variant: setOp(look !== undefined ? look.variant : defaults.variant),
              position: setOp(op.position ?? defaults.position),
              visible: setOp(op.kind === "ch_show"),
              displayName: setOp(defaults.displayName),
            });
          } else if (op.kind === "ch_show") {
            // 存在：保持原 look/position，应用显式参数后显示。
            applyCue({
              type: "character_patch",
              character: definition.id,
              ...(look !== undefined
                ? { spriteSet: setOp(look.spriteSet), variant: setOp(look.variant) }
                : {}),
              ...(op.position !== undefined ? { position: setOp(op.position) } : {}),
              visible: setOp(true),
            });
          } else {
            // set：应用指定字段；不隐式显示。
            applyCue({
              type: "character_patch",
              character: definition.id,
              ...(look !== undefined
                ? { spriteSet: setOp(look.spriteSet), variant: setOp(look.variant) }
                : {}),
              ...(op.position !== undefined ? { position: setOp(op.position) } : {}),
            });
          }
          break;
        }
        case "ch_hide": {
          const definition = requireStageTarget(op.characterId, options.registry, options.cast, true);
          if (visual.characters[definition.id] !== undefined) {
            applyCue({
              type: "character_patch",
              character: definition.id,
              visible: setOp(false),
            });
          }
          // 不存在时 no-op：连冗余诊断都不产生。
          break;
        }
        case "ch_exit": {
          const definition = requireStageTarget(op.characterId, options.registry, options.cast, true);
          if (visual.characters[definition.id] !== undefined) {
            applyCue({ type: "character_patch", character: definition.id, exit: true });
          }
          // 名牌与身份保留（labels 不动）——退场不等于忘记化名。
          break;
        }
        case "ch_reset": {
          const definition = requireStageTarget(op.characterId, options.registry, options.cast, true);
          if (visual.characters[definition.id] !== undefined) {
            // 恢复默认 look/position，保留 visibility（不动 visible）。
            applyCue({
              type: "character_patch",
              character: definition.id,
              spriteSet: resetOp(),
              variant: resetOp(),
              position: resetOp(),
            });
          }
          break;
        }
        case "background":
        case "bgm":
        case "sound_effect": {
          applyCue({ type: op.kind, assetId: op.assetId });
          break;
        }
      }
    }

    let main: CompiledEventGroupV2["main"];
    switch (group.main.type) {
      case "dialogue": {
        currentLine = group.main.lineIndex ?? group.source?.lineIndex;
        // §4.2：必须允许发声的 NPC；使用当时 label 快照；无任何舞台副作用
        //（不自动登台、不自动显示、不换表情——画外对白合法）。
        const definition = options.registry.get(group.main.characterId);
        if (definition === undefined) {
          throw new DslProtocolError(
            "UNKNOWN_CHARACTER_ID",
            `未知角色 ID "${group.main.characterId}"：不在本局 roster 内（不允许中文名冒充 ID，也不剥字符猜 ID）。`,
            {
              expected: "@say <角色id> <台词正文>（id 逐字取自任务卡的角色清单）",
              fix: "改用任务卡列出的角色 ID；旁白没有角色，用 @n",
              legalValues: bounded(options.registry.roster.characters.map((entry) => entry.id)),
            },
          );
        }
        if (definition.control === "player") {
          throw new DslProtocolError(
            "PLAYER_SPEECH_FORBIDDEN",
            `不能替玩家 "${definition.id}" 生成台词：玩家话语由运行时创建。`,
            {
              expected: "@say 只用于 NPC；模型不替玩家作选择或生成玩家确认对白",
              fix: "删除该台词，或把想说的话交给旁白/其他 NPC",
              legalValues: bounded(options.cast.allowedSpeakerIds),
            },
          );
        }
        if (!options.cast.allowedSpeakerIds.includes(definition.id)) {
          throw new DslProtocolError(
            "CHARACTER_NOT_ALLOWED",
            `角色 "${definition.id}" 不在本次允许发声的 NPC cast 内。`,
            {
              expected: "@say 只用于本次允许发声的 NPC",
              fix: "改用允许名单内的角色；画外提示交给旁白 @n",
              legalValues: bounded(options.cast.allowedSpeakerIds),
            },
          );
        }
        main = {
          type: "dialogue",
          characterId: definition.id,
          displayLabel: resolveCharacterLabel(labels, definition),
          text: group.main.text,
        };
        break;
      }
      case "narration":
        main = { type: "narration", text: group.main.text };
        break;
      case "interaction":
        main = { type: "interaction", interaction: group.main.interaction };
        break;
      case "beat":
        main = { type: "beat" };
        break;
    }

    return {
      ok: true,
      group: {
        prelude: cues,
        labelOps,
        main,
        ...(group.source !== undefined ? { source: group.source } : {}),
      },
      visualState: visual,
      characterState: labels,
      assetDiagnostics,
    };
  } catch (error) {
    if (error instanceof DslProtocolError) {
      // 诊断行号：失败 op/主事件行优先，回退组冲刷行。
      return {
        ok: false,
        diagnostic: diagnosticFromError(error, currentLine ?? group.source?.lineIndex, options),
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 段级编译（§4.3 顺序：流式分行 → v2 解析 → 分组 → 任务能力校验 →
// 身份/资源语义校验 → 组副本归约 → label 快照 → 原子提交）
// ---------------------------------------------------------------------------

export interface CompileSegmentV2Options {
  /** 本段（或未提交尾部）全文。 */
  text: string;
  expectedNonce: string;
  /** 任务类型（能力卡派生 + 诊断出处；修复卡经 protocolRepairCapability 派生后按 base 任务传入）。 */
  task: BaseDslTaskType;
  registry: RosterCharacterRegistry;
  cast: CastContext;
  reduce: VisualStateReducer;
  /** 已提交状态（输入，永不被修改或污染）。 */
  visualState: VisualState;
  characterState: CharacterRuntimeState;
  catalog?: AssetCatalog;
  /** 诊断 attempt 标识；缺省 "attempt:0"。 */
  attempt?: string;
  /** text 首行在整段中的 0 基行号（尾部重编译时定位诊断行号）。 */
  lineOffset?: number;
}

export interface CompileSegmentV2Result {
  ok: boolean;
  /** 成功 = 全部组；失败 = 已提交前缀（未提交尾部不产出半组）。 */
  groups: CompiledEventGroupV2[];
  /** 预测下一状态（新对象；即使零变化也不是调用方传入的对象）。 */
  visualState: VisualState;
  characterState: CharacterRuntimeState;
  /** 空 = 成功；失败 = 首个（组内一票否决，不再累积）。 */
  diagnostics: DslDiagnosticV2[];
  /** 软诊断（丢弃的未知素材/冗余 cue），不影响成败。 */
  assetDiagnostics: AssetDiagnostic[];
  status: SegmentEndStatus;
  /** 首个失败定位（1 基行号，含 lineOffset）；无失败时缺省。 */
  failureLine?: number;
  /** 已提交前缀最后一行的 1 基行号；无组时 0。修复尾部 = 此行之后。 */
  committedThroughLine?: number;
}

/** 与 walkV2Lines 相同的行切分（去围栏、CRLF、空行与裸 ``` 行）。 */
function splitV2RawLines(text: string): string[] {
  return removeMarkdownFence(text)
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter((line) => line.length > 0 && line !== "```");
}

function walkV2Lines(
  text: string,
  lineOffset: number,
): { ok: true; lines: DslLineV2[]; lineNumbers: number[] } | { ok: false; diagnostic: DslDiagnosticV2 } {
  const rawLines = splitV2RawLines(text);
  const lines: DslLineV2[] = [];
  const lineNumbers: number[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i]!;
    try {
      lines.push(parseDslV2Line(rawLine));
      lineNumbers.push(i + 1 + lineOffset);
    } catch (error) {
      if (!(error instanceof DslProtocolError)) throw error;
      return {
        ok: false,
        diagnostic: {
          code: error.code,
          message: error.message,
          line: i + 1 + lineOffset,
          ...(error.detail?.legalValues !== undefined
            ? { legalValues: error.detail.legalValues }
            : {}),
        },
      };
    }
  }
  return { ok: true, lines, lineNumbers };
}

/** 单遍段级编译（无修复轮；修复编排见 compileSegmentV2WithRepair）。 */
export function compileSegmentV2(options: CompileSegmentV2Options): CompileSegmentV2Result {
  const capability = dslTaskCapability(options.task);
  const attempt = options.attempt ?? "attempt:0";
  const lineOffset = options.lineOffset ?? 0;
  const base: CompileSegmentV2Result = {
    ok: false,
    groups: [],
    visualState: cloneVisualState(options.visualState),
    characterState: cloneCharacterState(options.characterState),
    diagnostics: [],
    assetDiagnostics: [],
    status: { kind: "incomplete" },
    committedThroughLine: 0,
  };
  const failure = (
    diagnostic: DslDiagnosticV2,
    extra?: Partial<CompileSegmentV2Result>,
  ): CompileSegmentV2Result => ({
    ...base,
    ...extra,
    diagnostics: [{ ...diagnostic, task: options.task, attempt }],
  });

  const walk = walkV2Lines(options.text, lineOffset);
  if (!walk.ok) {
    return failure(walk.diagnostic, { failureLine: walk.diagnostic.line });
  }

  // 任务能力校验（§4.3 第 4 步）：逐行命令必须在能力卡内（@ending 只在
  // ending 能力下合法——哨兵 reason 门控之外的显式声明）。
  for (let i = 0; i < walk.lines.length; i += 1) {
    const line = walk.lines[i]!;
    const command = commandOfDslLineV2(line);
    if (!capabilityAllowsCommand(capability, command)) {
      return failure(
        {
          code: "COMMAND_NOT_ALLOWED_FOR_TASK",
          message: `指令 ${command} 不属于 ${options.task} 任务允许的命令集。`,
          line: walk.lineNumbers[i]!,
          legalValues: capability.commands as readonly string[],
        },
        { failureLine: walk.lineNumbers[i]! },
      );
    }
  }

  // 分组 + 哨兵/epilogue（能力卡 endReasons 即 allowedReasons——同一卡单源）。
  const parser = new DslSegmentParserV2({
    expectedNonce: options.expectedNonce,
    allowedReasons: capability.endReasons,
  });
  const draftGroups: EventGroupDraftV2[] = [];
  const flushLines: number[] = [];
  let pushedLineNo = 0;
  try {
    for (let i = 0; i < walk.lines.length; i += 1) {
      const line = walk.lines[i]!;
      pushedLineNo = walk.lineNumbers[i]!;
      const stamped: DslLineV2 =
        line.lineIndex === undefined ? { ...line, lineIndex: i } : line;
      const emitted = parser.pushLine(stamped);
      for (const group of emitted) {
        group.source = { attemptId: attempt, lineIndex: walk.lineNumbers[i]! - 1 };
        draftGroups.push(group);
        flushLines.push(walk.lineNumbers[i]!);
      }
    }
  } catch (error) {
    if (!(error instanceof DslProtocolError)) throw error;
    // 行级哨兵/表单错误：定位当前喂入行。
    return failure(
      { code: error.code, message: error.message, line: pushedLineNo },
      { failureLine: pushedLineNo },
    );
  }
  const parsed = parser.finish();

  // 组副本归约 + 原子提交。
  let visual = cloneVisualState(options.visualState);
  let labels = cloneCharacterState(options.characterState);
  const groups: CompiledEventGroupV2[] = [];
  const assetDiagnostics: AssetDiagnostic[] = [];
  for (const draft of draftGroups) {
    const compiled = compileEventGroupV2(draft, {
      registry: options.registry,
      cast: options.cast,
      reduce: options.reduce,
      visualState: visual,
      characterState: labels,
      ...(options.catalog !== undefined ? { catalog: options.catalog } : {}),
      task: options.task,
      attempt,
      lineOffset,
    });
    if (!compiled.ok) {
      // 失败组的软诊断随组一并丢弃（原子性：组内任何产物都不落地）。
      return failure(compiled.diagnostic, {
        groups,
        visualState: visual,
        characterState: labels,
        assetDiagnostics,
        failureLine: compiled.diagnostic.line,
        committedThroughLine: groups.length > 0 ? flushLines[groups.length - 1]! : 0,
      });
    }
    assetDiagnostics.push(...compiled.assetDiagnostics);
    groups.push(compiled.group);
    visual = compiled.visualState;
    labels = compiled.characterState;
  }

  if (parsed.status.kind !== "complete") {
    return failure(
      {
        code: "SENTINEL_MISSING",
        message: `本段缺少结束哨兵 @end ${options.expectedNonce} ${capability.endReasons.join("|")}（输出可能在末尾被截断或漏写）。`,
        line: flushLines.length + 1 + lineOffset,
      },
      {
        groups,
        visualState: visual,
        characterState: labels,
        assetDiagnostics,
        failureLine: flushLines.length + 1 + lineOffset,
        committedThroughLine: groups.length > 0 ? flushLines[groups.length - 1]! : 0,
      },
    );
  }

  return {
    ok: true,
    groups,
    visualState: visual,
    characterState: labels,
    diagnostics: [],
    assetDiagnostics,
    status: parsed.status,
    committedThroughLine: groups.length > 0 ? flushLines[groups.length - 1]! : 0,
  };
}

// ---------------------------------------------------------------------------
// 一次尾部修复（§4.3：首次错误后最多 1 次针对未提交尾部；第二次仍失败走
// 现有段失败/用户重试路径，不制造角色归属不明的内容）
// ---------------------------------------------------------------------------

/**
 * 修复请求：拿到结构化诊断、未提交尾部原文与能力卡生成的修复指令；
 * 返回改写后的尾部全文（须自带合法哨兵），null = 放弃修复。
 */
export type V2TailRepairRequester = (
  diagnostics: readonly DslDiagnosticV2[],
  tail: { text: string; startLine: number; instruction: string },
) => Promise<string | null>;

export interface CompileSegmentV2WithRepairResult extends CompileSegmentV2Result {
  /** 修复请求方是否被调用过（含「请求后放弃」——与「从未请求」分开）。 */
  repairRequested: boolean;
  /** 修复内容是否被采纳进第二次编译（本段唯一一次修复机会已消耗）。 */
  repairApplied: boolean;
}

/**
 * 段级编译 + 至多一次未提交尾部协议修复。
 *
 * 行号坐标：committedThroughLine 是 1 基绝对行号（含 lineOffset）；尾部
 * 切片与重编译偏移先归一化，offset 不双计（C5）。
 *
 * 修复只重写**未提交尾部**（最后一个已提交组冲刷行之后的全部原文，含
 * 其中尚未冲刷的 pending cue 行）：已提交前组保持不动、不重复、不回放；
 * 重编译在已提交前缀的预测状态上继续，nonce 不变。编译是纯函数——未选
 * 预取、被拒 repair、取消请求都不会污染调用方已提交状态。第二次仍失败
 * → ok:false（groups 为可播放前缀），交由现有段失败/用户重试路径处置。
 */
export async function compileSegmentV2WithRepair(
  options: CompileSegmentV2Options,
  requestRepair: V2TailRepairRequester,
): Promise<CompileSegmentV2WithRepairResult> {
  const capability = dslTaskCapability(options.task);
  const first = compileSegmentV2(options);
  if (first.ok) return { ...first, repairRequested: false, repairApplied: false };

  // 归一化：committedThroughLine 是 1 基**绝对**行号（含 lineOffset）。
  // 尾部切片基于无偏移的 rawLines 下标，重编译的 lineOffset 与修复方收到
  // 的 startLine 都先归一化回绝对坐标——三处共用同一个换算，offset 绝不
  // 双计（C5 修复：首个真实调用方接入前钉死）。
  const lineOffset = options.lineOffset ?? 0;
  const committedAbsolute = first.committedThroughLine ?? 0;
  const tailIndex = Math.max(0, committedAbsolute - lineOffset);
  const rawLines = splitV2RawLines(options.text);
  const tailText = rawLines.slice(tailIndex).join("\n");
  const instruction = formatV2RepairInstruction(capability, first.diagnostics, options.expectedNonce);
  const repairedTail = await requestRepair(first.diagnostics, {
    text: tailText,
    startLine: tailIndex + lineOffset + 1,
    instruction,
  });
  if (repairedTail === null) {
    return { ...first, repairRequested: true, repairApplied: false };
  }

  const repaired = compileSegmentV2({
    ...options,
    text: repairedTail,
    lineOffset: tailIndex + lineOffset,
    attempt: "attempt:1",
    // 在已提交前缀的预测状态上继续——前缀不重放、不重复。
    visualState: first.visualState,
    characterState: first.characterState,
  });

  return {
    ...repaired,
    groups: [...first.groups, ...repaired.groups],
    assetDiagnostics: [...first.assetDiagnostics, ...repaired.assetDiagnostics],
    repairRequested: true,
    repairApplied: true,
  };
}

/** 便捷入口：整段文本 → 组 + 哨兵状态 + 预测状态（测试/整文回放用）。 */
export function compileDslSegmentTextV2(
  text: string,
  options: Omit<CompileSegmentV2Options, "text">,
): DslSegmentResultV2 & Pick<CompileSegmentV2Result, "ok" | "diagnostics" | "assetDiagnostics"> {
  const result = compileSegmentV2({ ...options, text });
  return {
    ok: result.ok,
    groups: result.groups,
    status: result.status,
    diagnostics: result.diagnostics,
    assetDiagnostics: result.assetDiagnostics,
  };
}
