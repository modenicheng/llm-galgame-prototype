import {
  DslProtocolError,
  type AnyDslLine,
  type AnyEventGroupDraft,
  type DslLine,
  type DslLineV2,
  type DslSegmentResult,
  type EventGroupDraft,
  type EventGroupDraftV2,
  type SegmentEndReason,
  type SegmentEndingEpilogue,
} from "./types.js";
import { EventGroupBuilder, EventGroupBuilderV2 } from "./group-builder.js";
import { interpretEndingEpilogue } from "./line-parser.js";

/**
 * Top of the parse pipeline (docs §40, §44–§51, §103). Owns the generation
 * sentinel: only a matching `@end <nonce> <reason>` marks a segment complete.
 * Content before the sentinel is pushed into the EventGroupBuilder; the
 * sentinel line itself never reaches the builder (docs §44).
 *
 * ending 哨兵之后有一格「epilogue 窗口」：窗口内至多收一行 `@ending`（结局
 * 元数据），窗口一旦关闭（已捕获或遇到其他行）后续内容全部静默丢弃——结局
 * 元数据永远不炸段，也不触发 LLM 修复轮。buffer/interaction 哨兵后仍保持
 * 原有的 SENTINEL_NOT_LAST 严格行为。
 *
 * C4 起哨兵/窗口状态机对 v1/v2 通用（收尾协议共享，两版语义不漂移）：
 * 基类承载全部哨兵逻辑，DslSegmentParser（v1，行为冻结）与
 * DslSegmentParserV2 只是换掉组构造器与行类型。哨兵/结局行的形状在两个
 * 版本里逐字段相同，这里以 AnyDslLine 收窄后处理；进入组构造器前才回到
 * 版本各自的行类型（实例的 sink 与实例的行版本恒一致）。
 */

/** 哨兵状态机驱动的组构造器（v1/v2 builder 的公共面）。 */
interface SegmentGroupSink<L extends AnyDslLine, G extends AnyEventGroupDraft> {
  push(line: L): G[];
  hasOpenInteraction(): boolean;
}

abstract class DslSegmentParserBase<L extends AnyDslLine, G extends AnyEventGroupDraft> {
  protected abstract readonly sink: SegmentGroupSink<L, G>;

  private readonly expectedNonce: string;
  private readonly allowedReasons: readonly SegmentEndReason[];
  protected groups: G[] = [];
  private sentinel: { nonce: string; reason: SegmentEndReason } | null = null;
  /** "idle" 哨兵未到；"open" ending 哨兵已到正在收 @ending；"done" 窗口已关闭。 */
  private epilogueState: "idle" | "open" | "done" = "idle";
  private epilogue: SegmentEndingEpilogue | undefined;

  constructor(options: { expectedNonce: string; allowedReasons: readonly SegmentEndReason[] }) {
    this.expectedNonce = options.expectedNonce;
    this.allowedReasons = options.allowedReasons;
  }

  hasOpenInteraction(): boolean {
    return this.sink.hasOpenInteraction();
  }

  /**
   * Explicitly finish the currently open form. The streaming adapter uses
   * this only immediately before a valid `interaction` sentinel, so normal
   * parser callers remain strict and invalid/empty forms still throw.
   */
  closeOpenInteraction(): G[] {
    // form_end 行在 v1/v2 两个行联合里同形（{ kind: "form_end" }）。
    return this.pushLine({ kind: "form_end" } as L);
  }

  pushLine(line: L): G[] {
    if (line.kind === "segment_end") {
      return this.pushSegmentEnd(line.nonce, line.reason);
    }

    if (this.sentinel !== null) {
      if (this.sentinel.reason !== "ending") {
        throw new DslProtocolError(
          "SENTINEL_NOT_LAST",
          "@end 之后还有内容。哨兵必须是本段最后一行。",
          {
            fix: "删除 @end 之后的全部内容；如果剧情还没写完，把 @end 挪到本段真正的结尾",
          },
        );
      }
      // ending 哨兵后的 epilogue 窗口：收一行 @ending，任何后续行关窗。
      if (this.epilogueState === "open") {
        this.epilogueState = "done";
        if (line.kind === "ending_epilogue") {
          this.epilogue = interpretEndingEpilogue(line.raw, this.expectedNonce);
        }
        // 其余一切（含重复 @ending 前的第一条杂行）静默丢弃：结局已定，
        // 元数据之后的模型残留不播放、不报错、不烧修复预算。
      }
      return [];
    }

    if (line.kind === "ending_epilogue") {
      // 哨兵前出现 @ending：几乎总是模型把 @end 误写成 @ending 的信号，
      // 响亮报错交给 strip-continue 剔除续写（C6 起协议卡已教 @ending——
      // 合法位置是 @end <nonce> ending 哨兵之后；本分支拦的是越位/误写
      // 形态，不再是「协议不教 @ending」时期的惰性防御）。
      throw new DslProtocolError(
        "ENDING_EPILOGUE_ORPHAN",
        `@ending 出现的位置不合法（只能紧跟在 @end <nonce> ending 哨兵之后）："@ending ${line.raw}"。`,
        {
          expected: "@end <nonce> ending 换行 @ending <档位> <结尾词>",
          cause: "在哨兵之前写了 @ending，或本段不是 ending 结局",
          fix: "若故事要结束，先输出 @end <nonce> ending，再另起一行写 @ending <档位> <结尾词>（档位 TE|HE|NE|BE）；否则删除 @ending 行继续写正文",
        },
      );
    }

    // 实例的 sink 与实例的行版本恒一致（v1 sink 只会收到 v1 行）。
    const emitted = this.sink.push(line as unknown as L);
    this.groups.push(...emitted);
    return emitted;
  }

  private pushSegmentEnd(nonce: string, reason: SegmentEndReason): G[] {
    if (this.sentinel !== null) {
      if (this.sentinel.reason === "ending") {
        // ending 哨兵后的第二条 @end 与窗口内其他残留同权：静默丢弃，
        // 不抛 SENTINEL_DUPLICATE（结局已定，不值得烧一轮修复）。
        this.epilogueState = "done";
        return [];
      }
      throw new DslProtocolError(
        "SENTINEL_DUPLICATE",
        "段已经用 @end 结束过，哨兵只能出现一次。",
        { fix: "删除多余的 @end 行；@end 之后不得再输出任何内容" },
      );
    }
    if (nonce !== this.expectedNonce) {
      throw new DslProtocolError(
        "SENTINEL_NONCE_MISMATCH",
        `哨兵 nonce ${nonce} 与本次任务要求的 ${this.expectedNonce} 不一致。`,
        {
          expected: `@end ${this.expectedNonce} <reason>（nonce 原样照抄任务提示，不得编造）`,
          fix: `把 nonce 改为 ${this.expectedNonce}`,
        },
      );
    }
    if (!this.allowedReasons.includes(reason)) {
      throw new DslProtocolError(
        "SENTINEL_INVALID_REASON",
        `哨兵 reason ${reason} 不属于本次任务允许的取值（allowed: ${this.allowedReasons.join(", ")}）。`,
        {
          expected: `@end ${nonce} ${this.allowedReasons.join("|")}`,
          fix: `把 reason 改为 ${this.allowedReasons.join("、")} 之一`,
        },
      );
    }
    if (this.sink.hasOpenInteraction()) {
      // An unclosed form would be silently dropped with the pending
      // builder state: the player would never see the interaction while
      // the segment is marked complete (design: 收尾协议 §有限自动修复).
      // The streaming adapter closes a finishable form BEFORE pushing an
      // interaction sentinel, so this only fires on genuinely malformed
      // output.
      throw new DslProtocolError(
        "FORM_OPEN_AT_SENTINEL",
        "交互表单尚未用 @/? 闭合就用 @end 收尾，表单内容会整段丢失。",
        {
          expected: "@/? 换行 @end <nonce> <reason>",
          fix: '先补一行 @/? 闭合当前表单再输出 @end；若本段确实要交给玩家操作，把 reason 改为 "interaction"',
        },
      );
    }
    this.sentinel = { nonce, reason };
    // 仅 ending 哨兵打开 epilogue 窗口；其余 reason 直接视为已关闭。
    this.epilogueState = reason === "ending" ? "open" : "done";
    return [];
  }

  /**
   * True when the ending epilogue window has settled — the `@ending` line
   * was captured or the window closed on any other line. The streaming
   * adapter stops consuming the model's output once this fires after an
   * ending sentinel: whatever follows is discarded residue.
   */
  isEndingSettled(): boolean {
    return this.sentinel?.reason === "ending" && this.epilogueState === "done";
  }

  finish(): { groups: G[]; status: DslSegmentResult["status"] } {
    return { groups: this.groups, status: this.finishStatus() };
  }

  private finishStatus(): DslSegmentResult["status"] {
    if (this.sentinel === null) {
      // Truncated segment: committed groups survive; the pending tail and
      // any open form live inside the builder and are dropped (docs §50).
      return { kind: "incomplete" };
    }
    const status: DslSegmentResult["status"] = {
      kind: "complete",
      nonce: this.sentinel.nonce,
      reason: this.sentinel.reason,
    };
    if (this.sentinel.reason === "ending" && this.epilogue !== undefined) {
      status.epilogue = this.epilogue;
    }
    return status;
  }
}

/** v1 段解析器（行为冻结；见 DslSegmentParserBase 的共享哨兵状态机）。 */
export class DslSegmentParser extends DslSegmentParserBase<DslLine, EventGroupDraft> {
  protected readonly sink: SegmentGroupSink<DslLine, EventGroupDraft> = new EventGroupBuilder();
}

/** v2 段解析器：同一哨兵/epilogue 状态机 + v2 组构造器。 */
export class DslSegmentParserV2 extends DslSegmentParserBase<DslLineV2, EventGroupDraftV2> {
  protected readonly sink: SegmentGroupSink<DslLineV2, EventGroupDraftV2> =
    new EventGroupBuilderV2();
}
