/**
 * F3 存储侧身份升级层（旧事件 → 新身份信封；自校园线
 * `campus/src/adapters/storage/identity-upcaster.ts` 移植共用——两分支共享
 * 同一存储规范；校园 HEAD 版为移植源）。
 *
 * 分层边界（计划 §F3）：
 * - 只做**兼容读取**：旧边负载事件在内存副本中升级，原 JSONL 字节不变
 *   （回滚读原旧档，新档写在独立的新版本路径）。
 * - 解析优先级恒为：当前作用域内已验证 ID → 明确登记的唯一 legacy alias
 *   （C2 `LegacyIdentityMapping`，scope 与 roster 必须一致）→ unresolved。
 *   未知的旧 ID 不因字符串存在就可信；不做跨世界同名兜底。
 * - 不可解析的台词保持原样（只读可回放），绝不伪装成 narrator、也不强行
 *   归给某个猜测角色；继续生成需要显式补映射或重开。
 * - 迁移结果必须可数（每类计数）可诊断（每条 unresolved 带说明）。
 *
 * 与校园版的差异（移植适配，非语义变更）：main 的会话快照是图快照
 * StateSnapshot（v3→v4 由 `core/graph/snapshot-upcast.ts` 承担），不存在
 * state.json/state.v2.json 双轨——校园版中围绕 RuntimeSnapshot 的字段级
 * 读取器（readVisualState/readSnapshotFields/v2 记录构造等）不适用，未随
 * 本文件移植；事件升级链、诊断类型与错误语义逐字保留。
 *
 * 本模块不含任何具体世界内容：roster 与 legacy 映射一律由调用方注入。
 */
import { z } from "zod";
import type { CharacterId } from "../../core/characters/types.js";
import {
  CharacterDefinitionSchema,
  CharacterIdSchema,
  isValidCharacterId,
} from "../../core/characters/types.js";
import type {
  LegacyIdentityMapping,
  LegacyIdentityResolution,
} from "../../core/characters/legacy-identity.js";
import { createLegacyIdentityResolver } from "../../core/characters/legacy-identity.js";
import type {
  EventMigrationDiagnostics,
  LegacyEventUpcastCategory,
  SnapshotDslProtocolVersion,
  SnapshotIdentityEnvelope,
  SnapshotRosterSnapshot,
} from "../../core/ports/identity-snapshot-port.js";
import {
  SNAPSHOT_IDENTITY_SCHEMA_VERSION,
} from "../../core/ports/identity-snapshot-port.js";
import type { StoredEvent } from "../../schema.js";

// ---------------------------------------------------------------------------
// 错误类型（显式拒绝，不静默误读）
// ---------------------------------------------------------------------------

/**
 * 快照身份格式版本不被本程序支持（"旧程序读到新格式"或"读到未来格式"）。
 * 抛错而非降级解析——静默误读比恢复失败更危险。
 */
export class UnsupportedSnapshotFormatError extends Error {
  constructor(
    message: string,
    readonly foundVersion: number,
    readonly supportedVersion: number,
  ) {
    super(message);
    this.name = "UnsupportedSnapshotFormatError";
  }
}

/** legacy 映射与 roster 作用域不一致：映射不允许跨世界生效。 */
export class IdentityUpcastScopeMismatchError extends Error {
  constructor(
    readonly mappingScopeId: string,
    readonly rosterScopeId: string,
  ) {
    super(
      `legacy 身份映射的 scopeId（${mappingScopeId}）与 roster 作用域（${rosterScopeId}）不一致；` +
        "映射只对同作用域旧数据生效，不做跨世界同名兜底",
    );
    this.name = "IdentityUpcastScopeMismatchError";
  }
}

/** 新格式快照内的身份数据损坏（roster 快照缺失/非法）——身份不可恢复。 */
export class CorruptV2SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptV2SnapshotError";
  }
}

// ---------------------------------------------------------------------------
// 升级上下文
// ---------------------------------------------------------------------------

export interface LegacyUpcastContext {
  /** 当前作用域 roster 快照（升级目标信封也从这里生成）。 */
  roster: SnapshotRosterSnapshot;
  /** 显式登记的旧身份映射；scopeId 必须与 roster.scopeId 一致。 */
  legacyMapping: LegacyIdentityMapping;
}

function assertScopeMatch(context: LegacyUpcastContext): void {
  if (context.legacyMapping.scope.scopeId !== context.roster.scopeId) {
    throw new IdentityUpcastScopeMismatchError(
      context.legacyMapping.scope.scopeId,
      context.roster.scopeId,
    );
  }
}

// ---------------------------------------------------------------------------
// 事件升级（优先级链）
// ---------------------------------------------------------------------------

export interface LegacyEventsUpcastResult {
  /** 升级后的事件序列（新对象仅出现在被升级的对白上；其余原引用透传）。 */
  events: StoredEvent[];
  diagnostics: EventMigrationDiagnostics;
}

function emptyCategoryCounts(): Record<LegacyEventUpcastCategory, number> {
  return {
    identity_verified: 0,
    alias_resolved: 0,
    unresolved_ambiguous: 0,
    unresolved_unknown_id: 0,
    unresolved_unregistered: 0,
    non_model_dialogue_untouched: 0,
  };
}

/**
 * 当前格式读回时的零迁移事件报告：新格式事件不经 legacy 升级链，六类
 * 计数恒 0（totalEvents 记录本次读回的事件规模）。仅在当前格式读回有异常
 * 发现（unresolved 事件、损坏字段等）需要附带 migration 报告时与快照
 * 诊断拼装——干净读回不产生报告（无诊断噪音）。
 */
export function noLegacyEventMigration(totalEvents: number): EventMigrationDiagnostics {
  return {
    totalEvents,
    dialogueEvents: 0,
    byCategory: emptyCategoryCounts(),
    unresolvedRefs: [],
    unresolvedReasons: [],
  };
}

type StoredDialogueEvent = Extract<StoredEvent, { type: "dialogue" }>;

function upcastDialogueCopy(
  event: StoredDialogueEvent,
  characterId: CharacterId,
): StoredEvent {
  // 新版本副本：characterId 补齐，displayLabel 取名牌快照（speaker 保留，
  // 旧程序读同一行 JSONL 仍按旧字段工作）。原对象绝不修改。
  return {
    ...event,
    characterId,
    displayLabel: event.displayLabel ?? event.speaker,
  };
}

function unresolvedCategory(
  ownId: string | undefined,
  resolution: LegacyIdentityResolution,
): LegacyEventUpcastCategory {
  if (resolution.status === "ambiguous") return "unresolved_ambiguous";
  if (ownId !== undefined) return "unresolved_unknown_id";
  return "unresolved_unregistered";
}

/**
 * 旧事件序列 → 新身份信封事件（纯函数，原数组与原对象一律不动）。
 *
 * 对白逐条走优先级链；非模型对白事件（旁白/交互/结局/全部 player_*，
 * 含 player_dialogue）原样透传，计数 non_model_dialogue_untouched。
 * unresolved 的对白**原引用返回**（只读回放），并记录 `event:<seq>` 引用
 * 与诊断说明；绝不改写 speaker、不补 guessed characterId。
 */
export function upcastLegacyEvents(
  events: readonly StoredEvent[],
  context: LegacyUpcastContext,
): LegacyEventsUpcastResult {
  assertScopeMatch(context);
  const resolver = createLegacyIdentityResolver(context.legacyMapping);
  const rosterIds = new Set(context.roster.characters.map((definition) => definition.id));
  const scopeId = context.roster.scopeId;

  const byCategory = emptyCategoryCounts();
  const unresolvedRefs: string[] = [];
  const unresolvedReasons: string[] = [];
  const out: StoredEvent[] = [];
  let dialogueEvents = 0;

  for (const event of events) {
    if (event.type !== "dialogue") {
      byCategory.non_model_dialogue_untouched += 1;
      out.push(event);
      continue;
    }
    dialogueEvents += 1;

    // 1) 当前作用域内已验证 ID：格式合法且在 roster 里才算"已验证"。
    const ownId = event.characterId;
    if (
      typeof ownId === "string" &&
      isValidCharacterId(ownId) &&
      rosterIds.has(ownId)
    ) {
      byCategory.identity_verified += 1;
      out.push(upcastDialogueCopy(event, ownId));
      continue;
    }

    // 2) 明确登记的唯一 legacy alias（ID 缺失或不可信时的唯一兜底）。
    const resolution = resolver.resolveScriptName(event.speaker);
    if (resolution.status === "resolved") {
      byCategory.alias_resolved += 1;
      out.push(upcastDialogueCopy(event, resolution.characterId));
      continue;
    }

    // 3) unresolved：保持原样（只读回放），绝不归因给 narrator/猜测角色。
    const category = unresolvedCategory(ownId, resolution);
    byCategory[category] += 1;
    const eventRef = `event:${event.seq}`;
    unresolvedRefs.push(eventRef);
    const untrustedIdNote =
      ownId !== undefined
        ? `旧事件 ${eventRef} 携带 characterId ${JSON.stringify(ownId)}，` +
          `但该 ID 不在当前作用域 roster（scopeId=${scopeId}）内——字符串存在不等于可信，不跨世界同名兜底；`
        : "";
    unresolvedReasons.push(
      `${untrustedIdNote}${resolution.diagnostic}；该台词保持只读回放，` +
        "继续生成前需要显式补充角色映射或重开会话",
    );
    out.push(event);
  }

  return {
    events: out,
    diagnostics: {
      totalEvents: events.length,
      dialogueEvents,
      byCategory,
      unresolvedRefs,
      unresolvedReasons,
    },
  };
}

/**
 * 内容摘要（seq|type|名牌|正文|line_id）：迁移前后必须逐字节一致——
 * 升级只补身份信封，绝不改写台词内容与名牌文本。
 */
export function legacyEventContentSummary(events: readonly StoredEvent[]): string {
  return events
    .map((event) => {
      const label =
        event.type === "dialogue" || event.type === "player_dialogue"
          ? event.speaker
          : "";
      const text = "text" in event ? event.text : "";
      const lineId = "line_id" in event ? event.line_id : "";
      return `${event.seq}|${event.type}|${label}|${text}|${lineId}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// 信封构造
// ---------------------------------------------------------------------------

/**
 * 由当前 roster 快照 + 名牌状态构造新格式身份信封（纯函数，浅拷贝）。
 * `dslProtocolVersion` 必须显式给出（campus 84a68ee 终审 protocol-version
 * fixity：信封记录**会话实际协议版本**，调用方注入落盘时 live config 的
 * 生效值——不恒写格式常量，杜绝「翻旋钮后存档版本字段失真」）。main 的
 * 图快照路径不走本函数（SnapshotIdentityState 由 Game 的 momentIdentity
 * 直接写会话实际版本）；本函数保留两分支可移植的信封形状构造。
 */
export function buildSnapshotIdentityEnvelope(
  roster: SnapshotRosterSnapshot,
  characterLabels: Readonly<Record<CharacterId, string>>,
  dslProtocolVersion: SnapshotDslProtocolVersion,
): SnapshotIdentityEnvelope {
  const labels: Record<CharacterId, string> = {};
  for (const key of Object.keys(characterLabels)) {
    if (Object.hasOwn(characterLabels, key)) {
      labels[key] = characterLabels[key]!;
    }
  }
  return {
    identitySchemaVersion: SNAPSHOT_IDENTITY_SCHEMA_VERSION,
    dslProtocolVersion,
    roster,
    characterLabels: labels,
  };
}

/** roster 快照的结构校验（图快照身份引用落盘前/读回后的共用闸门）。 */
const SnapshotRosterSnapshotSchema = z.object({
  scopeId: z.string().min(1),
  revision: z.string().min(1),
  playerId: CharacterIdSchema,
  characters: z.array(CharacterDefinitionSchema),
});

export function parseSnapshotRoster(value: unknown): SnapshotRosterSnapshot {
  const check = SnapshotRosterSnapshotSchema.safeParse(value);
  if (!check.success) {
    const detail = check.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new CorruptV2SnapshotError(
      `roster 定义/内容快照损坏（${detail}）——身份不可恢复，拒绝解析`,
    );
  }
  return check.data;
}
