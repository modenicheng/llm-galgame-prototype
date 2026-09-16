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
  /**
   * Event mode（audit P2-10）：强制收束段。该段必须以 @end ending 收束；
   * 以 buffer / interaction 收束时按 forcedEndingRetries 预算重试或由
   * 运行时合成结局（防无限循环）。
   */
  endingRequired: boolean;
}

export type ActiveSegmentKind = "opening" | "continuation";

export interface ChoiceOutcome {
  type: "choice";
  nextTurn: number;
  preview: RuntimePlayableEvent[];
  liveSelection?: LiveBranchSelection;
  /** Response stream still running after input confirm (live promotion). */
  liveResponse?: InputResponseSession;
}

export type ChoiceSelection = Pick<ChoiceOutcome, "preview" | "liveSelection">;

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

export type SegmentOutcome = ChoiceOutcome | EndOutcome | BufferOutcome;
