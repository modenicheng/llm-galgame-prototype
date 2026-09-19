/**
 * Gal DSL protocol types — the model-facing line language
 * (docs/llm-outputs-refactor.md §4–§51).
 *
 * Layering (docs §40):
 *
 *   StreamLineDecoder → DslLineParser → EventGroupBuilder → SegmentValidator
 *
 * This module contains ONLY the shared shapes for that pipeline. The
 * implementations live in stream-decoder.ts, line-parser.ts,
 * interaction-builder.ts, group-builder.ts, segment-validator.ts and
 * compiler.ts. Nothing here touches the runtime, the wire, or the LLM.
 */
import type {
  CharacterPosition,
  StageCue,
  VisualState,
  VisualStateReducer,
  CharacterRegistry,
  CharacterPresentationState,
} from "../../presentation/types.js";
import type { AssetCatalog } from "../../assets/types.js";

export type { StageCue } from "../../presentation/types.js";

// ---------------------------------------------------------------------------
// Single parsed line (docs §42)
// ---------------------------------------------------------------------------

/** Content of the `[ ... ]` visual slot of a dialogue header (docs §8–§9, §12, §15). */
export interface DialogueVisualSpec {
  /**
   * Whether the header carried any bracket content (`[anxious]`, `[|left]`,
   * `[]`, ...). `false` for a plain `苏遥: ...`.
   */
  hasVisual: boolean;
  /**
   * `[]` → visual reset (spriteSet/variant/position → defaults, visible →
   * true). Mutually exclusive with spriteSet/variant/position.
   */
  resetVisual: boolean;
  /** Sprite-set override from `[placeholder_char:anxious]` (docs §8). */
  spriteSet?: string;
  /** Variant from `[anxious]` or `[placeholder_char:anxious]`. */
  variant?: string;
  /** Position from `[anxious|left]` / `[|left]` (docs §9). */
  position?: CharacterPosition;
}

/** Content of the `( ... )` name slot of a dialogue header (docs §10, §13). */
export interface DialogueNameSpec {
  /** Whether the header carried any paren content. */
  hasName: boolean;
  /** `()` → displayName reset to the character default. */
  resetName: boolean;
  /** Explicit display-name override, e.g. `(神秘女子)`. */
  displayName?: string;
}

export type DslLine =
  | { kind: "narration"; text: string }
  | {
      kind: "dialogue";
      speaker: string;
      text: string;
      visual: DialogueVisualSpec;
      name: DialogueNameSpec;
    }
  | { kind: "background"; assetId: string }
  | { kind: "bgm"; assetId: string }
  | { kind: "sound_effect"; assetId: string }
  /**
   * `ch <character_id>:<variant> [position]` → action "set";
   * `ch <character_id> hide|show|exit` → action "hide" | "show" | "exit"
   * (docs §17–§19; exit removes the character from the stage entirely).
   */
  | {
      kind: "character_cue";
      characterId: string;
      variant?: string;
      position?: CharacterPosition;
      action: "set" | "show" | "hide" | "exit";
    }
  | { kind: "beat" }
  | { kind: "form_start"; prompt: string }
  | { kind: "form_option"; text: string }
  | { kind: "form_input"; placeholder: string }
  | { kind: "form_end" }
  /**
   * `@ending <档位> <结尾词>` — 结局元数据行。只允许紧跟在
   * `@end <nonce> ending` 哨兵之后（合法性由 segment-validator 按状态
   * 判定）；raw 是 `@ending` 之后的剩余原文，token 解析见
   * interpretEndingEpilogue。
   */
  | { kind: "ending_epilogue"; raw: string }
  | { kind: "segment_end"; nonce: string; reason: SegmentEndReason };

// ---------------------------------------------------------------------------
// 协议版本与 v2 行类型（C4，计划 §4.1）
// ---------------------------------------------------------------------------

/** 服务端 DSL 协议版本：1=legacy（冻结于 legacy-line-parser.ts），2=身份/文本/表演分离语法。 */
export type DslProtocolVersion = 1 | 2;

/** 版本路由选项；解析层缺省 protocolVersion = 1（legacy reader；服务端新局默认已是 2，Ruling 15）。 */
export interface DslParseOptions {
  protocolVersion?: DslProtocolVersion;
  /** 仅 v1 使用：注册说话人表（全角冒号归一化的门卫）。v2 忽略。 */
  knownSpeakers?: ReadonlySet<string>;
}

/**
 * Gal DSL v2 单行解析结果（计划 §4.1 逐条语法）。
 *
 * 与 v1 的本质差异：台词/旁白的正文起点 = 固定数量 token 之后的剩余原文，
 * 不再用 `:`、`[]`、`()` 识别角色或外观——正文里的冒号、括号、`$&`、
 * 类似命令的片段都是普通文本。机器身份只经 ASCII 角色 ID 表达。
 */
export type DslLineV2 =
  /** `@say <characterId> <单行台词正文>` */
  | { kind: "say"; characterId: string; text: string; lineIndex?: number }
  /** `@n <单行旁白正文>` */
  | { kind: "narration"; text: string; lineIndex?: number }
  /** `@name <characterId> set <单行名牌文本>` */
  | { kind: "name_set"; characterId: string; label: string; lineIndex?: number }
  /** `@name <characterId> reset` */
  | { kind: "name_reset"; characterId: string; lineIndex?: number }
  /** `@ch <characterId> show [look=<lookId>] [position=<slot>]` */
  | { kind: "ch_show"; characterId: string; look?: string; position?: CharacterPosition; lineIndex?: number }
  /** `@ch <characterId> set look=<lookId> [position=<slot>]` / `@ch <characterId> set position=<slot>` */
  | { kind: "ch_set"; characterId: string; look?: string; position?: CharacterPosition; lineIndex?: number }
  /** `@ch <characterId> hide` */
  | { kind: "ch_hide"; characterId: string; lineIndex?: number }
  /** `@ch <characterId> exit` */
  | { kind: "ch_exit"; characterId: string; lineIndex?: number }
  /** `@ch <characterId> reset` */
  | { kind: "ch_reset"; characterId: string; lineIndex?: number }
  | { kind: "background"; assetId: string; lineIndex?: number }
  | { kind: "bgm"; assetId: string; lineIndex?: number }
  | { kind: "sound_effect"; assetId: string; lineIndex?: number }
  | { kind: "beat"; lineIndex?: number }
  | { kind: "form_start"; prompt: string; lineIndex?: number }
  | { kind: "form_option"; text: string; lineIndex?: number }
  | { kind: "form_input"; placeholder: string; lineIndex?: number }
  | { kind: "form_end"; lineIndex?: number }
  /** `@ending <TE|HE|NE|BE> <结尾标题>`：行形状与哨兵窗口语义同 v1（task 能力门控见 capabilities.ts）。 */
  | { kind: "ending_epilogue"; raw: string; lineIndex?: number }
  | { kind: "segment_end"; nonce: string; reason: SegmentEndReason; lineIndex?: number };

/** 任一协议版本的行（DslSegmentParser 两个变体的公共输入类型）。 */
export type AnyDslLine = DslLine | DslLineV2;

// ---------------------------------------------------------------------------
// Interaction draft (docs §24–§31)
// ---------------------------------------------------------------------------

/** Interaction mode derived by the parser from the form content (docs §28). */
export type InteractionMode = "choice" | "input" | "hybrid";

/**
 * The parser-level interaction: just creative content. All machine fields
 * (interaction_id, option ids, InputSpec kind/max_length) are added by the
 * runtime compiler (docs §30–§31).
 */
export interface DslInteractionDraft {
  prompt: string;
  optionTexts: string[];
  inputPlaceholder?: string;
  mode: InteractionMode;
}

// ---------------------------------------------------------------------------
// Event groups (docs §36–§39)
// ---------------------------------------------------------------------------

export type MainEventDraft =
  | {
      type: "dialogue";
      speaker: string;
      text: string;
      /** `[...]` visual spec of the dialogue header (docs §8–§12). */
      visual: DialogueVisualSpec;
      /** `(...)` name spec of the dialogue header (docs §10, §13). */
      name: DialogueNameSpec;
    }
  | { type: "narration"; text: string }
  | { type: "interaction"; interaction: DslInteractionDraft }
  | { type: "beat" };

/**
 * An atomic playback unit: ordered stage cues followed by one main event
 * (docs §36). `prelude` includes the character patches derived from the
 * dialogue header itself (`苏遥[anxious]` → character_patch cue).
 */
/** Ephemeral monitor provenance; absent for tests and non-stream producers. */
export interface DslSourceLocation {
  attemptId: string;
  lineIndex: number;
}

export interface EventGroupDraft {
  prelude: StageCue[];
  main: MainEventDraft;
}

// ---------------------------------------------------------------------------
// v2 事件组（C4，计划 §4.3）
// ---------------------------------------------------------------------------

/**
 * v2 组前奏操作：按源顺序保留的 @ch/@name/@bg/@bgm/@se 意图（未解析到
 * 具体 StageCue——外观默认值、无立绘判定、look 合法性都要 registry +
 * 状态，是 compiler 的职责，§4.2 状态表在那里精确落地）。
 *
 * `lineIndex`：可选的源行号（0 基，相对本段），由流式/文本管线在入列时
 * 盖章，供语义诊断定位行号；直接构造（测试）可省略。
 */
export type V2StageOp =
  | { kind: "ch_show"; characterId: string; look?: string; position?: CharacterPosition; lineIndex?: number }
  | { kind: "ch_set"; characterId: string; look?: string; position?: CharacterPosition; lineIndex?: number }
  | { kind: "ch_hide"; characterId: string; lineIndex?: number }
  | { kind: "ch_exit"; characterId: string; lineIndex?: number }
  | { kind: "ch_reset"; characterId: string; lineIndex?: number }
  | { kind: "label_set"; characterId: string; label: string; lineIndex?: number }
  | { kind: "label_reset"; characterId: string; lineIndex?: number }
  | { kind: "background"; assetId: string; lineIndex?: number }
  | { kind: "bgm"; assetId: string; lineIndex?: number }
  | { kind: "sound_effect"; assetId: string; lineIndex?: number };

/** v2 组主事件草稿：@say 的身份是机器 ID，名牌快照由 compiler 生成。 */
export type MainEventDraftV2 =
  | { type: "dialogue"; characterId: string; text: string; lineIndex?: number }
  | { type: "narration"; text: string; lineIndex?: number }
  | { type: "interaction"; interaction: DslInteractionDraft; lineIndex?: number }
  | { type: "beat"; lineIndex?: number };

/** v2 原子播放单元：有序前奏操作 + 一个主事件（同 §36 分组规则）。 */
export interface EventGroupDraftV2 {
  prelude: V2StageOp[];
  main: MainEventDraftV2;
  /** Ephemeral monitor provenance; absent for tests and non-stream producers. */
  source?: DslSourceLocation;
}

export type AnyEventGroupDraft = EventGroupDraft | EventGroupDraftV2;

/**
 * 流式组缝（main-v2-adapter v2 接线，port 自 campus a1b7aac）：生成器
 * handle/信封携带的组——v1 会话是冻结的解析级草稿（EventGroupDraft，
 * Game 侧 compileEventGroup 编译），v2 会话是 compileSegmentV2 语义编译
 * 后的已提交组（CompiledEventGroupV2，Game 侧只应用：cue 归约 + labelOps
 * 折叠 + displayLabel 快照）。
 *
 * 判别式契约（campus v2decode review Minor 钉死）：运行时判别 =
 * `"labelOps" in group`——`labelOps` 是 CompiledEventGroupV2 的专属必填
 * 字段，EventGroupDraft 及其 prelude/main 形状**永远不得**新增同名成员；
 * 同理 CompiledMainEventV2 的对白变体只携带 `displayLabel`（不携带 v1
 * 草稿对白的 `speaker`）。不加显式版本 tag 的原因：会破坏全部存量
 * EventGroupDraft 字面量（v1 冻结面）。新增会与判别式冲突的字段时，
 * 必须同步改为显式 tag 并全量迁移。
 */
export type AnyStreamedGroup = EventGroupDraft | CompiledEventGroupV2;

// ---------------------------------------------------------------------------
// Segment end sentinel (docs §44–§51)
// ---------------------------------------------------------------------------

export type SegmentEndReason = "buffer" | "interaction" | "ending";

/**
 * 结局档位（@ending 指令的受控词表）。现场活动按档位分发奖品：
 * TE 真结局 / HE 圆满 / NE 平淡 / BE 坏结局。
 */
export type EndingGrade = "TE" | "HE" | "NE" | "BE";

export const ENDING_GRADES: readonly EndingGrade[] = ["TE", "HE", "NE", "BE"];

/** @ending 行解析出的结局元数据。两项都可缺省：档位缺省 NE，结尾词 UI 回退「剧终」。 */
export interface SegmentEndingEpilogue {
  grade?: EndingGrade;
  title?: string;
}

export type SegmentEndStatus =
  | {
      kind: "complete";
      nonce: string;
      reason: SegmentEndReason;
      /** 仅 reason === "ending" 且模型写了 @ending 行时附加。 */
      epilogue?: SegmentEndingEpilogue;
    }
  | { kind: "incomplete" };

export interface DslSegmentResult {
  /** Fully committed groups, in order (truncated tail never enters). */
  groups: EventGroupDraft[];
  status: SegmentEndStatus;
}

// ---------------------------------------------------------------------------
// Protocol errors (docs §15, §28, §103)
// ---------------------------------------------------------------------------

export type DslErrorCode =
  | "INVALID_VISUAL_BRACKET"
  | "INVALID_NAME_PAREN"
  | "INVALID_CH_CUE"
  | "FORM_LINE_OUTSIDE_FORM"
  | "FORM_END_WITHOUT_OPEN"
  | "FORM_ALREADY_OPEN"
  | "CONTENT_INSIDE_OPEN_FORM"
  | "EMPTY_FORM"
  | "EMPTY_FORM_PROMPT"
  | "EMPTY_OPTION_TEXT"
  | "EMPTY_INPUT_PLACEHOLDER"
  | "MULTIPLE_INPUT_FIELDS"
  | "FORM_OPEN_AT_SENTINEL"
  | "ENDING_EPILOGUE_ORPHAN"
  | "SENTINEL_NOT_LAST"
  | "SENTINEL_NONCE_MISMATCH"
  | "SENTINEL_DUPLICATE"
  | "SENTINEL_INVALID_REASON"
  | "SENTINEL_MISSING_REASON"
  | "UNKNOWN_LINE"
  | "UNKNOWN_COMMAND"
  | "RETIRED_ALIAS"
  // ---- v2（C4，计划 §4.1/§4.3）。语义诊断码一字不改：UNKNOWN_CHARACTER_ID、
  // PLAYER_SPEECH_FORBIDDEN、CHARACTER_NOT_ALLOWED、UNKNOWN_LOOK、
  // INVALID_CH_PARAMETER、INVALID_DISPLAY_LABEL、CHARACTER_HAS_NO_PRESENTATION。
  | "MISSING_BODY"
  | "INVALID_CH_PARAMETER"
  | "INVALID_DISPLAY_LABEL"
  | "UNKNOWN_CHARACTER_ID"
  | "PLAYER_SPEECH_FORBIDDEN"
  | "CHARACTER_NOT_ALLOWED"
  | "UNKNOWN_LOOK"
  | "CHARACTER_HAS_NO_PRESENTATION"
  | "COMMAND_NOT_ALLOWED_FOR_TASK"
  | "SENTINEL_MISSING";

/**
 * 结构化错误细节（FastAPI 式 detail）：随 DslProtocolError 一并抛出，
 * 由 formatDslErrorDetail 序列化成修复指令注入下一轮请求。字段全部
 * 可选——解析器知道多少写多少。
 */
export interface DslErrorDetail {
  /** 期望的行格式或合法指令清单。 */
  expected?: string;
  /** 最可能的成因（如“台词行误加 @”“变体槽出现中文”）。 */
  cause?: string;
  /** 修复建议，含正确示例。 */
  fix?: string;
  /**
   * 相关合法值的有界列表（角色 ID、look 键、位置词……，§4.3）：只列
   * 有界集合，绝不携带整套敏感人物卡。v2 诊断与修复模板的数据源。
   */
  legalValues?: readonly string[];
}

/** 所有指令的 @ 前缀清单——未知 @ 行的报错与提示词都引用它。 */
export const DSL_COMMAND_LIST =
  "@bg <背景id>、@bgm <音乐id|stop>、@se <音效id>、@ch <角色内部id>:<立绘变体> [位置]、@ch <id> hide|show|exit、@beat、@? <提示>、@+ <选项>、@= <占位文本>、@/?、@end <nonce> <reason>";

/** v2 语法指令清单（计划 §4.1 逐字）——v2 未知行报错引用。 */
export const DSL_COMMAND_LIST_V2 =
  "@say <角色id> <台词正文>、@n <旁白正文>、@name <角色id> set <名牌文本>、@name <角色id> reset、@ch <角色id> show [look=<外观id>] [position=<位置>]、@ch <角色id> set look=<外观id> [position=<位置>]、@ch <角色id> set position=<位置>、@ch <角色id> hide、@ch <角色id> exit、@ch <角色id> reset、@bg <背景id>、@bgm <音乐id|stop>、@se <音效id>、@beat、@? <交互问句>、@+ <选项正文>、@= <输入提示>、@/?、@end <nonce> <buffer|interaction|ending>、@ending <TE|HE|NE|BE> <结尾标题>";

/**
 * A structural violation of the DSL. The message doubles as the repair
 * instruction embedded in the next user prompt (docs §8.5).
 */
export class DslProtocolError extends Error {
  readonly code: DslErrorCode;
  readonly detail?: DslErrorDetail;
  constructor(code: DslErrorCode, message: string, detail?: DslErrorDetail) {
    super(message);
    this.name = "DslProtocolError";
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

/**
 * Serialize a DSL error into the multi-line repair instruction that rides
 * into the next request's user prompt (docs §8.5). FastAPI-style: code,
 * offending line, cause, expected format and a concrete fix — enough for
 * the model to correct the exact line instead of guessing.
 */
export function formatDslErrorDetail(
  error: DslProtocolError,
  lineIndex: number,
  rawLine?: string,
): string {
  const lines = [`第 ${lineIndex} 行 DSL 错误 [${error.code}]：${error.message}`];
  if (rawLine !== undefined && rawLine !== "") {
    lines.push(`错误行：\`${rawLine}\``);
  }
  const detail = error.detail;
  if (detail?.cause !== undefined) lines.push(`原因：${detail.cause}`);
  if (detail?.expected !== undefined) lines.push(`期望格式：${detail.expected}`);
  if (detail?.fix !== undefined) lines.push(`修正：${detail.fix}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Compiler output (docs §36, §62, §63)
// ---------------------------------------------------------------------------

export type CompiledMainEvent =
  | { type: "dialogue"; characterId: string; speaker: string; text: string }
  | { type: "narration"; text: string }
  | { type: "interaction"; interaction: DslInteractionDraft }
  | { type: "beat" };

/** A compiled group: character keys resolved to stable ids (docs §36). */
export interface CompiledEventGroup {
  prelude: StageCue[];
  main: CompiledMainEvent;
}

/** 素材语义校验诊断码（spec §7）。 */
export type AssetDiagnosticCode =
  | "UNKNOWN_BACKGROUND"
  | "UNKNOWN_BGM"
  | "UNKNOWN_SOUND_EFFECT"
  | "UNKNOWN_SPRITE_VARIANT"
  | "FORBIDDEN_SPRITE_SET"
  | "FORBIDDEN_DISPLAY_NAME"
  | "REDUNDANT_STAGE_CUE";

/**
 * One dropped-cue diagnostic: which asset kind was unknown and the id
 * the model referenced (spec §7). Recorded by the compiler when an
 * optional catalog is supplied; the cue is dropped (keep current state).
 */
export interface AssetDiagnostic {
  code: AssetDiagnosticCode;
  id: string;
}

export interface CompileEventGroupsOptions {
  registry: CharacterRegistry;
  /**
   * Visual state after everything committed BEFORE this segment — the
   * "tail state" the next generation must see (docs §54–§55).
   */
  tailState: VisualState;
  /** Pure reducer from presentation/reducer.ts (defaults injected). */
  reduce: VisualStateReducer;
  /** Character presentation defaults (usually derived from the registry). */
  defaultsFor: (characterId: string) => CharacterPresentationState | undefined;
  /**
   * Optional asset catalog enabling semantic validation of prelude cues
   * (spec §7). When present, cues referencing unknown asset ids / sprite
   * variants are dropped (graceful degradation) instead of played; when
   * absent, cues pass through verbatim (backward compatible).
   */
  catalog?: AssetCatalog;
  /**
   * Optional collector for dropped-cue diagnostics (spec §7). Only
   * populated when `catalog` is supplied.
   */
  diagnostics?: AssetDiagnostic[];
}

export interface CompileEventGroupsResult {
  groups: CompiledEventGroup[];
  /** Visual state after all groups applied — the new tail state. */
  tailState: VisualState;
}

// ---------------------------------------------------------------------------
// v2 compiler（C4，计划 §4.2/§4.3）
// ---------------------------------------------------------------------------

/**
 * v2 语义诊断码（一字不改，计划 §4.3）：未知角色、玩家代言、未知 look、
 * 非法参数、越权 cast、无立绘误用 @ch、名牌文本非法。
 */
export type DslSemanticDiagnosticCode =
  | "UNKNOWN_CHARACTER_ID"
  | "PLAYER_SPEECH_FORBIDDEN"
  | "CHARACTER_NOT_ALLOWED"
  | "UNKNOWN_LOOK"
  | "INVALID_CH_PARAMETER"
  | "INVALID_DISPLAY_LABEL"
  | "CHARACTER_HAS_NO_PRESENTATION";

/**
 * 一条结构化诊断（§4.3）：任务、attempt、行号、错误码、有界合法值列表。
 * 不含整套敏感人物卡；不降级成旁白、不剥字符猜 ID。
 */
export interface DslDiagnosticV2 {
  code: DslErrorCode;
  /** 人类可读主讯（同时是修复指令的正文）。 */
  message: string;
  /** 出错行在整段中的 1 基行号（含 lineOffset）。 */
  line: number;
  /** 任务类型（诊断出处，§4.3 要求携带任务）。 */
  task?: string;
  /** attempt 标识（如 "attempt:0"；修复轮为 "attempt:1"）。 */
  attempt?: string;
  /** 违规值（未知 ID、非法 look 等）。 */
  value?: string;
  /** 相关合法值的有界列表。 */
  legalValues?: readonly string[];
}

/** v2 编译后的名牌操作：与 cue、主事件同组原子提交（§4.3）。 */
export type CompiledLabelOpV2 =
  | { characterId: string; label: string }
  | { characterId: string; resetToInitial: true };

/**
 * v2 编译后主事件：对白带机器 characterId + 发射时刻名牌快照
 * displayLabel（C2 严格事件形状：不含旧 speaker 字段）。
 */
export type CompiledMainEventV2 =
  | { type: "dialogue"; characterId: string; displayLabel: string; text: string }
  | { type: "narration"; text: string }
  | { type: "interaction"; interaction: DslInteractionDraft }
  | { type: "beat" };

/** v2 编译后的组：前奏只含 presentation cue（名牌操作在 labelOps）。 */
export interface CompiledEventGroupV2 {
  prelude: StageCue[];
  labelOps: CompiledLabelOpV2[];
  main: CompiledMainEventV2;
  source?: DslSourceLocation;
}

/** 段级哨兵/结局状态（v2 与 v1 同一收尾协议）。 */
export interface DslSegmentResultV2 {
  groups: CompiledEventGroupV2[];
  status: SegmentEndStatus;
}
