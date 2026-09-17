import {
  DslProtocolError,
  type DslLine,
  type DslSegmentResult,
  type EventGroupDraft,
  type SegmentEndReason,
} from "./types.js";
import { EventGroupBuilder } from "./group-builder.js";

/**
 * Top of the parse pipeline (docs §40, §44–§51, §103). Owns the generation
 * sentinel: only a matching `@end <nonce> <reason>` marks a segment complete.
 * Content before the sentinel is pushed into the EventGroupBuilder; the
 * sentinel line itself never reaches the builder (docs §44).
 */
export class DslSegmentParser {
  private readonly expectedNonce: string;
  private readonly allowedReasons: readonly SegmentEndReason[];
  private readonly builder = new EventGroupBuilder();
  private groups: EventGroupDraft[] = [];
  private sentinel: { nonce: string; reason: SegmentEndReason } | null = null;

  constructor(options: { expectedNonce: string; allowedReasons: readonly SegmentEndReason[] }) {
    this.expectedNonce = options.expectedNonce;
    this.allowedReasons = options.allowedReasons;
  }

  hasOpenInteraction(): boolean {
    return this.builder.hasOpenInteraction();
  }

  /**
   * Explicitly finish the currently open form. The streaming adapter uses
   * this only immediately before a valid `interaction` sentinel, so normal
   * parser callers remain strict and invalid/empty forms still throw.
   */
  closeOpenInteraction(): EventGroupDraft[] {
    return this.pushLine({ kind: "form_end" });
  }

  pushLine(line: DslLine): EventGroupDraft[] {
    if (line.kind === "segment_end") {
      if (this.sentinel !== null) {
        throw new DslProtocolError(
          "SENTINEL_DUPLICATE",
          "段已经用 @end 结束过，哨兵只能出现一次。",
          { fix: "删除多余的 @end 行；@end 之后不得再输出任何内容" },
        );
      }
      if (line.nonce !== this.expectedNonce) {
        throw new DslProtocolError(
          "SENTINEL_NONCE_MISMATCH",
          `哨兵 nonce ${line.nonce} 与本次任务要求的 ${this.expectedNonce} 不一致。`,
          {
            expected: `@end ${this.expectedNonce} <reason>（nonce 原样照抄任务提示，不得编造）`,
            fix: `把 nonce 改为 ${this.expectedNonce}`,
          },
        );
      }
      if (!this.allowedReasons.includes(line.reason)) {
        throw new DslProtocolError(
          "SENTINEL_INVALID_REASON",
          `哨兵 reason ${line.reason} 不属于本次任务允许的取值（allowed: ${this.allowedReasons.join(", ")}）。`,
          {
            expected: `@end ${line.nonce} ${this.allowedReasons.join("|")}`,
            fix: `把 reason 改为 ${this.allowedReasons.join("、")} 之一`,
          },
        );
      }
      this.sentinel = { nonce: line.nonce, reason: line.reason };
      return [];
    }

    if (this.sentinel !== null) {
      throw new DslProtocolError(
        "SENTINEL_NOT_LAST",
        "@end 之后还有内容。哨兵必须是本段最后一行。",
        {
          fix: "删除 @end 之后的全部内容；如果剧情还没写完，把 @end 挪到本段真正的结尾",
        },
      );
    }

    const emitted = this.builder.push(line);
    this.groups.push(...emitted);
    return emitted;
  }

  finish(): DslSegmentResult {
    if (this.sentinel === null) {
      // Truncated segment: committed groups survive; the pending tail and
      // any open form live inside the builder and are dropped (docs §50).
      return { groups: this.groups, status: { kind: "incomplete" } };
    }
    return {
      groups: this.groups,
      status: { kind: "complete", nonce: this.sentinel.nonce, reason: this.sentinel.reason },
    };
  }
}
