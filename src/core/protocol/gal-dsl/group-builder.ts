import {
  DslProtocolError,
  type DslInteractionDraft,
  type DslLine,
  type EventGroupDraft,
} from "./types.js";
import { InteractionBuilder } from "./interaction-builder.js";
import type { StageCue } from "../../presentation/types.js";

/**
 * Assembles EventGroupDrafts from DslLines (docs §36–§39, §43). Stage cues
 * accumulate in `pendingCues` until a main event (dialogue / narration /
 * completed form / beat) flushes them into one group. An open form (`?` …
 * `/?`) swallows every cue line into its pending prelude until form_end.
 *
 * The segment validator is the only production caller and filters out
 * `segment_end` lines before they reach this builder (docs §44).
 */
export class EventGroupBuilder {
  private pendingCues: StageCue[] = [];
  private interaction: InteractionBuilder | null = null;

  hasOpenInteraction(): boolean {
    return this.interaction?.isOpen() === true;
  }

  push(line: DslLine): EventGroupDraft[] {
    switch (line.kind) {
      case "background":
      case "bgm":
      case "sound_effect":
        this.pendingCues.push({ type: line.kind, assetId: line.assetId });
        return [];

      case "character_cue":
        this.pendingCues.push(this.characterCue(line));
        return [];

      case "dialogue":
        this.assertNoOpenForm();
        return this.flush({
          type: "dialogue",
          speaker: line.speaker,
          text: line.text,
          visual: line.visual,
          name: line.name,
        });

      case "narration":
        this.assertNoOpenForm();
        return this.flush({ type: "narration", text: line.text });

      case "form_start":
        if (this.interaction !== null) {
          throw new DslProtocolError(
            "FORM_ALREADY_OPEN",
            "前一个交互表单还没有关闭，不能开新表单。",
            {
              expected: "表单以 @/? 结束后才能开始下一个 @?",
              fix: "先写 @/? 关闭当前表单，再开新表单",
            },
          );
        }
        {
          // 先验证再挂载：start() 对空提示抛 EMPTY_FORM_PROMPT 时，一个
          // 半开的 builder（实例在、prompt 为 null）残留会让下一个
          // form_start 误判 FORM_ALREADY_OPEN——strip-continue 续写补的
          // `@? 提示` 就死在这（2026-09-17 监控 21:25 复盘）。
          const interaction = new InteractionBuilder();
          interaction.start(line.prompt);
          this.interaction = interaction;
        }
        return [];

      case "form_option":
        this.ensureInteraction().addOption(line.text);
        return [];

      case "form_input":
        this.ensureInteraction().setInput(line.placeholder);
        return [];

      case "form_end": {
        const draft = this.ensureInteraction().finish();
        return this.flush({ type: "interaction", interaction: draft });
      }

      case "beat":
        this.assertNoOpenForm();
        return this.flush({ type: "beat" });

      case "segment_end":
        // The segment validator intercepts segment_end before calling this
        // builder; a sentinel reaching us is a pipeline misuse (docs §44).
        throw new DslProtocolError(
          "UNKNOWN_LINE",
          "segment_end must be handled by the segment validator, not the group builder.",
        );

      case "ending_epilogue":
        // 同上：validator 在哨兵窗口内消费 @ending 并拦截哨兵前孤儿，
        // 到达 builder 即管线误用。
        throw new DslProtocolError(
          "UNKNOWN_LINE",
          "ending_epilogue must be handled by the segment validator, not the group builder.",
        );
    }
  }

  finish(): { pendingCues: StageCue[]; openInteraction: DslInteractionDraft | null } {
    let openInteraction: DslInteractionDraft | null = null;
    if (this.interaction !== null) {
      try {
        openInteraction = this.interaction.finish();
      } catch (error) {
        if (error instanceof DslProtocolError) {
          // Truncated form (`? Q` with no option/input): not derivable, so
          // the caller drops it (docs §38, §102).
          openInteraction = null;
        } else {
          throw error;
        }
      }
    }
    // finish() 是终态调用：两个分支都摘下 builder 并清空待交付 cues（所
    // 有权已随返回值转移），防止"finish 后继续 push"重复交付/误报
    // FORM_ALREADY_OPEN（2026-09-17 独立审计 G1/N2——当前零生产调用方，
    // 纯防御）。
    const cues = this.pendingCues;
    this.interaction = null;
    this.pendingCues = [];
    return { pendingCues: cues, openInteraction };
  }

  /**
   * Open form, or a throwaway builder when none is open — the
   * InteractionBuilder itself then raises FORM_LINE_OUTSIDE_FORM /
   * FORM_END_WITHOUT_OPEN (docs §100). The throwaway is NEVER mounted on
   * `this.interaction`: the streaming adapter keeps feeding THIS parser
   * instance after a strip-continue, so any half-open instance left behind
   * by a throw would poison the next form_start into a false
   * FORM_ALREADY_OPEN (2026-09-17 独立审计 S1/S2)——keeping it unmounted
   * is what makes the throw stateless.
   */
  private ensureInteraction(): InteractionBuilder {
    if (this.interaction === null) {
      return new InteractionBuilder();
    }
    return this.interaction;
  }

  /** Throw CONTENT_INSIDE_OPEN_FORM when a main event interrupts a form. */
  private assertNoOpenForm(): void {
    if (this.interaction !== null) {
      throw new DslProtocolError(
        "CONTENT_INSIDE_OPEN_FORM",
        "交互表单还开着，中间不能插入台词、旁白或 beat。",
        {
          expected: "@? 之后只能跟 @+ 选项行 / @= 输入行，最后以 @/? 结束",
          cause: "表单行（@?/@+/=@）和正文行混在了一起",
          fix: "先写 @/? 关闭表单，再把台词或旁白另起一行写在表单之后",
        },
      );
    }
  }

  /** Flush pendingCues + one main event as a committed group. */
  private flush(main: EventGroupDraft["main"]): EventGroupDraft[] {
    const group: EventGroupDraft = { prelude: this.pendingCues, main };
    this.pendingCues = [];
    this.interaction = null;
    return [group];
  }

  /** `ch` cue → character_patch cue (docs §17–§19; key resolution is the compiler's job). */
  private characterCue(line: Extract<DslLine, { kind: "character_cue" }>): StageCue {
    const base = { type: "character_patch" as const, character: line.characterId };
    switch (line.action) {
      case "show":
        return { ...base, visible: { op: "set", value: true } };
      case "hide":
        return { ...base, visible: { op: "set", value: false } };
      case "exit":
        return { ...base, exit: true };
      case "set":
        return {
          ...base,
          ...(line.variant !== undefined
            ? { variant: { op: "set", value: line.variant } }
            : {}),
          ...(line.position !== undefined
            ? { position: { op: "set", value: line.position } }
            : {}),
        };
    }
  }
}
