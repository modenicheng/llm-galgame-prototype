/**
 * 快照身份信封与旧数据迁移诊断（M3，自校园线 F3 `session-store-port.ts`
 * 的身份段落移植共用——两个分支共享同一套核心规范；校园侧文件：
 * `campus/src/core/ports/session-store-port.ts`）。
 *
 * main 的图快照（StateSnapshot v4）外层不再有独立的 state.v2.json，身份
 * 信封的等价物是 `core/graph/types.ts` 的 `SnapshotIdentityState`（嵌入每
 * 个决策入口/末态快照）；共享不可变 roster blob 按 revision 落盘，快照只
 * 引用 scope/revision，不重复整份人设。
 *
 * 本模块纯类型与纯常量，无 IO。
 */
import type {
  CharacterDefinition,
  CharacterId,
  CharacterRoster,
} from "../characters/types.js";
import type { LegacyIdentityMapping } from "../characters/legacy-identity.js";

/** 快照身份契约版本（与校园 F3 对齐；v1 = 旧无身份快照）。 */
export const SNAPSHOT_IDENTITY_SCHEMA_VERSION = 2;

/**
 * 快照随存的 DSL 协议版本（C7 wire 协议 v2 的格式当前值参照）。
 * 注意：信封/身份块的 `dslProtocolVersion` 字段记录的是**会话实际协议
 * 版本**（落盘时 live config `dsl.protocol_version` 的生效值，类型
 * `SnapshotDslProtocolVersion`），不再恒写本常量——跨旋钮重启恢复时
 * 存档版本可对照当前配置诊断漂移（campus 84a68ee 终审 finding 1 同款
 * fixity，main 的等价物是图快照 v4 的 SnapshotIdentityState）。
 */
export const SNAPSHOT_DSL_PROTOCOL_VERSION = 2;

/**
 * 身份块 `dslProtocolVersion` 字段的类型：DSL 协议旋钮（config
 * `dsl.protocol_version`）的当前取值域。该字段记录**会话实际协议版本**
 * （落盘时 live config 的生效值），不是格式常量。
 */
export type SnapshotDslProtocolVersion = 1 | 2;

/**
 * 可恢复的 roster 定义/内容快照：快照落盘时随存完整 `CharacterDefinition`
 * 列表。恢复时即使当前 roster 已漂移，也能对上「当时有哪些人」；revision
 * 漂移只报告、不静默丢弃名牌/立绘状态。
 */
export interface SnapshotRosterSnapshot {
  scopeId: string;
  revision: string;
  playerId: CharacterId;
  characters: readonly CharacterDefinition[];
}

/** 由 CharacterRoster 派生的 roster 快照（浅拷贝容器，定义原引用）。 */
export function rosterSnapshotOf(roster: CharacterRoster): SnapshotRosterSnapshot {
  return {
    scopeId: roster.scopeId,
    revision: roster.revision,
    playerId: roster.playerId,
    characters: roster.characters,
  };
}

/**
 * 身份信封（校园 F3 同名概念的共用形状）：两个版本字段 + roster 快照 +
 * 名牌状态。main 的图快照把它展开为 `SnapshotIdentityState`（roster 以
 * {scopeId, revision} 引用共享 blob，不内嵌定义）；identity-upcaster 的
 * 信封构造沿用本形状（两分支可移植）。
 */
export interface SnapshotIdentityEnvelope {
  identitySchemaVersion: typeof SNAPSHOT_IDENTITY_SCHEMA_VERSION;
  /**
   * 落盘时该会话实际的 DSL 协议版本（config `dsl.protocol_version` 的
   * 生效值，`1 | 2`）。v3 旧图快照升级没有存档版本——升级身份块按当前
   * 配置版本落章并在迁移报告注明。恢复时与当前配置对照：不一致 → Game
   * 恢复路径响亮诊断（路由仍按当前配置，不按存档版本重路由）。
   */
  dslProtocolVersion: SnapshotDslProtocolVersion;
  roster: SnapshotRosterSnapshot;
  /** 角色 ID → 当前名牌（v3 旧快照升级后为空——旧格式没有名牌状态）。 */
  characterLabels: Readonly<Record<CharacterId, string>>;
}

// ---------------------------------------------------------------------------
// 旧事件迁移诊断（可数、可观测）
// ---------------------------------------------------------------------------

/**
 * 旧事件升级的单类结果。解析优先级（计划 §F3）：
 * 当前作用域内已验证 ID → 明确登记的唯一 legacy alias → unresolved。
 */
export type LegacyEventUpcastCategory =
  | "identity_verified"
  | "alias_resolved"
  | "unresolved_ambiguous"
  | "unresolved_unknown_id"
  | "unresolved_unregistered"
  /**
   * 未做身份升级的事件原样透传：旁白/交互/结局 + 全部 player_* 事件
   * （含 player_dialogue——玩家话语由运行时创建，speaker 是展示名，
   * 不属于旧模型对白升级面）。
   */
  | "non_model_dialogue_untouched";

export interface EventMigrationDiagnostics {
  totalEvents: number;
  dialogueEvents: number;
  /** 每类计数（输出迁移统计的核心）。 */
  byCategory: Record<LegacyEventUpcastCategory, number>;
  /** 不可解析对白的只读回放引用（`event:<seq>`，与 reasons 同序）。 */
  unresolvedRefs: readonly string[];
  /** 每条 unresolved 的诊断说明。 */
  unresolvedReasons: readonly string[];
}

export interface SnapshotMigrationDiagnostics {
  /** 读到的快照格式。main 图快照：v3（旧，无身份块）或 v4（当前）。 */
  sourceFormat: "graph-v3" | "graph-v4";
  /** 恢复的名牌条数（v3 恒 0——旧格式没有名牌状态）。 */
  characterLabelsRecovered: number;
  /** 因损坏被丢弃/因无法唯一映射被拒绝的字段（拒绝即中断，不静默降级）。 */
  corruptFieldsDropped: readonly string[];
  notes: readonly string[];
}

export interface SessionMigrationReport {
  events: EventMigrationDiagnostics;
  snapshot: SnapshotMigrationDiagnostics;
}

/**
 * M3 图存储侧身份上下文（宿主装配一次，store 与协调器共用）：
 * - `roster`：共享不可变 roster blob 的写入源 + v3→v4 升级的解析权威
 *   （legacy 兼容世界缺省 undefined——无 roster 即无 blob，也不做升级）；
 * - `dslProtocolVersion`：升级目标身份块的协议版本（当前 config 值；
 *   v3 旧快照没有存档版本，按当前会话配置落章——与校园 F3/84a68ee 对
 *   v1 旧快照的决策一致，恢复对照天然一致、不产生假漂移诊断）；
 * - `legacyMapping`：旧 scriptName/visualState 键 → 稳定 ID 的显式登记，
 *   scopeId 必须与 roster 一致（upcaster 强校验，杜绝跨世界同名兜底）。
 */
export interface GraphIdentityContext {
  roster: () => CharacterRoster | undefined;
  dslProtocolVersion: () => SnapshotDslProtocolVersion;
  legacyMapping?: LegacyIdentityMapping;
}
