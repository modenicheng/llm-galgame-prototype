/**
 * 角色领域类型与文本校验（C2 §3.1 单一真源及命名规则）。
 *
 * 身份的真源是 `CharacterRoster`：不可变、版本化，每局绑定一份。本模块
 * 只放纯类型、纯校验与名牌运行时状态——不碰 DOM、文件系统或 LLM。
 *
 * 与 legacy 的关系：`core/presentation/types.ts` 的 scriptName 注册表是
 * 兼容边界（C2 起冻结，不再扩张）；新内容格式与核心 API 一律使用本模块
 * 的 `CharacterId`，不再从“有哪些立绘”推导“有哪些人”。
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 基础标量
// ---------------------------------------------------------------------------

/**
 * 稳定角色 ID。入口统一校验；核心不自行小写化或截断。既有 ID（如校园的
 * `female_A`）原样保留，区分大小写。
 */
export type CharacterId = string;

/** ID 机器键格式：字母开头，字母/数字/`_`/`-`，最长 64。 */
export const CHARACTER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** 对象原型危险键：任何以 ID/字典键出现的场合一律拒绝。 */
export const DANGEROUS_ID_KEYS: readonly string[] = [
  "__proto__",
  "prototype",
  "constructor",
];

/** 玩家控制类型：预留的是控制类型，不要求所有分支共用同一字面量 ID。 */
export type CharacterControl = "player" | "npc";

export function isDangerousKey(key: string): boolean {
  return DANGEROUS_ID_KEYS.includes(key);
}

/** 机器键校验（ID 与 look 键共用）：格式 + 危险键，拒绝空白/冒号/括号。 */
export function isValidCharacterKey(key: string): boolean {
  return CHARACTER_ID_PATTERN.test(key) && !isDangerousKey(key);
}

/** 角色稳定 ID 校验（`isValidCharacterKey` 的语义化别名）。 */
export function isValidCharacterId(id: string): boolean {
  return isValidCharacterKey(id);
}

// ---------------------------------------------------------------------------
// 结构化校验问题（命名错误码，供注册表/兼容边界诊断）
// ---------------------------------------------------------------------------

export type CharacterIssueCode =
  | "invalid_schema_version"
  | "invalid_scope_id"
  | "invalid_character_id"
  | "dangerous_key"
  | "invalid_name"
  | "invalid_label"
  | "invalid_persona"
  | "invalid_control"
  | "duplicate_character_id"
  | "player_count"
  | "unknown_player_id"
  | "player_id_mismatch"
  | "invalid_default_look"
  | "unknown_sprite_set"
  | "unknown_sprite_variant"
  | "revision_mismatch";

export interface CharacterValidationIssue {
  code: CharacterIssueCode;
  /** 问题定位，如 `characters[female_A].presentation.looks[smile]`。 */
  path: string;
  message: string;
}

/** 姓名/名牌文本非法（抛出方携带违规文本与命名错误码）。 */
export class CharacterTextError extends Error {
  readonly code: CharacterIssueCode;
  readonly value: string;

  constructor(code: CharacterIssueCode, value: string, message: string) {
    super(message);
    this.name = "CharacterTextError";
    this.code = code;
    this.value = value;
  }
}

// ---------------------------------------------------------------------------
// Unicode 文本规则（姓名与名牌共用）
// ---------------------------------------------------------------------------

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
export const CHARACTER_TEXT_MAX_CODE_POINTS = 64;

function countCodePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * 姓名/名牌校验：trim 后 1–64 个 Unicode 码点；拒绝换行与控制字符（含
 * 字符串内部）；不强制汉字。返回结构化问题或 null。
 */
export function validateCharacterText(
  text: string,
  code: Extract<CharacterIssueCode, "invalid_name" | "invalid_label">,
  path: string,
): CharacterValidationIssue | null {
  if (CONTROL_CHARACTER_PATTERN.test(text)) {
    return {
      code,
      path,
      message: `${path}: 含控制字符（换行/制表/控制符不允许出现在姓名或名牌中）`,
    };
  }
  const trimmed = text.trim();
  const codePoints = countCodePoints(trimmed);
  if (codePoints < 1 || codePoints > CHARACTER_TEXT_MAX_CODE_POINTS) {
    return {
      code,
      path,
      message: `${path}: trim 后须为 1–${CHARACTER_TEXT_MAX_CODE_POINTS} 个 Unicode 码点（实际 ${codePoints}）`,
    };
  }
  return null;
}

/** zod 版名牌/姓名规则（校验不转换：首尾空白合法，输出保持原样）。 */
const characterTextSchema = z
  .string()
  .refine((text) => !CONTROL_CHARACTER_PATTERN.test(text), {
    message: "姓名/名牌不允许包含控制字符（换行、制表符等）",
  })
  .refine((text) => {
    const codePoints = countCodePoints(text.trim());
    return codePoints >= 1 && codePoints <= CHARACTER_TEXT_MAX_CODE_POINTS;
  }, {
    message: `姓名/名牌 trim 后须为 1–${CHARACTER_TEXT_MAX_CODE_POINTS} 个 Unicode 码点`,
  });

/** 名牌 zod schema（displayLabel 等展示文本）。 */
export const CharacterLabelSchema = characterTextSchema;
/** 正式姓名 zod schema（不作为机器键）。 */
export const CharacterNameSchema = characterTextSchema;

/** 稳定 ID zod schema：格式 + 危险键（显示名不是机器键）。 */
export const CharacterIdSchema = z
  .string()
  .refine((id) => CHARACTER_ID_PATTERN.test(id), {
    message: "角色 ID 须匹配 /^[A-Za-z][A-Za-z0-9_-]{0,63}$/（区分大小写，禁止空白/冒号/括号）",
  })
  .refine((id) => !isDangerousKey(id), {
    message: `角色 ID 不允许使用对象原型危险键：${DANGEROUS_ID_KEYS.join("/")} `,
  });

// ---------------------------------------------------------------------------
// 领域类型（C2 §3.1 目标模型，字段名与约束以计划为准）
// ---------------------------------------------------------------------------

export interface CharacterDefinition {
  id: CharacterId;
  /** 正式姓名/作者姓名，可重复，不作为机器键。 */
  name: string;
  control: CharacterControl;
  /** 初始名牌；可以是“神秘女子”。 */
  initialLabel: string;
  /** 持久人设；投影时按知情权限裁剪。 */
  persona: string;
  presentation?: {
    /** 缺省 look；必须是 looks 清单内的键。 */
    defaultLook: string;
    defaultPosition: "far_left" | "left" | "center" | "right" | "far_right";
    /** 角色局部外观键，例如 smile -> { spriteSet, variant }；换装是另一个 look。 */
    looks: Record<string, { spriteSet: string; variant: string }>;
  };
  /** 音色 profile 绑定；无音色角色合法（缺资源不丢失身份）。 */
  voiceProfileId?: string;
}

export interface CharacterRoster {
  schemaVersion: 2;
  /** 内容包版本/游戏世界，不是 displayName。 */
  scopeId: string;
  /** 对规范化定义及绑定计算的稳定摘要（无时间戳、无绝对路径）。 */
  revision: string;
  playerId: CharacterId;
  characters: readonly CharacterDefinition[];
}

export interface CharacterRegistry {
  readonly roster: CharacterRoster;
  get(id: CharacterId): CharacterDefinition | undefined;
  require(id: CharacterId): CharacterDefinition;
}

export interface CastContext {
  /** 本次允许模型发声的 NPC（空集合就是不能输出 NPC 台词）。 */
  allowedSpeakerIds: readonly CharacterId[];
  /** 叙事参与者，允许电话/画外角色；不从立绘推导。 */
  sceneParticipantIds: readonly CharacterId[];
}

// ---------------------------------------------------------------------------
// CharacterDefinition zod schema（跨字段：defaultLook ∈ looks；look 键安全）
// ---------------------------------------------------------------------------

const CharacterLookSchema = z.object({
  spriteSet: z.string().min(1),
  variant: z.string().min(1),
});

const safeRecordKey = z.string().refine((key) => isValidCharacterKey(key), {
  message: "外观键/字典键不允许使用对象原型危险键或非法字符",
});

/**
 * 原型链安全记录 schema。zod v4 的 `z.record` 不会把自有 `__proto__`
 * 数据键（如 `JSON.parse('{"__proto__":…}')` 的产物）交给键 schema
 * 校验，而是静默丢弃——键校验形同虚设。先用 preprocess 在原始输入上
 * 拒绝危险键（`__proto__`/`prototype`/`constructor`），再交给
 * `z.record` 做键/值校验；两道检查叠加，不留静默丢键路径。
 */
function safeRecord<K extends z.ZodType<string>, V extends z.ZodType>(
  keySchema: K,
  valueSchema: V,
) {
  return z.preprocess((input, ctx) => {
    if (typeof input === "object" && input !== null) {
      for (const key of Object.keys(input)) {
        if (isDangerousKey(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `字典键不允许使用对象原型危险键：${JSON.stringify(key)}`,
          });
        }
      }
    }
    return input;
  }, z.record(keySchema, valueSchema));
}

export const CharacterDefinitionSchema = z
  .object({
    id: CharacterIdSchema,
    name: CharacterNameSchema,
    control: z.enum(["player", "npc"]),
    initialLabel: CharacterLabelSchema,
    persona: z.string().refine((text) => text.trim().length > 0, {
      message: "人设不允许为空",
    }),
    presentation: z.exactOptional(
      z.object({
        defaultLook: z.string().min(1),
        defaultPosition: z.enum(["far_left", "left", "center", "right", "far_right"]),
        looks: safeRecord(safeRecordKey, CharacterLookSchema),
      }),
    ),
    voiceProfileId: z.exactOptional(z.string().min(1)),
  })
  .superRefine((definition, ctx) => {
    const presentation = definition.presentation;
    if (presentation === undefined) return;
    const looks = presentation.looks as Record<string, unknown>;
    if (!Object.hasOwn(looks, presentation.defaultLook)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["presentation", "defaultLook"],
        message: `缺省 look 必须是 looks 清单内的键（缺省 ${presentation.defaultLook} 未注册）`,
      });
    }
  });

export const CharacterRuntimeStateSchema = z.object({
  // 记录键 = 角色 ID：safeRecord（危险键预处理）+ safeRecordKey（格式 +
  // 危险键），与 withCharacterLabel 的守卫及 DANGEROUS_ID_KEYS 不变量
  // 一致——本 schema 是 F3/M3 信任的解析/持久化面，不得放行
  // constructor/__proto__ 等键，也不得静默丢弃后放行。
  labels: safeRecord(safeRecordKey, CharacterLabelSchema),
});

// ---------------------------------------------------------------------------
// 名牌运行时状态
// ---------------------------------------------------------------------------

/**
 * 局内名牌状态。与 VisualState 分域存放：隐藏、离场（`@ch exit`）只清
 * 立绘，不清空名牌；无立绘角色同样可改名。缺省名牌用 initialLabel。
 */
export interface CharacterRuntimeState {
  labels: Record<CharacterId, string>;
}

/** 创建空名牌状态；labels 为无原型对象，成员检查不走原型链。 */
export function createCharacterRuntimeState(): CharacterRuntimeState {
  return { labels: Object.create(null) as Record<CharacterId, string> };
}

function assertLabelAssignable(characterId: CharacterId, label: string): void {
  if (!isValidCharacterKey(characterId)) {
    throw new CharacterTextError(
      "dangerous_key",
      characterId,
      `名牌键必须是合法角色 ID（拒绝 ${characterId}）`,
    );
  }
  const issue = validateCharacterText(label, "invalid_label", `labels[${characterId}]`);
  if (issue !== null) {
    throw new CharacterTextError(issue.code, label, issue.message);
  }
}

/** 纯函数：返回设置了 `characterId → label` 的新状态（不修改原状态）。 */
export function withCharacterLabel(
  state: CharacterRuntimeState,
  characterId: CharacterId,
  label: string,
): CharacterRuntimeState {
  assertLabelAssignable(characterId, label);
  const labels = Object.create(null) as Record<CharacterId, string>;
  for (const key of Object.keys(state.labels)) {
    if (Object.hasOwn(state.labels, key)) {
      labels[key] = state.labels[key]!;
    }
  }
  labels[characterId] = label;
  return { labels };
}

/** 解析当前名牌：已设置且为自有属性 → label；否则 initialLabel。 */
export function resolveCharacterLabel(
  state: CharacterRuntimeState | undefined,
  definition: Pick<CharacterDefinition, "id" | "initialLabel">,
): string {
  const labels = state?.labels;
  if (labels !== undefined && Object.hasOwn(labels, definition.id)) {
    return labels[definition.id]!;
  }
  return definition.initialLabel;
}
