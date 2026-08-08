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

  pushLine(line: DslLine): EventGroupDraft[] {
    if (line.kind === "segment_end") {
      if (this.sentinel !== null) {
        throw new DslProtocolError(
          "SENTINEL_DUPLICATE",
          "Duplicate @end sentinel. The segment is already complete.",
        );
      }
      if (line.nonce !== this.expectedNonce) {
        throw new DslProtocolError(
          "SENTINEL_NONCE_MISMATCH",
          `Sentinel nonce ${line.nonce} does not match the expected ${this.expectedNonce}.`,
        );
      }
      if (!this.allowedReasons.includes(line.reason)) {
        throw new DslProtocolError(
          "SENTINEL_INVALID_REASON",
          `Sentinel reason ${line.reason} is not allowed for this segment (allowed: ${this.allowedReasons.join(", ")}).`,
        );
      }
      this.sentinel = { nonce: line.nonce, reason: line.reason };
      return [];
    }

    if (this.sentinel !== null) {
      throw new DslProtocolError(
        "SENTINEL_NOT_LAST",
        "Content after @end. The sentinel must be the final line of the segment.",
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
