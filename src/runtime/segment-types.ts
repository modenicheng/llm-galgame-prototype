/**
 * 段生命周期类型（执行清单 M4.5：自 game.ts 迁出，Game 与
 * InteractionDriver 共用）。纯类型。
 */
import type { AsyncEventQueue } from "../core/runtime/async-event-queue.js";
import type { SegmentEndStatus } from "../core/protocol/gal-dsl/types.js";
import type { BranchManager } from "./branch-manager.js";
import type { RuntimeModelEvent, RuntimePlayableEvent } from "../schema.js";
import type { InputResponseSession } from "../core/interaction/input-session.js";
import type { LiveBranchSelection } from "./prefetch.js";
import type { RestorePoint } from "../core/ports/run-graph-port.js";

export interface ActiveSegment {
  turn: number;
  taskId: string;
  events: RuntimeModelEvent[];
  queue: AsyncEventQueue<RuntimeModelEvent>;
  done: Promise<void>;
  branchManager: BranchManager | null;
  terminal: RuntimeModelEvent | null;
  schedulerReleased: boolean;
  /**
   * DSL mode: set when the segment ends cleanly with `@end ... buffer`
   * (docs §46/§76). A clean buffer end is NOT a failure.
   */
  endStatus: SegmentEndStatus | null;
  /**
   * Set when the segment's generation task settles with a rejection
   * (segment.done rejected). The advance-trigger must not start a low-water
   * refill while the current segment has failed — the repair path is about
   * to take over the single-slot generation scheduler, and a concurrent
   * refill would make startActivePath throw and kill run() (and waste a
   * generation call).
   */
  failed: boolean;
}

export type ActiveSegmentKind = "opening" | "continuation";

export interface ChoiceOutcome {
  type: "choice";
  nextTurn: number;
  preview: RuntimePlayableEvent[];
  liveSelection?: LiveBranchSelection;
  /** Response stream still running after input confirm (live promotion). */
  liveResponse?: InputResponseSession;
  /**
   * M5.3 同选项快进命中：选择与既有出边一致 → 跳过生成，Game 直接恢复
   * 后继节点表单（restore 由驱动器从宿主取走后随结果上交运行循环）。
   */
  fastForward?: RestorePoint;
}

export type ChoiceSelection = Pick<ChoiceOutcome, "preview" | "liveSelection"> & {
  /** M5.3：快进命中时的恢复点；非空时 preview 为空、无任何生成分支。 */
  fastForward?: RestorePoint;
};

/**
 * Result of committing an input: the committed prefix plus optional live
 * stream, or — hybrid only — a preview-cancel sentinel that returns control
 * to the hybrid loop so the full form (options + input) stays armed (§11.7).
 */
export type InputCommitOutcome =
  | {
      type: "committed";
      preview: RuntimePlayableEvent[];
      liveResponse?: InputResponseSession;
      /** M5.3：快进命中（与既有出边文本一致）→ 零生成，恢复后继表单。 */
      fastForward?: RestorePoint;
    }
  | { type: "canceled" };

/** Structural contract for live-consumable streams. */
export interface LiveStreamLike {
  events: readonly RuntimePlayableEvent[];
  done: Promise<unknown>;
  subscribe(listener: (event: RuntimePlayableEvent) => void): () => void;
}

export interface EndOutcome {
  type: "end";
}

/**
 * DSL mode: the segment ended cleanly with `@end ... buffer` — no terminal
 * event, the story simply pauses for a low-water refill (docs §46, §76).
 */
export interface BufferOutcome {
  type: "buffer";
  nextTurn: number;
}

/** M5.3 同选项快进：零生成，运行循环据此切换到后继节点的恢复表单。 */
export interface FastForwardOutcome {
  type: "fast_forward";
  restore: RestorePoint;
  nextTurn: number;
}

export type SegmentOutcome = ChoiceOutcome | EndOutcome | BufferOutcome | FastForwardOutcome;
