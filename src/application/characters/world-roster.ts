/**
 * world-roster（M1）——world draft / canon 角色与 C2 roster 的互转与校验。
 *
 * 职责：
 * - 创建前校验（重复 ID、非法 ID、玩家数、非法 spriteBinding、动态与
 *   author 角色表冲突、玩家音频画像）以结构化 issues 失败——在任何正式
 *   世界文件落盘之前（WorldGenerator 调用），或装配期（bootstrap 调用）。
 * - canon 保存 `control/initialLabel` 权威元信息；roster 从当前游戏 canon
 *   构建（生成世界），不从全局素材目录或文本猜测身份。
 * - 动态世界是独立身份命名空间：不自动合并 fallback 角色；与 author
 *   角色表同键覆盖属于「意图不明」，直接报错，禁止 last-wins。
 *
 * 纯模块：无 I/O、无 LLM。声音设计留在 voice-design store（按 ID join），
 * 本模块不复制第三份人物表。
 */

import type { AssetCatalog } from "../../core/assets/types.js";
import { buildCharacterRoster } from "../../core/characters/registry.js";
import type {
  CharacterControl,
  CharacterDefinition,
  CharacterId,
  CharacterRoster,
} from "../../core/characters/types.js";
import {
  isDangerousKey,
  isValidCharacterId,
  validateCharacterText,
} from "../../core/characters/types.js";
import type {
  CanonCharacter,
  CanonSnapshot,
} from "../../core/ports/canon-store-port.js";
import type {
  CharacterVoiceDesign,
  WorldDraft,
} from "../outline/outline-writer.js";

// ---------------------------------------------------------------------------
// 结构化问题
// ---------------------------------------------------------------------------

export type WorldCharacterIssueCode =
  | "invalid_character_id"
  | "dangerous_key"
  | "duplicate_character_id"
  | "missing_control"
  | "invalid_control"
  | "player_count"
  | "unknown_sprite_binding"
  | "dynamic_author_conflict"
  | "player_voice_design"
  | "invalid_name"
  | "invalid_label";

export interface WorldCharacterIssue {
  code: WorldCharacterIssueCode;
  /** 问题定位，如 `characters[guest_01].spriteBinding`。 */
  path: string;
  message: string;
}

/** 世界角色集校验失败：issues 携带全部结构化问题（不抛裸字符串）。 */
export class WorldCharacterSetError extends Error {
  readonly issues: readonly WorldCharacterIssue[];

  constructor(issues: readonly WorldCharacterIssue[], context: string) {
    super(
      `世界角色集校验失败（${context}，${issues.length} 个问题）：${issues
        .map((issue) => `${issue.code}@${issue.path} — ${issue.message}`)
        .join("；")}`,
    );
    this.name = "WorldCharacterSetError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// 可校验的字符形状（DraftCharacter 与 CanonCharacter 的公共超集）
// ---------------------------------------------------------------------------

/** world draft / canon 角色的公共形状；control 为 M1 权威元信息。 */
export interface WorldCharacterLike {
  id: string;
  name: string;
  description: string;
  control?: CharacterControl;
  /** 初始名牌；缺省回落 name（确定性缺省，不猜测姓名）。 */
  initialLabel?: string;
  /** 复用 author 素材集（资源引用，不是身份合并）。 */
  spriteBinding?: string;
  /** 编剧音频画像（玩家控制角色不允许）。 */
  voice?: CharacterVoiceDesign;
}

function idIssues(character: WorldCharacterLike): WorldCharacterIssue[] {
  const issues: WorldCharacterIssue[] = [];
  const at = (field: string): string => `characters[${character.id || "?"}].${field}`;
  if (typeof character.id !== "string" || !isValidCharacterId(character.id)) {
    issues.push({
      code:
        typeof character.id === "string" && isDangerousKey(character.id)
          ? "dangerous_key"
          : "invalid_character_id",
      path: at("id"),
      message: `角色 ID 非法：${JSON.stringify(character.id)}（/^[A-Za-z][A-Za-z0-9_-]{0,63}$/，拒绝空白/冒号/括号/危险键）`,
    });
    return issues;
  }
  const nameIssue = validateCharacterText(character.name, "invalid_name", at("name"));
  if (nameIssue !== null) issues.push({ ...nameIssue, code: "invalid_name" });
  if (character.initialLabel !== undefined) {
    const labelIssue = validateCharacterText(
      character.initialLabel,
      "invalid_label",
      at("initialLabel"),
    );
    if (labelIssue !== null) issues.push({ ...labelIssue, code: "invalid_label" });
  }
  return issues;
}

/**
 * 世界角色集校验（创建前/装配期共用）。返回结构化问题列表；空列表即合法。
 *
 * - control 必填、恰好一名玩家（M1 起世界角色显式声明控制权；旧世界 canon
 *   是否进入本校验由调用方经 `isRosterCapableCanon` 先行判定——legacy 世界
 *   不猜测、不校验）。
 * - 玩家控制角色不允许音频画像（模型不代玩家发声，玩家话语由运行时创建）。
 * - `assets` 提供时校验 spriteBinding 引用的素材集真实存在（素材引用合法，
 *   缺素材集 = 非法绑定）。
 * - `authorCharacterIds` 提供时，动态角色 ID 与 author 角色表冲突直接报错
 *   （意图不明的同键覆盖，禁止 last-wins）。
 */
export function validateWorldCharacters(input: {
  characters: readonly WorldCharacterLike[];
  /** 问题定位前缀（draft / canon 侧诊断可区分）。 */
  source: "draft" | "canon";
  assets?: AssetCatalog;
  authorCharacterIds?: readonly string[];
}): readonly WorldCharacterIssue[] {
  const issues: WorldCharacterIssue[] = [];

  const seen = new Map<CharacterId, number>();
  input.characters.forEach((character) => {
    issues.push(...idIssues(character));
    const count = seen.get(character.id) ?? 0;
    seen.set(character.id, count + 1);
    if (count === 1) {
      issues.push({
        code: "duplicate_character_id",
        path: `characters[${character.id}]`,
        message: `角色 ID 重复注册：${character.id}（姓名可重复，ID 不可）`,
      });
    }

    const at = (field: string): string => `characters[${character.id || "?"}].${field}`;
    if (character.control === undefined) {
      issues.push({
        code: "missing_control",
        path: at("control"),
        message: `角色 ${character.id} 缺少控制类型元信息（M1 起世界角色必须显式 player/npc；旧世界 canon 需显式升级，不凭「主角」文案猜测）`,
      });
    } else if (character.control !== "player" && character.control !== "npc") {
      issues.push({
        code: "invalid_control",
        path: at("control"),
        message: `控制类型必须是 player 或 npc（实际 ${String(character.control)}）`,
      });
    }

    if (character.control === "player" && character.voice !== undefined) {
      issues.push({
        code: "player_voice_design",
        path: at("voice"),
        message: `玩家控制角色 ${character.id} 不允许音频画像：模型不代玩家发声，玩家话语由运行时创建`,
      });
    }

    if (
      input.assets !== undefined &&
      typeof character.spriteBinding === "string" &&
      character.spriteBinding !== ""
    ) {
      const setKnown = Object.hasOwn(input.assets.spriteSets, character.spriteBinding);
      // 引用 author 素材集合法（具体变体由 DSL 按场景指定）；集不存在 = 非法绑定。
      if (!setKnown) {
        issues.push({
          code: "unknown_sprite_binding",
          path: at("spriteBinding"),
          message: `素材集中不存在 ${character.spriteBinding}（引用 author 素材合法，但绑定必须指向真实存在的 sprite set）`,
        });
      }
    }
  });

  const players = input.characters.filter((c) => c.control === "player");
  if (players.length !== 1) {
    issues.push({
      code: "player_count",
      path: "characters",
      message: `世界必须恰好声明一名玩家控制角色（实际 ${players.length} 名：${
        players.map((p) => p.id).join(", ") || "无"
      }）；控制权不由「主角」文案或演员临时决定`,
    });
  }

  if (input.authorCharacterIds !== undefined && input.authorCharacterIds.length > 0) {
    const authorIds = new Set(input.authorCharacterIds);
    for (const character of input.characters) {
      if (authorIds.has(character.id)) {
        issues.push({
          code: "dynamic_author_conflict",
          path: `characters[${character.id}]`,
          message: `动态角色 ID ${character.id} 与 author 角色表冲突：动态世界是独立身份命名空间，author 素材/profile 可被引用但身份不可同键覆盖（禁止 last-wins）`,
        });
      }
    }
  }

  return issues;
}

function assertValidOrThrow(
  characters: readonly WorldCharacterLike[],
  context: string,
  options?: { assets?: AssetCatalog; authorCharacterIds?: readonly string[] },
): void {
  const issues = validateWorldCharacters({
    characters,
    source: "draft",
    ...(options?.assets !== undefined ? { assets: options.assets } : {}),
    ...(options?.authorCharacterIds !== undefined
      ? { authorCharacterIds: options.authorCharacterIds }
      : {}),
  });
  if (issues.length > 0) throw new WorldCharacterSetError(issues, context);
}

// ---------------------------------------------------------------------------
// draft → canon（世界生成的权威元信息落盘形状）
// ---------------------------------------------------------------------------

/** world draft 角色 → canon 角色（control/initialLabel 权威元信息必写）。 */
export function canonCharactersFromDraft(
  draft: WorldDraft,
  options?: { assets?: AssetCatalog; authorCharacterIds?: readonly string[] },
): CanonCharacter[] {
  assertValidOrThrow(draft.characters, "canonCharactersFromDraft", options);
  return draft.characters.map((character) => ({
    id: character.id,
    name: character.name,
    description: character.description,
    control: character.control,
    initialLabel: character.initialLabel ?? character.name,
    ...(character.spriteBinding !== undefined
      ? { spriteBinding: character.spriteBinding }
      : {}),
  }));
}

// ---------------------------------------------------------------------------
// canon → roster（生成世界的 registry 真源）
// ---------------------------------------------------------------------------

/**
 * canon 是否携带 M1 角色元信息（v2 世界）。旧世界 canon（无 control）由
 * 调用方走 legacy 兼容边界，不在此猜测。
 */
export function isRosterCapableCanon(canon: Pick<CanonSnapshot, "characters">): boolean {
  return canon.characters.some((character) => character.control !== undefined);
}

/**
 * 从当前游戏 canon 构建 roster：身份、控制类型、初始名牌与人设真源；
 * presentation 不在 canon 中（动态角色可无立绘，素材引用留在 canon 元数据，
 * `assets` 提供时对引用做防御性复检）。校验失败抛
 * `WorldCharacterSetError`（结构化 issues）。
 */
export function rosterFromCanonCharacters(input: {
  scopeId: string;
  characters: readonly CanonCharacter[];
  assets?: AssetCatalog;
}): CharacterRoster {
  const issues = validateWorldCharacters({
    characters: input.characters,
    source: "canon",
    ...(input.assets !== undefined ? { assets: input.assets } : {}),
  });
  if (issues.length > 0) {
    throw new WorldCharacterSetError(issues, `rosterFromCanonCharacters(${input.scopeId})`);
  }

  const definitions: CharacterDefinition[] = input.characters.map((character) => ({
    id: character.id,
    name: character.name,
    control: character.control ?? "npc",
    initialLabel: character.initialLabel ?? character.name,
    persona: character.description,
  }));
  const players = definitions.filter((definition) => definition.control === "player");
  return buildCharacterRoster({
    schemaVersion: 2,
    scopeId: input.scopeId,
    playerId: players[0]?.id ?? "",
    characters: definitions,
  });
}

/** roster 的已知角色 ID 集（reconcile 幻影过滤与导演 cast 的数据源）。 */
export function rosterCharacterIds(roster: CharacterRoster): ReadonlySet<CharacterId> {
  return new Set(roster.characters.map((definition) => definition.id));
}

/** canon roster 的稳定 revision（派生人物卡的来源校验指纹）。 */
export function canonRosterRevision(input: {
  scopeId: string;
  characters: readonly CanonCharacter[];
  assets?: AssetCatalog;
}): string {
  return rosterFromCanonCharacters(input).revision;
}
