/**
 * CharacterRegistry 构造：唯一性、玩家控制、资源绑定与稳定 revision
 * （C2 §3.1/§3.2）。
 *
 * 新注册表不从“有哪些立绘”推导“有哪些人”：无 art 的 NPC 可以说话、进
 * 记忆；需要路人时由内容包/世界生成先注册无素材 NPC。两角色可共享素材
 * 或音色，但身份不合并。
 *
 * 端口（bootstrap 接线）：`CharacterRegistryProvider` 以显式 legacy 模式
 * 为缺省——roster 由 F1/M1 的 characters.yaml 加载器提供之前，运行时
 * 身份仍走资产目录 legacy 注册表（兼容边界）。
 */
import type { AssetCatalog } from "../assets/types.js";
import { hasSpriteVariant } from "../assets/catalog.js";
import type {
  CharacterDefinition,
  CharacterId,
  CharacterRegistry,
  CharacterRoster,
  CharacterValidationIssue,
} from "./types.js";
import { isDangerousKey, isValidCharacterKey, validateCharacterText } from "./types.js";

// ---------------------------------------------------------------------------
// 命名错误
// ---------------------------------------------------------------------------

/** roster 校验失败：issues 携带全部结构化问题（不抛裸字符串）。 */
export class CharacterRosterError extends Error {
  readonly issues: readonly CharacterValidationIssue[];

  constructor(issues: readonly CharacterValidationIssue[]) {
    super(
      `CharacterRoster 校验失败（${issues.length} 个问题）：${issues
        .map((issue) => `${issue.code}@${issue.path} — ${issue.message}`)
        .join("；")}`,
    );
    this.name = "CharacterRosterError";
    this.issues = issues;
  }
}

/** require 未注册 ID：不许静默新建身份，也不许把未知说话人变成新角色。 */
export class UnknownCharacterError extends Error {
  readonly characterId: CharacterId;
  readonly scopeId: string;

  constructor(characterId: CharacterId, scopeId: string) {
    super(`角色 ${characterId} 未注册（scopeId=${scopeId}）`);
    this.name = "UnknownCharacterError";
    this.characterId = characterId;
    this.scopeId = scopeId;
  }
}

// ---------------------------------------------------------------------------
// 稳定 revision
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32 位：确定性纯哈希（无 Node crypto、跨进程稳定），摘要用双通道
 * 拼接降低碰撞面。摘要只覆盖规范化投影——不含时间戳、绝对路径。
 */
function fnv1a32(input: string, offsetBasis: number): number {
  let hash = offsetBasis >>> 0;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hex32(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/** 角色规范化投影：固定键序、looks 按键排序、无时间戳/路径成分。 */
function canonicalCharacter(definition: CharacterDefinition): string {
  const presentation = definition.presentation;
  const looks: string[] = [];
  if (presentation !== undefined) {
    for (const key of Object.keys(presentation.looks)) {
      if (!Object.hasOwn(presentation.looks, key)) continue;
      const look = presentation.looks[key];
      if (look === undefined) continue;
      looks.push(JSON.stringify([key, look.spriteSet, look.variant]));
    }
    looks.sort();
  }
  return JSON.stringify({
    id: definition.id,
    name: definition.name,
    control: definition.control,
    initialLabel: definition.initialLabel,
    persona: definition.persona,
    ...(presentation !== undefined
      ? {
          presentation: {
            defaultLook: presentation.defaultLook,
            defaultPosition: presentation.defaultPosition,
            looks,
          },
        }
      : {}),
    ...(definition.voiceProfileId !== undefined
      ? { voiceProfileId: definition.voiceProfileId }
      : {}),
  });
}

/** roster 规范化投影：角色按规范化串排序 → 对键序/列表序稳定。 */
function canonicalRoster(draft: Omit<CharacterRoster, "revision">): string {
  const characters = draft.characters
    .map((definition) => canonicalCharacter(definition))
    .sort();
  return JSON.stringify({
    schemaVersion: draft.schemaVersion,
    scopeId: draft.scopeId,
    playerId: draft.playerId,
    characters,
  });
}

/**
 * 计算稳定 revision：对键排序稳定；对姓名、控制类型、名牌、人设、look
 * 绑定、voiceProfile 绑定、scopeId 与 playerId 变化敏感。
 */
export function computeRosterRevision(draft: Omit<CharacterRoster, "revision">): string {
  const canonical = canonicalRoster(draft);
  const reversed = [...canonical].reverse().join("");
  return `v2-${hex32(fnv1a32(canonical, 0x811c9dc5))}${hex32(
    fnv1a32(reversed, 0x9dc5811c),
  )}`;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function characterIssues(definition: CharacterDefinition): CharacterValidationIssue[] {
  const issues: CharacterValidationIssue[] = [];
  const at = (field: string): string => `characters[${definition.id || "?"}].${field}`;

  if (!isValidCharacterKey(definition.id)) {
    issues.push({
      code: isDangerousKey(definition.id) ? "dangerous_key" : "invalid_character_id",
      path: at("id"),
      message: `角色 ID 非法：${JSON.stringify(definition.id)}（/^[A-Za-z][A-Za-z0-9_-]{0,63}$/，区分大小写，拒绝空白/冒号/括号/危险键）`,
    });
  }
  const nameIssue = validateCharacterText(definition.name, "invalid_name", at("name"));
  if (nameIssue !== null) issues.push(nameIssue);
  const labelIssue = validateCharacterText(
    definition.initialLabel,
    "invalid_label",
    at("initialLabel"),
  );
  if (labelIssue !== null) issues.push(labelIssue);
  if (typeof definition.persona !== "string" || definition.persona.trim().length === 0) {
    issues.push({
      code: "invalid_persona",
      path: at("persona"),
      message: `${at("persona")}: 人设不允许为空`,
    });
  }
  if (definition.control !== "player" && definition.control !== "npc") {
    issues.push({
      code: "invalid_control",
      path: at("control"),
      message: `${at("control")}: 控制类型必须是 player 或 npc（实际 ${String(definition.control)}）`,
    });
  }

  const presentation = definition.presentation;
  if (presentation !== undefined) {
    for (const key of Object.keys(presentation.looks)) {
      if (!Object.hasOwn(presentation.looks, key)) continue;
      if (!isValidCharacterKey(key)) {
        issues.push({
          code: isDangerousKey(key) ? "dangerous_key" : "invalid_character_id",
          path: `${at("presentation")}.looks[${key}]`,
          message: `外观键非法：${JSON.stringify(key)}`,
        });
      }
    }
    if (!Object.hasOwn(presentation.looks, presentation.defaultLook)) {
      issues.push({
        code: "invalid_default_look",
        path: `${at("presentation")}.defaultLook`,
        message: `缺省 look ${JSON.stringify(presentation.defaultLook)} 不在 looks 清单内`,
      });
    }
  }
  return issues;
}

/** roster 级校验（不含资源绑定与 revision 完整性）。 */
function validateRosterShape(
  draft: Omit<CharacterRoster, "revision">,
): CharacterValidationIssue[] {
  const issues: CharacterValidationIssue[] = [];

  if (draft.schemaVersion !== 2) {
    issues.push({
      code: "invalid_schema_version",
      path: "schemaVersion",
      message: `schemaVersion 必须是 2（实际 ${String(draft.schemaVersion)}）`,
    });
  }
  if (typeof draft.scopeId !== "string" || draft.scopeId.trim().length === 0) {
    issues.push({
      code: "invalid_scope_id",
      path: "scopeId",
      message: "scopeId 必须是非空字符串（内容包版本/游戏世界）",
    });
  }

  const seen = new Map<CharacterId, number>();
  draft.characters.forEach((definition) => {
    issues.push(...characterIssues(definition));
    const count = seen.get(definition.id) ?? 0;
    seen.set(definition.id, count + 1);
    if (count === 1) {
      issues.push({
        code: "duplicate_character_id",
        path: `characters[${definition.id}]`,
        message: `角色 ID 重复注册：${definition.id}（姓名可重复，ID 不可）`,
      });
    }
  });

  const players = draft.characters.filter(
    (definition) => definition.control === "player",
  );
  if (players.length !== 1) {
    issues.push({
      code: "player_count",
      path: "characters",
      message: `恰好需要一个玩家控制角色（实际 ${players.length} 个：${players
        .map((player) => player.id)
        .join(", ") || "无"}）`,
    });
  }
  const declared = draft.characters.find(
    (definition) => definition.id === draft.playerId,
  );
  if (declared === undefined) {
    issues.push({
      code: "unknown_player_id",
      path: "playerId",
      message: `playerId 指向未注册的 ID：${draft.playerId}`,
    });
  } else if (declared.control !== "player") {
    issues.push({
      code: "player_id_mismatch",
      path: "playerId",
      message: `playerId 必须指向玩家控制角色（${draft.playerId} 是 ${declared.control}）`,
    });
  }

  return issues;
}

/** 资源绑定校验：looks → spriteSet/variant 必须真实存在于素材目录。 */
function validateAssetBindings(
  draft: Omit<CharacterRoster, "revision">,
  assets: AssetCatalog,
): CharacterValidationIssue[] {
  const issues: CharacterValidationIssue[] = [];
  for (const definition of draft.characters) {
    const presentation = definition.presentation;
    if (presentation === undefined) continue;
    for (const key of Object.keys(presentation.looks)) {
      if (!Object.hasOwn(presentation.looks, key)) continue;
      const look = presentation.looks[key];
      if (look === undefined) continue;
      const path = `characters[${definition.id}].presentation.looks[${key}]`;
      if (!hasSpriteVariant(assets, look.spriteSet, look.variant)) {
        const setKnown = Object.hasOwn(assets.spriteSets, look.spriteSet);
        issues.push({
          code: setKnown ? "unknown_sprite_variant" : "unknown_sprite_set",
          path,
          message: setKnown
            ? `素材集 ${look.spriteSet} 中不存在变体 ${look.variant}（${path}）`
            : `素材集中不存在 ${look.spriteSet}（${path}；成员检查不走原型链）`,
        });
      }
    }
  }
  return issues;
}

/**
 * 全量校验（结构 + 玩家控制 + 资源绑定 + revision 完整性）。返回结构化
 * 问题列表；空列表即合法。
 */
export function validateCharacterRoster(
  roster: CharacterRoster,
  assets: AssetCatalog,
): readonly CharacterValidationIssue[] {
  const { revision, ...draft } = roster;
  const issues: CharacterValidationIssue[] = [
    ...validateRosterShape(draft),
    ...validateAssetBindings(draft, assets),
  ];
  if (revision !== computeRosterRevision(draft)) {
    issues.push({
      code: "revision_mismatch",
      path: "revision",
      message: "revision 与规范化定义计算的摘要不一致（roster 被篡改或手工拼接）",
    });
  }
  return issues;
}

/**
 * 构造合法 roster：跑结构与玩家控制校验并填入稳定 revision。校验失败抛
 * `CharacterRosterError`（issues 结构化）。
 */
export function buildCharacterRoster(
  draft: Omit<CharacterRoster, "revision">,
): CharacterRoster {
  const issues = validateRosterShape(draft);
  if (issues.length > 0) throw new CharacterRosterError(issues);
  return { ...draft, revision: computeRosterRevision(draft) };
}

// ---------------------------------------------------------------------------
// 注册表与端口
// ---------------------------------------------------------------------------

/**
 * 从 roster + 素材目录构造注册表：唯一性、恰好一个玩家、资源绑定与
 * revision 完整性全量校验，失败抛 `CharacterRosterError`。内部字典用
 * Map；成员检查不走原型链。
 */
export function createCharacterRegistry(
  roster: CharacterRoster,
  assets: AssetCatalog,
): CharacterRegistry {
  const issues = validateCharacterRoster(roster, assets);
  if (issues.length > 0) throw new CharacterRosterError(issues);

  const byId = new Map<CharacterId, CharacterDefinition>();
  for (const definition of roster.characters) {
    byId.set(definition.id, definition);
  }

  return {
    roster,
    get(id: CharacterId): CharacterDefinition | undefined {
      return byId.get(id);
    },
    require(id: CharacterId): CharacterDefinition {
      const definition = byId.get(id);
      if (definition === undefined) {
        throw new UnknownCharacterError(id, roster.scopeId);
      }
      return definition;
    },
  };
}

/** registry 获取方式：legacy（资产目录兼容边界）或 roster（C2 真源）。 */
export type CharacterRegistryMode = "legacy" | "roster";

/**
 * bootstrap 接线端口。legacy 模式是 C2 的显式缺省：F1/M1 提供
 * characters.yaml roster 之前，运行时行为保持不变。
 */
export interface CharacterRegistryProvider {
  readonly mode: CharacterRegistryMode;
  /** roster 模式下的注册表；legacy 模式下为 undefined。 */
  readonly registry: CharacterRegistry | undefined;
}
