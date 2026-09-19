/**
 * 图快照 v3 → v4 显式升级适配器（M3）。
 *
 * 分层边界（与校园线 F3 的 identity-upcaster 同一纪律）：
 * - 只做**兼容读取**：v3 快照在内存升级为 v4，原 snapshots/<dc>.json 字节
 *   不动（回滚读原旧档；新写入一律 v4，不回写旧文件）。
 * - 升级前先完成身份映射解析：visualState 的角色键、digest beliefs 的
 *   characterId、facts 的 scope.characters 都要走「当前作用域 roster 内
 *   已验证 ID → 显式登记的唯一 legacy alias → 拒绝」优先级链。无法唯一
 *   解析的键**整档拒绝**（SnapshotUpcastError 带全部引用与说明）——静默
 *   丢人/错人比恢复失败更危险；原 game 保留，可读只读回放或显式重开。
 * - v1/v2 沿用读取即拒策略（dev 存档废弃不做迁移，不虚称兼容所有历史
 *   格式）；高于当前版本（未来格式）同样显式拒绝，不降级解析。
 *
 * 纯函数，无 IO。
 */
import { z } from "zod";
import type { CharacterId } from "../characters/types.js";
import type { LegacyIdentityMapping } from "../characters/legacy-identity.js";
import { createLegacyIdentityResolver } from "../characters/legacy-identity.js";
import type { SnapshotRosterSnapshot } from "../ports/identity-snapshot-port.js";
import { SNAPSHOT_IDENTITY_SCHEMA_VERSION } from "../ports/identity-snapshot-port.js";
import { MemoryDigestSchema } from "./types.js";
import { SNAPSHOT_VERSION } from "./types.js";
import type { SnapshotIdentityState, StateSnapshot } from "./types.js";
import { StateSnapshotSchema } from "./types.js";
import { StoryStateSchema } from "../../story/types.js";
import { VisualStateSchema } from "../presentation/types.js";

// ---------------------------------------------------------------------------
// 错误类型（显式拒绝，不静默误读）
// ---------------------------------------------------------------------------

/**
 * 快照版本不被本程序支持：v1/v2（dev 存档废弃，读取即拒——沿用 v2 起的
 * 既有策略）或高于当前版本的未来格式。抛错而非降级解析。
 */
export class SnapshotVersionGateError extends Error {
  constructor(
    message: string,
    readonly foundVersion: number,
    readonly supportedVersion: number,
  ) {
    super(message);
    this.name = "SnapshotVersionGateError";
  }
}

/** v3 → v4 升级中无法唯一解析的身份引用（整档拒绝，携带全部定位）。 */
export class SnapshotUpcastError extends Error {
  constructor(
    message: string,
    readonly refs: readonly string[],
    readonly reasons: readonly string[],
  ) {
    super(message);
    this.name = "SnapshotUpcastError";
  }
}

// ---------------------------------------------------------------------------
// v3 历史形状（冻结：v3 写入端已停写，此处只描述当年落盘的字段集）
// ---------------------------------------------------------------------------

const V3_SNAPSHOT_VERSION = 3;
/** v1/v2：读取即拒（v2 起的既定策略——dev 存档废弃，不做迁移）。 */
export const REJECTED_SNAPSHOT_VERSIONS: readonly number[] = [1, 2];

const V3MemoryDigestSchema = MemoryDigestSchema.extend({
  // v3 内为可选追加（§6.2 M2 后期）；v4 起必填，升级适配器补 []。
  consolidationFailedIntervals: z.array(
    MemoryDigestSchema.shape.consolidationFailedIntervals.element,
  ).optional(),
});

const V3StateSnapshotSchema = z.object({
  snapshotVersion: z.literal(V3_SNAPSHOT_VERSION),
  storyState: StoryStateSchema,
  visualState: VisualStateSchema,
  memoryDigest: V3MemoryDigestSchema,
  outlineRevision: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// 升级上下文与身份块构造
// ---------------------------------------------------------------------------

export interface SnapshotUpcastContext {
  /** 当前作用域 roster 快照（升级目标身份块 + 键解析权威）。 */
  roster: SnapshotRosterSnapshot;
  /** 当前 DSL 协议版本（升级目标身份块的 dslProtocolVersion）。 */
  dslProtocolVersion: number;
  /** 显式登记的旧身份映射（scopeId 必须与 roster 一致）。 */
  legacyMapping?: LegacyIdentityMapping;
}

/**
 * 由 roster + 协议版本构造快照身份块（cast：NPC = 允许说话人，全体 =
 * 场景参与者——与 Game.generationIdentity 的推导同一语义）。
 */
export function buildSnapshotIdentityState(input: {
  roster: SnapshotRosterSnapshot;
  dslProtocolVersion: number;
  characterLabels?: Record<CharacterId, string>;
}): SnapshotIdentityState {
  return {
    identitySchemaVersion: SNAPSHOT_IDENTITY_SCHEMA_VERSION,
    dslProtocolVersion: input.dslProtocolVersion,
    rosterScopeId: input.roster.scopeId,
    rosterRevision: input.roster.revision,
    characterLabels: { ...(input.characterLabels ?? {}) },
    cast: {
      allowedSpeakerIds: input.roster.characters
        .filter((definition) => definition.control === "npc")
        .map((definition) => definition.id),
      sceneParticipantIds: input.roster.characters.map((definition) => definition.id),
    },
  };
}

/** 读出快照自报的契约版本（无/非整数 → undefined，由调用方按损坏处理）。 */
export function readSnapshotVersion(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const version = (payload as { snapshotVersion?: unknown }).snapshotVersion;
  return typeof version === "number" && Number.isInteger(version) ? version : undefined;
}

/** 版本闸门：调用方在 schema 解析前先问「这个版本该走哪条路」。 */
export function assertSupportedSnapshotVersion(version: number): void {
  if (version === SNAPSHOT_VERSION || version === V3_SNAPSHOT_VERSION) return;
  if (REJECTED_SNAPSHOT_VERSIONS.includes(version)) {
    throw new SnapshotVersionGateError(
      `快照契约版本 v${version} 按 v2 起的既定策略读取即拒（dev 存档废弃，不做迁移）；` +
        `本程序支持 v${V3_SNAPSHOT_VERSION}（经显式升级适配器）与 v${SNAPSHOT_VERSION}`,
      version,
      SNAPSHOT_VERSION,
    );
  }
  throw new SnapshotVersionGateError(
    `快照契约版本 v${version} 高于本程序支持的 v${SNAPSHOT_VERSION}——` +
      "请升级程序，不做静默降级解析",
    version,
    SNAPSHOT_VERSION,
  );
}

// ---------------------------------------------------------------------------
// 身份键解析（优先级链：roster 已验证 ID → 唯一 legacy alias → 拒绝）
// ---------------------------------------------------------------------------

interface KeyResolver {
  /** 已是 roster 内稳定 ID → 原样保留。 */
  resolve(key: string): { kind: "keep" } | { kind: "map"; id: CharacterId } | { kind: "unresolved"; reason: string };
}

function buildKeyResolver(context: SnapshotUpcastContext): KeyResolver {
  // 映射与 roster 作用域必须一致：跨世界映射直接拒绝（与 identity-upcaster
  // 的 IdentityUpcastScopeMismatchError 同一纪律，core 层不复用 adapter 类）。
  if (
    context.legacyMapping !== undefined &&
    context.legacyMapping.scope.scopeId !== context.roster.scopeId
  ) {
    throw new Error(
      `legacy 身份映射的 scopeId（${context.legacyMapping.scope.scopeId}）与 roster 作用域` +
        `（${context.roster.scopeId}）不一致；映射只对同作用域旧数据生效，不做跨世界同名兜底`,
    );
  }
  const rosterIds = new Set(context.roster.characters.map((definition) => definition.id));
  const resolver =
    context.legacyMapping !== undefined
      ? createLegacyIdentityResolver(context.legacyMapping)
      : undefined;
  const scopeId = context.roster.scopeId;
  return {
    resolve(key: string) {
      if (rosterIds.has(key)) return { kind: "keep" };
      if (resolver !== undefined) {
        const resolution = resolver.resolveScriptName(key);
        if (resolution.status === "resolved") return { kind: "map", id: resolution.characterId };
        if (resolution.status === "ambiguous") {
          return {
            kind: "unresolved",
            reason: `v3 快照引用 ${JSON.stringify(key)}（scopeId=${scopeId}）在旧身份表中歧义` +
              `（候选：${resolution.candidates.join(", ")}）——不许任选其一`,
          };
        }
        return {
          kind: "unresolved",
          reason: `v3 快照引用 ${JSON.stringify(key)}（scopeId=${scopeId}）不在当前 roster，` +
            "且没有显式登记的 legacy 映射——字符串存在不等于可信，不跨世界同名兜底",
        };
      }
      return {
        kind: "unresolved",
        reason: `v3 快照引用 ${JSON.stringify(key)}（scopeId=${scopeId}）不在当前 roster，` +
          "且未登记 legacy 映射——继续生成需要显式补充角色映射或重开会话",
      };
    },
  };
}

/** 解析失败即整档拒绝：收集全部引用后一次性抛 SnapshotUpcastError。 */
function collectUnresolved(
  refs: string[],
  reasons: string[],
  ref: string,
  reason: string,
): void {
  refs.push(ref);
  reasons.push(reason);
}

// ---------------------------------------------------------------------------
// v3 → v4 升级（内存副本，纯函数，原对象不动）
// ---------------------------------------------------------------------------

/**
 * v3 快照载荷（已 JSON.parse）→ v4 StateSnapshot。
 *
 * 转换面：版本号 3→4；digest 补 consolidationFailedIntervals=[]（v3 内该
 * 字段可选追加）；外层挂身份块（名牌为空——v3 没有名牌状态可恢复，名牌
 * 回退 roster initialLabel）；visualState 角色键、digest beliefs 的
 * characterId、facts 的 scope.characters 经优先级链映射到稳定 ID。
 * 任一引用无法唯一解析 → SnapshotUpcastError（读只读回放 + 显式迁移错误，
 * 绝不静默丢人或错人）。原载荷对象绝不修改。
 */
export function upcastSnapshotV3ToV4(
  payload: unknown,
  context: SnapshotUpcastContext,
): StateSnapshot {
  const parsed = V3StateSnapshotSchema.parse(payload);
  const resolver = buildKeyResolver(context);
  const refs: string[] = [];
  const reasons: string[] = [];

  // ① visualState 角色键（旧 legacy 世界的键是台词行头 scriptName）。
  const characters: StateSnapshot["visualState"]["characters"] = {};
  for (const [key, entry] of Object.entries(parsed.visualState.characters)) {
    const resolution = resolver.resolve(key);
    if (resolution.kind === "keep") characters[key] = entry;
    else if (resolution.kind === "map") characters[resolution.id] = entry;
    else collectUnresolved(refs, reasons, `visualState:${key}`, resolution.reason);
  }

  // ② digest beliefs 的 characterId（记忆认知挂在人身上，错人即污染）。
  const beliefs = parsed.memoryDigest.beliefs.map((belief) => {
    const resolution = resolver.resolve(belief.characterId);
    if (resolution.kind === "keep") return belief;
    if (resolution.kind === "map") return { ...belief, characterId: resolution.id };
    collectUnresolved(
      refs,
      reasons,
      `belief:${belief.id}:${belief.characterId}`,
      resolution.reason,
    );
    return belief;
  });

  // ③ facts 的 scope.characters（知情链引用；同链映射）。
  const facts = parsed.memoryDigest.facts.map((fact) => {
    if (fact.scope?.characters === undefined) return fact;
    const mapped: string[] = [];
    for (const id of fact.scope.characters) {
      const resolution = resolver.resolve(id);
      if (resolution.kind === "keep") mapped.push(id);
      else if (resolution.kind === "map") mapped.push(resolution.id);
      else collectUnresolved(refs, reasons, `fact:${fact.id}:${id}`, resolution.reason);
    }
    return { ...fact, scope: { ...fact.scope, characters: mapped } };
  });

  if (refs.length > 0) {
    throw new SnapshotUpcastError(
      `v3 快照有 ${refs.length} 处身份引用无法唯一升级（${refs.join("、")}）；` +
        "原存档未改动，可只读回放；继续生成前需要显式补充角色映射或重开",
      refs,
      reasons,
    );
  }

  const candidate: StateSnapshot = {
    snapshotVersion: SNAPSHOT_VERSION,
    storyState: parsed.storyState,
    visualState: { ...parsed.visualState, characters },
    memoryDigest: {
      ...parsed.memoryDigest,
      beliefs,
      facts,
      // v3 内可选追加；v4 必填。缺省 = 无失败区间（pre-M2 会话没有降级语义）。
      consolidationFailedIntervals:
        parsed.memoryDigest.consolidationFailedIntervals ?? [],
    },
    outlineRevision: parsed.outlineRevision,
    identity: buildSnapshotIdentityState({
      roster: context.roster,
      dslProtocolVersion: context.dslProtocolVersion,
      characterLabels: {},
    }),
  };
  // 升级产物仍须过当前契约 schema（身份块/类型不合规即在边界上大声失败）。
  return StateSnapshotSchema.parse(candidate);
}
