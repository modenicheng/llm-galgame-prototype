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
            "A form is already open — finish it with /? before starting another one.",
          );
        }
        this.interaction = new InteractionBuilder();
        this.interaction.start(line.prompt);
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
    return { pendingCues: this.pendingCues, openInteraction };
  }

  /**
   * Open form, or a throwaway builder when none is open — the
   * InteractionBuilder itself then raises FORM_LINE_OUTSIDE_FORM /
   * FORM_END_WITHOUT_OPEN (docs §100). Any throw aborts the segment, so the
   * leftover open state is irrelevant.
   */
  private ensureInteraction(): InteractionBuilder {
    if (this.interaction === null) {
      this.interaction = new InteractionBuilder();
    }
    return this.interaction;
  }

  /** Throw CONTENT_INSIDE_OPEN_FORM when a main event interrupts a form. */
  private assertNoOpenForm(): void {
    if (this.interaction !== null) {
      throw new DslProtocolError(
        "CONTENT_INSIDE_OPEN_FORM",
        "Content inside an open form. Finish the form with /? before dialogue, narration or beat.",
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
