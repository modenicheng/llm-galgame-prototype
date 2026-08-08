import {
  DslProtocolError,
  type DslInteractionDraft,
  type InteractionMode,
} from "./types.js";

/**
 * Accumulates a single form: opened by `?`, fed by `+` / `=`, closed by `/?`
 * (docs §24–§28, §43). Mode is derived on finish() — the model never writes
 * it (docs §28). All texts are stored trimmed.
 */
export class InteractionBuilder {
  private prompt: string | null = null;
  private optionTexts: string[] = [];
  private inputPlaceholder: string | null = null;

  start(prompt: string): void {
    if (this.prompt !== null) {
      throw new DslProtocolError(
        "FORM_ALREADY_OPEN",
        "A form is already open — finish it with /? before starting another one.",
      );
    }
    const trimmed = prompt.trim();
    if (trimmed === "") {
      throw new DslProtocolError(
        "EMPTY_FORM_PROMPT",
        "The form prompt must not be empty. Write a question after `?`.",
      );
    }
    this.prompt = trimmed;
    this.optionTexts = [];
    this.inputPlaceholder = null;
  }

  addOption(text: string): void {
    if (this.prompt === null) {
      throw new DslProtocolError(
        "FORM_LINE_OUTSIDE_FORM",
        "`+` outside an open form. Start the form with `?` first.",
      );
    }
    const trimmed = text.trim();
    if (trimmed === "") {
      throw new DslProtocolError(
        "EMPTY_OPTION_TEXT",
        "Option text must not be empty. Write the option after `+`.",
      );
    }
    this.optionTexts.push(trimmed);
  }

  setInput(placeholder: string): void {
    if (this.prompt === null) {
      throw new DslProtocolError(
        "FORM_LINE_OUTSIDE_FORM",
        "`=` outside an open form. Start the form with `?` first.",
      );
    }
    if (this.inputPlaceholder !== null) {
      throw new DslProtocolError(
        "MULTIPLE_INPUT_FIELDS",
        "A form allows at most one input field. Remove the extra `=` line.",
      );
    }
    const trimmed = placeholder.trim();
    if (trimmed === "") {
      throw new DslProtocolError(
        "EMPTY_INPUT_PLACEHOLDER",
        "The input placeholder must not be empty. Write the hint text after `=`.",
      );
    }
    this.inputPlaceholder = trimmed;
  }

  finish(): DslInteractionDraft {
    if (this.prompt === null) {
      throw new DslProtocolError(
        "FORM_END_WITHOUT_OPEN",
        "`/?` without an open form. Start the form with `?` first.",
      );
    }
    const hasOptions = this.optionTexts.length >= 1;
    const hasInput = this.inputPlaceholder !== null;
    let mode: InteractionMode;
    if (hasOptions && hasInput) {
      mode = "hybrid";
    } else if (hasOptions) {
      mode = "choice";
    } else if (hasInput) {
      mode = "input";
    } else {
      throw new DslProtocolError(
        "EMPTY_FORM",
        "The form is empty: it has neither options nor an input field. Add at least one `+` or one `=` line.",
      );
    }
    const draft: DslInteractionDraft = {
      prompt: this.prompt,
      optionTexts: this.optionTexts,
      mode,
      ...(this.inputPlaceholder !== null
        ? { inputPlaceholder: this.inputPlaceholder }
        : {}),
    };
    return draft;
  }

  isOpen(): boolean {
    return this.prompt !== null;
  }
}
