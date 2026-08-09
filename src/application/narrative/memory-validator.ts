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
} from "../../core/narrative/memory-types.js";
import type {
  ThreadOp,
  SetupOp,
  EpisodeSummaryOp,
} from "../../core/narrative/memory-operation.js";
import type { SetupDirective } from "../../core/narrative/narrative-brief.js";
import type { NarrativeConfig } from "../../config.js";

/** Thread statuses that count as "active" for the major-thread budget. */
const ACTIVE_THREAD_STATUSES: ReadonlySet<PlotThread["status"]> = new Set([
  "open",
  "developing",
  "ready_to_resolve",
]);

/** Setup statuses that count as "active" for the setup budget. */
const ACTIVE_SETUP_STATUSES: ReadonlySet<SetupPayoff["status"]> = new Set([
  "seeded",
  "reinforced",
  "ready",
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
        return `线程 ${op.id} 已存在，不能重复创建`;
      }
      let activeMajor = 0;
      for (const thread of Object.values(memory.threads)) {
        if (
          thread.importance === "major" &&
          ACTIVE_THREAD_STATUSES.has(thread.status)
        ) {
          activeMajor += 1;
        }
      }
      if (activeMajor >= config.threads.max_major_active) {
        return `活跃 major 线程数 ${activeMajor} 已达上限 ${config.threads.max_major_active}`;
      }
      return null;
    }
    case "touch": {
      if (existing === undefined) {
        return `线程 ${op.id} 不存在`;
      }
      return null;
    }
    case "advance": {
      if (existing === undefined) {
        return `线程 ${op.id} 不存在`;
      }
      if (VALID_THREAD_TRANSITIONS[existing.status].length === 0) {
        return `线程 ${op.id} 当前状态 ${existing.status} 为终态，无法 advance`;
      }
      return null;
    }
    case "resolve": {
      if (existing === undefined) {
        return `线程 ${op.id} 不存在`;
      }
      if (existing.status === "resolved" || existing.status === "abandoned") {
        return `线程 ${op.id} 当前状态 ${existing.status} 为终态，无法 resolve`;
      }
      return null;
    }
    case "abandon": {
      if (existing === undefined) {
        return `线程 ${op.id} 不存在`;
      }
      if (existing.status === "resolved" || existing.status === "abandoned") {
        return `线程 ${op.id} 当前状态 ${existing.status} 为终态，无法 abandon`;
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
): string | null {
  const existing = memory.setups[op.id];

  switch (op.type) {
    case "seed": {
      if (existing === undefined) {
        return `伏笔 ${op.id} 不存在`;
      }
      if (existing.status !== "planned") {
        return `伏笔 ${op.id} 状态为 ${existing.status}，只有 planned 可以 seed`;
      }
      let active = 0;
      for (const setup of Object.values(memory.setups)) {
        if (ACTIVE_SETUP_STATUSES.has(setup.status)) {
          active += 1;
        }
      }
      if (active >= config.setups.max_active) {
        return `活跃伏笔数 ${active} 已达上限 ${config.setups.max_active}`;
      }
      return null;
    }
    case "reinforce": {
      if (existing === undefined) {
        return `伏笔 ${op.id} 不存在`;
      }
      if (existing.status !== "seeded" && existing.status !== "reinforced") {
        return `伏笔 ${op.id} 状态为 ${existing.status}，只有 seeded|reinforced 可以 reinforce`;
      }
      return null;
    }
    case "payoff": {
      if (existing === undefined) {
        return `伏笔 ${op.id} 不存在`;
      }
      if (existing.status !== "reinforced" && existing.status !== "ready") {
        return `伏笔 ${op.id} 状态为 ${existing.status}，只有 reinforced|ready 可以 payoff`;
      }
      return null;
    }
    case "drop": {
      if (existing === undefined) {
        return `伏笔 ${op.id} 不存在`;
      }
      if (existing.status === "paid_off" || existing.status === "dropped") {
        return `伏笔 ${op.id} 当前状态 ${existing.status} 为终态，无法 drop`;
      }
      return null;
    }
    case "hold": {
      if (existing === undefined) {
        return `伏笔 ${op.id} 不存在`;
      }
      return null;
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

/**
 * Validate an episode summary op: non-empty summary ≤ 200 chars, every
 * array field free of empty elements and ≤ 20 unique entries.
 * Returns null when the op may be applied, otherwise a rejection reason.
 */
export function validateEpisodeOp(op: EpisodeSummaryOp): string | null {
  if (op.summary.length === 0) {
    return "episode summary 不能为空";
  }
  if (op.summary.length > 200) {
    return `episode summary 长度 ${op.summary.length} 超过上限 200`;
  }
  for (const field of EPISODE_ARRAY_FIELDS) {
    const values = op[field];
    if (values.some((value) => value.length === 0)) {
      return `episode ${field} 含空字符串元素`;
    }
    if (new Set(values).size > 20) {
      return `episode ${field} 去重后元素数 ${new Set(values).size} 超过上限 20`;
    }
  }
  return null;
}

/**
 * Decide the directive for one setup at a checkpoint.
 * - paid_off/dropped → undefined (no directive)
 * - payoffBeforeAnchor matches the current anchor → payoff now
 * - seeded and untouched for ≥ 2 checkpoints → reinforce soon
 * - otherwise → hold (normal urgency)
 */
export function classifySetup(
  item: SetupPayoff,
  checkpoint: number,
  currentAnchorId: string | undefined,
): SetupDirective | undefined {
  if (item.status === "paid_off" || item.status === "dropped") {
    return undefined;
  }
  if (
    item.payoffBeforeAnchor !== undefined &&
    item.payoffBeforeAnchor === currentAnchorId
  ) {
    return { id: item.id, action: "payoff", urgency: "now" };
  }
  if (item.status === "seeded") {
    const lastTouched = item.lastTouchedAt ?? item.seededAt ?? checkpoint;
    if (checkpoint - lastTouched >= 2) {
      return { id: item.id, action: "reinforce", urgency: "soon" };
    }
  }
  return { id: item.id, action: "hold", urgency: "normal" };
}
