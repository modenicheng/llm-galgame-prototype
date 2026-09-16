/**
 * Pure validation rules for narrative-memory operations (narrative
 * director, Task 5).
 *
 * No IO, no classes — every function is a total pure function returning
 * `string | null` (null = accept). Reason strings are human-readable
 * Chinese diagnostics recorded via `RejectedOp` by later tasks.
 */

import { VALID_THREAD_TRANSITIONS } from "../../core/narrative/memory-types.js";

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
} from "../../core/narrative/memory-operation.js";
import type { SetupDirective } from "../../core/narrative/director-plan.js";
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
