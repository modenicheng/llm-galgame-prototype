/**
 * Pure validation rules for narrative-memory operations (narrative
 * director, Task 5).
 *
 * No IO, no classes — every function is a total pure function returning
 * `string | null` (null = accept). Reason strings are human-readable
 * Chinese diagnostics recorded via `RejectedOp` by later tasks.
 *
 * C8 §6.2 additions: the shared identity validators below are the
 * branch-shared validation core. Campus validates character tags / evidence
 * refs / reference tags against a `MemoryIdentityView`; main's fact/belief
 * specifics (M2) extend the same view (fact/belief reference sets, belief
 * learning sources) without changing these function contracts —
 * KNOWLEDGE_NOT_SUPPORTED is the code main reuses for belief learning.
 */

import { VALID_THREAD_TRANSITIONS } from "../../core/narrative/memory-types.js";

import type { StoredEvent } from "../../schema.js";
import { projectMemoryEvidence } from "../../story/event-projection.js";
import type { ProjectedEvent } from "../../story/event-projection.js";
import type { CharacterId, CharacterRegistry } from "../../core/characters/types.js";
import type {
  NarrativeMemoryState,
  PlotThread,
  SetupPayoff,
  FactRecord,
  BeliefState,
} from "../../core/narrative/memory-types.js";
import type {
  ThreadOp,
  SetupOp,
  EpisodeSummaryOp,
  FactOp,
  BeliefOp,
  AuditFinding,
  IdentityValidationIssue,
  ValidatedProposal,
} from "../../core/narrative/memory-operation.js";
import type { SetupDirective } from "../../core/narrative/setup-directive.js";
import type { NarrativeConfig } from "../../config.js";

/** Thread statuses that count as "active" for the thread budgets. */
const ACTIVE_THREAD_STATUSES: ReadonlySet<PlotThread["status"]> = new Set([
  "open",
  "developing",
  "ready_to_resolve",
]);

/**
 * 稳定拒绝规则码（记忆 spec §7.2 来源 2）：拒绝 reason 以 `[CODE] ` 前缀
 * 编码规则身份，`rejectionRule()` 解析——lesson 自动晋升按码计数，
 * 「同一规则第二次出现算流程违规」。人话部分与既有 reason 保持一致。
 */
function fail(rule: string, reason: string): string {
  return `[${rule}] ${reason}`;
}

/** 从拒绝 reason 解析稳定规则码；无码返回 "unknown"。 */
export function rejectionRule(reason: string): string {
  const m = /^\[([A-Z_]+)\]/.exec(reason);
  return m ? m[1]! : "unknown";
}

/** Setup statuses that count as "active" for the setup budget. */
const ACTIVE_SETUP_STATUSES: ReadonlySet<SetupPayoff["status"]> = new Set([
  "seeded",
  "reinforced",
  "ready",
]);

/** Thread statuses that are terminal (setup prerequisite 满足判定用). */
const TERMINAL_THREAD_STATUSES: ReadonlySet<PlotThread["status"]> = new Set([
  "resolved",
  "abandoned",
]);

/**
 * Validate a thread operation against the current memory state.
 * Returns null when the op may be applied, otherwise a rejection reason.
 */
export function validateThreadOp(
  op: ThreadOp,
  memory: NarrativeMemoryState,
  config: NarrativeConfig,
): string | null {
  const existing = memory.threads[op.id];

  switch (op.type) {
    case "create": {
      if (existing !== undefined) {
        return fail("THREAD_ALREADY_EXISTS", `线程 ${op.id} 已存在，不能重复创建`);
      }
      if (op.kind === undefined || op.importance === undefined) {
        return fail("THREAD_CREATE_MISSING_FIELDS", `线程 ${op.id} create 缺少 kind/importance`);
      }
      // 预算按自身 importance 口径（audit P1-8）：创建 minor 只查 minor 预算，
      // 不能被占满的 major 预算误伤。
      const budget =
        op.importance === "major"
          ? config.threads.max_major_active
          : config.threads.max_minor_active;
      let active = 0;
      for (const thread of Object.values(memory.threads)) {
        if (
          ACTIVE_THREAD_STATUSES.has(thread.status) &&
          thread.importance === op.importance
        ) {
          active += 1;
        }
      }
      if (active >= budget) {
        return fail(
          "THREAD_BUDGET_EXCEEDED",
          `活跃 ${op.importance} 线程数 ${active} 已达上限 ${budget}`,
        );
      }
      return null;
    }
    case "touch": {
      if (existing === undefined) {
        return fail("THREAD_MISSING", `线程 ${op.id} 不存在`);
      }
      return null;
    }
    case "advance": {
      if (existing === undefined) {
        return fail("THREAD_MISSING", `线程 ${op.id} 不存在`);
      }
      if (VALID_THREAD_TRANSITIONS[existing.status].length === 0) {
        return fail("THREAD_TERMINAL", `线程 ${op.id} 当前状态 ${existing.status} 为终态，无法 advance`);
      }
      return null;
    }
    case "resolve": {
      if (existing === undefined) {
        return fail("THREAD_MISSING", `线程 ${op.id} 不存在`);
      }
      if (existing.status === "resolved" || existing.status === "abandoned") {
        return fail("THREAD_TERMINAL", `线程 ${op.id} 当前状态 ${existing.status} 为终态，无法 resolve`);
      }
      return null;
    }
    case "abandon": {
      if (existing === undefined) {
        return fail("THREAD_MISSING", `线程 ${op.id} 不存在`);
      }
      if (existing.status === "resolved" || existing.status === "abandoned") {
        return fail("THREAD_TERMINAL", `线程 ${op.id} 当前状态 ${existing.status} 为终态，无法 abandon`);
      }
      return null;
    }
  }
}

/**
 * Validate a setup operation against the current memory state.
 * Returns null when the op may be applied, otherwise a rejection reason.
 */
export function validateSetupOp(
  op: SetupOp,
  memory: NarrativeMemoryState,
  config: NarrativeConfig,
  maxEvidenceSeq?: number,
): string | null {
  const existing = memory.setups[op.id];

  // Evidence event ids must reference committed events (≤ the current
  // batch's last seq when the consolidator passes it; spec §5).
  if (op.evidenceEventIds !== undefined && maxEvidenceSeq !== undefined) {
    for (const id of op.evidenceEventIds) {
      const seq = Number(id);
      if (!Number.isInteger(seq) || seq < 1 || seq > maxEvidenceSeq) {
        return fail("SETUP_EVIDENCE_OUT_OF_RANGE", `证据事件 ${id} 不在已提交范围（≤ ${maxEvidenceSeq}）`);
      }
    }
  }

  switch (op.type) {
    case "seed": {
      if (existing === undefined) {
        return fail("SETUP_MISSING", `伏笔 ${op.id} 不存在`);
      }
      if (existing.status !== "planned") {
        return fail("SETUP_NOT_PLANNED", `伏笔 ${op.id} 状态为 ${existing.status}，只有 planned 可以 seed`);
      }
      // 「没有回收计划的伏笔不许下场」（记忆 spec §8.2）：seed 前必须声明
      // intendedPayoff；author seed 缺省由 loader 记 warning，运行时硬拒。
      if (existing.intendedPayoff === undefined) {
        return fail(
          "SETUP_SEED_WITHOUT_INTENDED_PAYOFF",
          `伏笔 ${op.id} 未声明 intendedPayoff，没有回收计划的伏笔不许下场`,
        );
      }
      let active = 0;
      for (const setup of Object.values(memory.setups)) {
        if (ACTIVE_SETUP_STATUSES.has(setup.status)) {
          active += 1;
        }
      }
      if (active >= config.setups.max_active) {
        return fail("SETUP_BUDGET_EXCEEDED", `活跃伏笔数 ${active} 已达上限 ${config.setups.max_active}`);
      }
      return null;
    }
    case "reinforce": {
      if (existing === undefined) {
        return fail("SETUP_MISSING", `伏笔 ${op.id} 不存在`);
      }
      if (existing.status !== "seeded" && existing.status !== "reinforced") {
        return fail("SETUP_BAD_STATUS", `伏笔 ${op.id} 状态为 ${existing.status}，只有 seeded|reinforced 可以 reinforce`);
      }
      return null;
    }
    case "payoff": {
      if (existing === undefined) {
        return fail("SETUP_MISSING", `伏笔 ${op.id} 不存在`);
      }
      if (existing.status !== "reinforced" && existing.status !== "ready") {
        return fail("SETUP_BAD_STATUS", `伏笔 ${op.id} 状态为 ${existing.status}，只有 reinforced|ready 可以 payoff`);
      }
      return null;
    }
    case "drop": {
      if (existing === undefined) {
        return fail("SETUP_MISSING", `伏笔 ${op.id} 不存在`);
      }
      if (existing.status === "paid_off" || existing.status === "dropped") {
        return fail("SETUP_TERMINAL", `伏笔 ${op.id} 当前状态 ${existing.status} 为终态，无法 drop`);
      }
      return null;
    }
    case "hold": {
      if (existing === undefined) {
        return fail("SETUP_MISSING", `伏笔 ${op.id} 不存在`);
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// State application (shared by MemoryConsolidator's shadow validation and
// the director's final apply). Pure: mutates `state` in place.
// ---------------------------------------------------------------------------

/**
 * Apply a validated thread op to a state object (mutates in place).
 * `checkpoint` is the narrative beat used for timeline fields.
 * Used both for shadow validation (checkpoint irrelevant) and the
 * director's real apply.
 */
export function applyThreadOpToState(
  state: NarrativeMemoryState,
  op: ThreadOp,
  checkpoint: number,
): void {
  switch (op.type) {
    case "touch": {
      const t = state.threads[op.id];
      if (t) {
        t.lastTouchedAtCheckpoint = checkpoint;
        if (op.progress !== undefined) {
          t.summary = op.progress;
        }
      }
      break;
    }
    case "advance": {
      const t = state.threads[op.id];
      if (t) {
        const nextStatuses = VALID_THREAD_TRANSITIONS[t.status] ?? [];
        const nextStatus = nextStatuses[0];
        if (nextStatus) {
          t.status = nextStatus;
        }
        t.lastTouchedAtCheckpoint = checkpoint;
      }
      break;
    }
    case "resolve": {
      const t = state.threads[op.id];
      if (t) {
        t.status = "resolved";
        t.lastTouchedAtCheckpoint = checkpoint;
      }
      break;
    }
    case "abandon": {
      const t = state.threads[op.id];
      if (t) {
        t.status = "abandoned";
        t.lastTouchedAtCheckpoint = checkpoint;
      }
      break;
    }
    case "create": {
      state.threads[op.id] = {
        id: op.id,
        kind: op.kind ?? "main",
        summary: op.progress ?? `Thread ${op.id}`,
        status: "open",
        importance: op.importance ?? "minor",
        introducedAtCheckpoint: checkpoint,
        lastTouchedAtCheckpoint: checkpoint,
        source: "runtime",
      };
      break;
    }
  }
}

/**
 * Apply a validated setup op to a state object (mutates in place).
 * `checkpoint` is the narrative beat used for timeline fields.
 */
export function applySetupOpToState(
  state: NarrativeMemoryState,
  op: SetupOp,
  checkpoint: number,
): void {
  const s = state.setups[op.id];
  if (!s) return;

  switch (op.type) {
    case "seed": {
      s.status = "seeded";
      s.seededAtCheckpoint = checkpoint;
      s.lastTouchedAtCheckpoint = checkpoint;
      break;
    }
    case "reinforce": {
      s.status = "reinforced";
      s.reinforcementCount += 1;
      s.lastTouchedAtCheckpoint = checkpoint;
      break;
    }
    case "payoff": {
      s.status = "paid_off";
      s.payoffAtCheckpoint = checkpoint;
      s.lastTouchedAtCheckpoint = checkpoint;
      break;
    }
    case "hold": {
      // No change
      break;
    }
    case "drop": {
      s.status = "dropped";
      break;
    }
  }
}

/** Array fields of an episode summary op, all validated identically. */
const EPISODE_ARRAY_FIELDS = [
  "characters",
  "locations",
  "threads",
  "setups",
] as const;

// ---------------------------------------------------------------------------
// MA-B 校验（记忆 spec §5.2/§6.1/§9.2）
// ---------------------------------------------------------------------------

/** 每批 establish 预算（§5.2）：纠错（amend）不限量。 */
export const MAX_ESTABLISH_PER_BATCH = 3;
/** 每批每角色 belief op 预算（§6.1）。 */
export const MAX_BELIEF_OPS_PER_CHARACTER_PER_BATCH = 2;
/** 每批 findings 上限（§9.2，prompt 同步声明，防刷屏）。 */
export const MAX_FINDINGS_PER_BATCH = 5;

function checkEvidenceRange(
  seqs: readonly number[],
  maxEvidenceSeq: number | undefined,
  rule: string,
  what: string,
): string | null {
  if (maxEvidenceSeq === undefined) return null;
  for (const seq of seqs) {
    if (!Number.isInteger(seq) || seq < 1 || seq > maxEvidenceSeq) {
      return fail(rule, `证据事件 ${seq} 不在已提交范围（≤ ${maxEvidenceSeq}）`);
    }
  }
  return null;
}

/**
 * Validate a fact op against the existing fact records.
 * `factCountByContent` semantics live in the consolidator's batch loop;
 * here we check per-op rules only (§5.2).
 */
export function validateFactOp(
  op: FactOp,
  facts: readonly FactRecord[],
  maxEvidenceSeq?: number,
): string | null {
  if (op.evidenceEventSeqs.length < 1 || op.evidenceEventSeqs.length > 3) {
    return fail("FACT_EVIDENCE_COUNT", "fact 证据事件须 1..3 条");
  }
  const rangeError = checkEvidenceRange(
    op.evidenceEventSeqs,
    maxEvidenceSeq,
    "FACT_EVIDENCE_OUT_OF_RANGE",
    "fact",
  );
  if (rangeError !== null) return rangeError;

  if (op.type === "amend") {
    if (op.id === undefined) {
      return fail("FACT_AMEND_WITHOUT_ID", "amend 必须引用被修订的 fact id");
    }
    const target = facts.find((f) => f.id === op.id);
    if (target === undefined) {
      return fail("FACT_AMEND_UNKNOWN_ID", `amend 引用的 fact ${op.id} 不存在`);
    }
    if (target.superseded) {
      return fail("FACT_AMEND_SUPERSEDED", `fact ${op.id} 已被修订过，不能再次 amend`);
    }
    return null;
  }
  return null;
}

/** Validate a belief op (§6.1). `knownCharacters` = 权威角色 ID 集合。 */
export function validateBeliefOp(
  op: BeliefOp,
  beliefs: readonly BeliefState[],
  knownCharacters: readonly string[],
  maxEvidenceSeq?: number,
): string | null {
  const rangeError = checkEvidenceRange(
    op.evidenceEventSeqs,
    maxEvidenceSeq,
    "BELIEF_EVIDENCE_OUT_OF_RANGE",
    "belief",
  );
  if (rangeError !== null) return rangeError;

  if (
    knownCharacters.length > 0 &&
    !knownCharacters.includes(op.characterId)
  ) {
    return fail(
      "BELIEF_UNKNOWN_CHARACTER",
      `角色 ${op.characterId} 不在已整理事件中出现，不能获得认知`,
    );
  }
  if (op.type === "correct") {
    if (op.replacesBeliefId === undefined) {
      return fail("BELIEF_CORRECT_WITHOUT_TARGET", "correct 必须引用被纠正的 belief id");
    }
    const target = beliefs.find((b) => b.id === op.replacesBeliefId);
    if (target === undefined) {
      return fail("BELIEF_CORRECT_UNKNOWN_ID", `被纠正的 belief ${op.replacesBeliefId} 不存在`);
    }
    if (target.status !== "active") {
      return fail("BELIEF_CORRECT_INACTIVE", `belief ${op.replacesBeliefId} 已不是 active 状态`);
    }
    return null;
  }
  return null;
}

/** Validate an audit finding shape (§9.2)。 */
export function validateFinding(
  finding: AuditFinding,
  maxEvidenceSeq?: number,
): string | null {
  return checkEvidenceRange(
    finding.evidenceEventSeqs,
    maxEvidenceSeq,
    "FINDING_EVIDENCE_OUT_OF_RANGE",
    "finding",
  );
}

// ---------------------------------------------------------------------------
// MA-B 状态应用（与 applyThreadOpToState 同性质：纯函数，原地修改）
// ---------------------------------------------------------------------------

/**
 * Apply a validated fact op: establish pushes a new record; amend marks the
 * target superseded and appends the new record with `amends` back-link.
 * `id` 由调用方生成（确定性：revision 派生，重放幂等）。
 */
export function applyFactOpToState(
  state: NarrativeMemoryState,
  op: FactOp,
  id: string,
  checkpoint: number,
): void {
  const record: FactRecord = {
    id,
    content: op.content,
    evidenceEventSeqs: [...op.evidenceEventSeqs],
    checkpoint,
    superseded: false,
    ...(op.id !== undefined ? { amends: op.id } : {}),
    ...(op.scope !== undefined ? { scope: op.scope } : {}),
    ...(op.importance !== undefined ? { importance: op.importance } : {}),
  };
  if (op.type === "amend" && op.id !== undefined) {
    const target = state.facts.find((f) => f.id === op.id);
    if (target !== undefined) {
      target.superseded = true;
    }
  }
  state.facts.push(record);
}

/**
 * Apply a validated belief op: learn/believe push a new active belief;
 * correct resolves the replaced belief and appends the corrected one.
 */
export function applyBeliefOpToState(
  state: NarrativeMemoryState,
  op: BeliefOp,
  id: string,
  checkpoint: number,
): void {
  if (op.type === "correct" && op.replacesBeliefId !== undefined) {
    const target = state.beliefs.find((b) => b.id === op.replacesBeliefId);
    if (target !== undefined) {
      target.status = "resolved";
      target.resolvedAtCheckpoint = checkpoint;
    }
  }
  state.beliefs.push({
    id,
    characterId: op.characterId,
    content: op.content,
    status: "active",
    createdAtCheckpoint: checkpoint,
    origin: op.type,
  });
}

/**
 * Validate an episode summary op: non-empty summary ≤ 200 chars, every
 * array field free of empty elements and ≤ 20 unique entries.
 * Returns null when the op may be applied, otherwise a rejection reason.
 */
export function validateEpisodeOp(op: EpisodeSummaryOp): string | null {
  if (op.summary.length === 0) {
    return fail("EPISODE_EMPTY_SUMMARY", "episode summary 不能为空");
  }
  if (op.summary.length > 200) {
    return fail("EPISODE_SUMMARY_TOO_LONG", `episode summary 长度 ${op.summary.length} 超过上限 200`);
  }
  for (const field of EPISODE_ARRAY_FIELDS) {
    const values = op[field];
    if (values.some((value) => value.length === 0)) {
      return fail("EPISODE_EMPTY_TAG", `episode ${field} 含空字符串元素`);
    }
    if (new Set(values).size > 20) {
      return fail("EPISODE_ARRAY_TOO_LONG", `episode ${field} 去重后元素数 ${new Set(values).size} 超过上限 20`);
    }
  }
  return null;
}

/**
 * 伏笔前置是否全部满足（确定性）：引用锚点（reached/passed）、剧情线
 * （非终结）或伏笔（非 planned/dropped）。未知 id → 未满足。
 */
export function setupPrerequisitesSatisfied(
  prerequisites: readonly string[],
  memory: NarrativeMemoryState,
): boolean {
  return prerequisites.every((id) => {
    const anchor = memory.anchors[id];
    if (anchor !== undefined) {
      return anchor.status === "reached" || anchor.status === "passed";
    }
    const thread = memory.threads[id];
    if (thread !== undefined) {
      return !TERMINAL_THREAD_STATUSES.has(thread.status);
    }
    const setup = memory.setups[id];
    if (setup !== undefined) {
      return setup.status !== "planned" && setup.status !== "dropped";
    }
    return false;
  });
}

/**
 * Decide the directive for one setup at a checkpoint.
 * - paid_off/dropped → undefined (no directive)
 * - 超期（age ≥ maxUntouchedCheckpoints）→ resolve_or_drop 第三档（记忆 spec
 *   §8.3，MA-A）：先于前置门——超期伏笔必须推进回收或显式放弃，不得继续悬置
 * - prerequisites unsatisfied → hold (audit P1-4: must not reinforce/payoff
 *   before the player has triggered the prerequisite)
 * - payoffBeforeAnchor matches the current anchor → payoff now (only for
 *   states the validator accepts a payoff from: seeded|reinforced|ready —
 *   otherwise the director would issue an instruction the validator
 *   rejects, audit finding 3)；depth=heavy 且 reinforcementCount<2 → 积累
 *   不足不回收，改发 reinforce（ready 无法 reinforce → hold 观望）（§8.1）
 * - seeded and untouched for ≥ 2 checkpoints → reinforce soon
 * - otherwise → hold (normal urgency)
 *
 * 所有非终态 directive：intendedPayoff 未声明时携带 payoffMissing（§8.2，
 * brief 标注「未定回收计划」）。
 */
export function classifySetup(
  item: SetupPayoff,
  checkpoint: number,
  currentAnchorId: string | undefined,
  prerequisitesSatisfied: boolean,
  maxUntouchedCheckpoints = 6,
): SetupDirective | undefined {
  if (item.status === "paid_off" || item.status === "dropped") {
    return undefined;
  }
  const payoffMissing = item.intendedPayoff === undefined;
  const lastTouched =
    item.lastTouchedAtCheckpoint ?? item.seededAtCheckpoint ?? checkpoint;
  // Timeline fields are checkpoint units (narrative beats), so the age
  // math below is unit-consistent (audit finding 3).
  const age = checkpoint - lastTouched;
  if (age >= maxUntouchedCheckpoints) {
    return {
      id: item.id,
      action: "resolve_or_drop",
      urgency: "overdue",
      premise: item.setup,
      ...(payoffMissing ? { payoffMissing: true } : {}),
    };
  }
  // 前置未满足：只能 hold——不得在玩家尚未触发前置前强化/兑现（audit P1-4）。
  if (!prerequisitesSatisfied) {
    return {
      id: item.id,
      action: "hold",
      urgency: "normal",
      premise: item.setup,
      ...(payoffMissing ? { payoffMissing: true } : {}),
    };
  }
  if (
    item.payoffBeforeAnchor !== undefined &&
    item.payoffBeforeAnchor === currentAnchorId &&
    (item.status === "seeded" ||
      item.status === "reinforced" ||
      item.status === "ready")
  ) {
    // depth 门控（§8.1）：heavy 且 reinforcementCount < 2 → 积累不足不回收。
    const underAccumulated = item.depth === "heavy" && item.reinforcementCount < 2;
    if (!underAccumulated) {
      const directive: SetupDirective = {
        id: item.id,
        action: "payoff",
        urgency: "now",
        premise: item.setup,
      };
      if (item.intendedPayoff !== undefined) {
        directive.payoff = item.intendedPayoff;
      }
      if (payoffMissing) {
        directive.payoffMissing = true;
      }
      return directive;
    }
    // 改发 reinforce（validator 只接受 seeded|reinforced）；ready 无法 reinforce
    // → hold 观望，宁可不指令也不发会被拒的指令。
    if (item.status === "seeded" || item.status === "reinforced") {
      return {
        id: item.id,
        action: "reinforce",
        urgency: "now",
        premise: item.setup,
        ...(payoffMissing ? { payoffMissing: true } : {}),
      };
    }
    return {
      id: item.id,
      action: "hold",
      urgency: "normal",
      premise: item.setup,
      ...(payoffMissing ? { payoffMissing: true } : {}),
    };
  }
  if (item.status === "seeded") {
    if (age >= 2) {
      return {
        id: item.id,
        action: "reinforce",
        urgency: "soon",
        premise: item.setup,
        ...(payoffMissing ? { payoffMissing: true } : {}),
      };
    }
  }
  return {
    id: item.id,
    action: "hold",
    urgency: "normal",
    premise: item.setup,
    ...(payoffMissing ? { payoffMissing: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// C8 §6.2 — shared identity validation core (campus / main 共用形状)
//
// 记忆请求显式携带 registry 身份视图与证据；校验返回 ValidatedProposal
// （accepted + 空 issues / rejected + IdentityValidationIssue[]），绝不静默
// 过滤。M2 的 main 侧在同一视图上扩展 fact/belief 引用集与 belief 获知
// 来源（KNOWLEDGE_NOT_SUPPORTED 复用），不改变本节函数契约。
// ---------------------------------------------------------------------------

/**
 * §6.2 记忆身份视图：一次提案校验的全部身份权威。
 *
 * - campus：由 NarrativeConsolidatorAdapter 从 registry + 请求证据构造，
 *   随 ConsolidationResult 返回，供消费方用同一视图校验；
 * - main（M2）：请求侧直接携带（§6.2 “main 请求必须携带…允许角色及
 *   evidence 范围”），并扩展 fact/belief 引用集。
 */
export interface MemoryIdentityView {
  /** 校验时的 roster revision（审计溯源）。 */
  rosterRevision: string;
  /** 全体已注册角色稳定 ID（含玩家）。 */
  knownCharacterIds: ReadonlySet<CharacterId>;
  /**
   * 显示名 → 同名角色 ID 列表（name 与 initialLabel 都入表）。仅供诊断
   * 提示与定向修复——绝不用作反向解析：同名两角色的显示名映射到两个
   * ID，校验时任何显示名标签一律 UNKNOWN_CHARACTER_ID，绝不择一合并。
   */
  charactersByDisplayName: ReadonlyMap<string, readonly CharacterId[]>;
  /**
   * 本提案允许引用的角色（§6.2 允许角色 ∪ 证据登场）。空集合严格为空：
   * 任何角色标签都会被拒，绝不退化为“全部注册角色可用”。
   */
  allowedCharacterIds: ReadonlySet<CharacterId>;
  /** 证据事件中实际登场的角色 ID（场景参与获知依据）。 */
  evidenceCharacterIds: ReadonlySet<CharacterId>;
  /** 证据事件 seq 区间（已提交，含端点）；undefined = 无证据约束（legacy）。 */
  evidenceSeqRange: { min: number; max: number } | undefined;
  /**
   * 地点权威集合；undefined = 无地点权威（场景地点未知，显式 legacy——
   * 不是“空集合”，不校验地点标签）。
   */
  canonicalLocations: ReadonlySet<string> | undefined;
}

/** §6.2 accepted 构造子：合法提案（含合法空提案 = no-op）。 */
export function acceptedProposal<T>(value: T): ValidatedProposal<T> {
  return { status: "accepted", value, issues: [] };
}

/** §6.2 rejected 构造子：身份/引用非法——不是 no-op，也不伪装成空成功。 */
export function rejectedProposal<T>(
  issues: readonly IdentityValidationIssue[],
): ValidatedProposal<T> {
  return { status: "rejected", issues: [...issues] };
}

/**
 * 校验角色标签列表（episode.characters 等）。
 *
 * - 标签不是注册表稳定 ID（含显示名误填、未知 ID）→ UNKNOWN_CHARACTER_ID；
 * - 已注册但既不在允许集合也无证据登场 → KNOWLEDGE_NOT_SUPPORTED
 *   （main 的 belief 获知校验复用本 code）；
 * - 允许集合为空时严格为空：任何标签都被拒。
 * 每个违规标签独立成条（path 带下标、value 为原值），不掩盖后续错误。
 */
export function validateCharacterTags(
  tags: readonly string[],
  view: MemoryIdentityView,
  basePath: string,
): IdentityValidationIssue[] {
  const issues: IdentityValidationIssue[] = [];
  tags.forEach((tag, index) => {
    if (!view.knownCharacterIds.has(tag)) {
      issues.push({
        code: "UNKNOWN_CHARACTER_ID",
        path: `${basePath}[${index}]`,
        value: tag,
      });
      return;
    }
    if (
      !view.allowedCharacterIds.has(tag) &&
      !view.evidenceCharacterIds.has(tag)
    ) {
      issues.push({
        code: "KNOWLEDGE_NOT_SUPPORTED",
        path: `${basePath}[${index}]`,
        value: tag,
      });
    }
  });
  return issues;
}

/**
 * 校验证据事件引用（setupOps[].evidenceEventIds）：每个引用必须是整数
 * seq 且落在已提交区间 [min, max] 内。越界/非数字 → EVIDENCE_OUT_OF_RANGE。
 * 区间缺席（legacy，无证据权威）不校验。
 */
export function validateEvidenceRefs(
  refs: readonly string[],
  view: MemoryIdentityView,
  basePath: string,
): IdentityValidationIssue[] {
  const range = view.evidenceSeqRange;
  if (range === undefined) {
    return [];
  }
  const issues: IdentityValidationIssue[] = [];
  refs.forEach((ref, index) => {
    const seq = Number(ref);
    if (!Number.isInteger(seq) || seq < range.min || seq > range.max) {
      issues.push({
        code: "EVIDENCE_OUT_OF_RANGE",
        path: `${basePath}[${index}]`,
        value: ref,
      });
    }
  });
  return issues;
}

/**
 * 校验引用标签（episode.threads/setups/locations）：必须存在于权威集合。
 * knownIds 为 undefined 表示无权威（legacy，不校验）；空集合则每个标签
 * 都是 INVALID_REFERENCE——空集合不退化为不限。
 */
export function validateReferenceTags(
  tags: readonly string[],
  knownIds: ReadonlySet<string> | undefined,
  basePath: string,
): IdentityValidationIssue[] {
  if (knownIds === undefined) {
    return [];
  }
  const issues: IdentityValidationIssue[] = [];
  tags.forEach((tag, index) => {
    if (!knownIds.has(tag)) {
      issues.push({
        code: "INVALID_REFERENCE",
        path: `${basePath}[${index}]`,
        value: tag,
      });
    }
  });
  return issues;
}

/**
 * 角色标签的人类可读诊断（只用于 RejectedOp.reason / 定向修复提示）。
 * 显示名命中时列出全部同名候选——绝不择一，也绝不据此放行标签。
 */
export function describeCharacterTag(
  tag: string,
  view: MemoryIdentityView,
): string {
  const sameName = view.charactersByDisplayName.get(tag);
  if (sameName !== undefined && sameName.length > 0) {
    return (
      `UNKNOWN_CHARACTER_ID：${JSON.stringify(tag)} 是显示名，不是稳定 ID` +
      `（同名角色：${sameName.join("、")}——同名绝不合并，请改用稳定 ID）`
    );
  }
  return `UNKNOWN_CHARACTER_ID：${JSON.stringify(tag)} 不是注册表稳定 ID`;
}

/**
 * 把 §6.2 issues 渲染成单条 reason 字符串（RejectedOp.reason 用）。
 * 角色类问题附带显示名诊断，便于“最多 1 次定向修复”。
 */
export function formatIdentityIssues(
  issues: readonly IdentityValidationIssue[],
  view: MemoryIdentityView | undefined,
): string {
  return issues
    .map((issue) => {
      if (issue.code === "UNKNOWN_CHARACTER_ID" && view !== undefined) {
        return `${issue.path}：${describeCharacterTag(issue.value, view)}`;
      }
      return `${issue.path}=${issue.value}（${issue.code}）`;
    })
    .join("；");
}

/**
 * §6.2 身份视图构造（main：请求侧，campus 的对等物在 adapter 内构造后
 * 随 ConsolidationResult 回传）：
 * - 允许集合 = 证据登场角色 ∪（场景名单 ∩ 注册表）——场景名单中的非
 *   注册表字符串是 legacy 残留，只在此处做请求侧归一（不影响提案校验
 *   的严格性）；
 * - 显示名表（name/initialLabel → 同名 ID 列表）仅供诊断提示，绝不
 *   反向解析；
 * - 证据区间 = [1, 本批最后已提交 seq]；
 * - 地点权威：场景地点非空才有（空字符串 = 无权威，不是“空集合”）。
 *
 * M2 扩展点：main 的 fact/belief 引用集与 belief 获知来源在同一视图上
 * 扩展（KNOWLEDGE_NOT_SUPPORTED 复用），不改变本函数与校验函数契约。
 */
export function buildMemoryIdentityView(input: {
  events: readonly StoredEvent[];
  registry: CharacterRegistry;
  stateCharacters: readonly string[];
  stateLocation: string;
  /** 预先算好的记忆证据投影（同一批 events + registry）；缺席则现算。 */
  evidence?: readonly ProjectedEvent[];
}): MemoryIdentityView {
  const { registry } = input;
  const evidence =
    input.evidence ?? projectMemoryEvidence(input.events, registry);

  const evidenceCharacterIds = new Set<CharacterId>();
  for (const event of evidence) {
    if (event.characterId !== undefined) {
      evidenceCharacterIds.add(event.characterId);
    }
  }
  const allowedCharacterIds = new Set<CharacterId>(evidenceCharacterIds);
  for (const id of input.stateCharacters) {
    if (registry.get(id) !== undefined) {
      allowedCharacterIds.add(id);
    }
  }

  const charactersByDisplayName = new Map<string, CharacterId[]>();
  for (const definition of registry.roster.characters) {
    for (const label of [definition.name, definition.initialLabel]) {
      const ids = charactersByDisplayName.get(label) ?? [];
      if (!ids.includes(definition.id)) {
        ids.push(definition.id);
      }
      charactersByDisplayName.set(label, ids);
    }
  }

  let maxSeq = 0;
  for (const event of input.events) {
    if (event.seq > maxSeq) {
      maxSeq = event.seq;
    }
  }

  return {
    rosterRevision: registry.roster.revision,
    knownCharacterIds: new Set(
      registry.roster.characters.map((definition) => definition.id),
    ),
    charactersByDisplayName,
    allowedCharacterIds,
    evidenceCharacterIds,
    evidenceSeqRange: { min: 1, max: maxSeq },
    canonicalLocations:
      input.stateLocation !== "" ? new Set([input.stateLocation]) : undefined,
  };
}
