/**
 * InteractionPanel — the unified choice / hybrid / input form (§11.3, §11.4).
 *
 * One component owns the whole interaction surface so main.ts never juggles
 * two independent widgets (the old renderChoices + InputPanel split drifted:
 * hybrid degraded to a pure choice list and the prompt could render twice).
 *
 * Modes:
 * - choice:  prompt + option list
 * - hybrid:  prompt + option list + divider + textarea
 * - input:   prompt + textarea
 *
 * The panel also implements the one-shot submit lock (§10.3): the first
 * option click OR input submit disables every option and the textarea until
 * the next interaction opens (or a preview cancel restores it).
 */
import { asChoiceInteraction, renderChoiceOptions } from "./choices.js";
import { asRecord, setText, show } from "./dom.js";
import { asInputInteraction } from "./input-panel.js";

export interface InteractionPanelHooks {
  onSelect(optionId: string): void;
  onSubmit(text: string): void;
}

type PanelMode = "choice" | "hybrid" | "input";

const DEFAULT_MAX_LENGTH = 200;
const DEFAULT_PLACEHOLDER = "在此写下你的回应……";

/** Detect the interaction surface kind, including the legacy `choice` event. */
function interactionModeOf(value: unknown): PanelMode | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (record.type === "interaction") {
    if (record.mode === "choice" || record.mode === "hybrid" || record.mode === "input") {
      return record.mode;
    }
    return null;
  }
  // Legacy synthetic choice (type: "choice", normalized by the view model).
  if (record.type === "choice") return "choice";
  return null;
}

export class InteractionPanel {
  private readonly root: HTMLElement;
  private readonly promptEl: HTMLElement;
  private readonly choicesEl: HTMLElement;
  private readonly dividerEl: HTMLElement;
  private readonly inputEl: HTMLElement;
  private readonly field: HTMLTextAreaElement;
  private readonly countEl: HTMLElement;
  private readonly hooks: InteractionPanelHooks;
  private maxLength = DEFAULT_MAX_LENGTH;
  /** One-shot submit lock (§10.3); reset on every open(). */
  private submitted = false;

  constructor(root: HTMLElement, hooks: InteractionPanelHooks) {
    this.root = root;
    this.hooks = hooks;
    this.promptEl = root.querySelector(".interaction-panel__prompt") as HTMLElement;
    this.choicesEl = root.querySelector(".interaction-panel__choices") as HTMLElement;
    this.dividerEl = root.querySelector(".interaction-panel__divider") as HTMLElement;
    this.inputEl = root.querySelector(".interaction-panel__input") as HTMLElement;
    this.field = root.querySelector(".interaction-panel__input textarea") as HTMLTextAreaElement;
    this.countEl = root.querySelector(".input-panel__count") as HTMLElement;

    this.field.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      // IME composition Enter confirms the composition, not the form.
      if (event.isComposing || event.keyCode === 229) return;
      // Shift+Enter inserts a newline (the default textarea behavior).
      if (event.shiftKey) return;
      event.preventDefault();
      this.submitInput();
    });
    this.field.addEventListener("input", () => this.updateCount());
  }

  /**
   * Open the form for an interaction. Renders per mode, sets the input spec,
   * resets the submit lock and focuses the field for typing. Returns true
   * when the interaction is usable.
   */
  open(interaction: unknown): boolean {
    const mode = interactionModeOf(interaction);
    const choice = asChoiceInteraction(interaction);
    const input = asInputInteraction(interaction);
    if (mode === null) return false;
    if ((mode === "choice" || mode === "hybrid") && choice === null) return false;
    if ((mode === "hybrid" || mode === "input") && input === null) return false;

    this.submitted = false;
    setText(this.promptEl, choice?.prompt ?? input?.prompt ?? "");

    const showChoices = mode === "choice" || mode === "hybrid";
    const showInput = mode === "hybrid" || mode === "input";
    show(this.choicesEl, showChoices);
    show(this.dividerEl, mode === "hybrid");
    show(this.inputEl, showInput);

    if (showChoices && choice !== null) {
      renderChoiceOptions(this.choicesEl, interaction, (optionId) =>
        this.selectOption(optionId),
      );
    }
    if (showInput && input !== null) {
      this.maxLength = Math.min(2000, Math.max(1, input.input?.max_length ?? DEFAULT_MAX_LENGTH));
      this.field.value = "";
      this.field.placeholder = input.input?.placeholder ?? DEFAULT_PLACEHOLDER;
      this.field.maxLength = this.maxLength;
      this.field.disabled = false;
      this.updateCount();
    }

    show(this.root, true);
    // Focus for input; hybrid may focus too — option clicks still work.
    if (mode !== "choice") {
      window.setTimeout(() => this.field.focus(), 0);
    }
    return true;
  }

  /** External lock control (§10.3) — unlock only when the server reopens the form. */
  setSubmitting(submitting: boolean): void {
    this.submitted = submitting;
    this.setOptionsDisabled(submitting);
    this.field.disabled = submitting;
  }

  /**
   * Reopen the form after preview cancel: the panel returns to its ORIGINAL
   * mode (§11.6) with the player's draft written back (§11.7).
   */
  restoreDraft(text: string): void {
    this.submitted = false;
    this.setOptionsDisabled(false);
    this.field.disabled = false;
    this.field.value = text.slice(0, this.maxLength);
    this.updateCount();
    show(this.root, true);
    window.setTimeout(() => this.field.focus(), 0);
  }

  /** Hide the form (interaction resolved / session ended). */
  close(): void {
    show(this.root, false);
  }

  private selectOption(optionId: string): void {
    if (this.submitted) return;
    this.lock();
    this.hooks.onSelect(optionId);
  }

  private submitInput(): void {
    if (this.submitted) return;
    const text = this.field.value.trim();
    if (text.length === 0) return;
    this.lock();
    this.hooks.onSubmit(text);
  }

  private lock(): void {
    this.submitted = true;
    this.setOptionsDisabled(true);
    this.field.disabled = true;
  }

  private setOptionsDisabled(disabled: boolean): void {
    for (const button of this.choicesEl.querySelectorAll("button.choice")) {
      (button as HTMLButtonElement).disabled = disabled;
    }
  }

  private updateCount(): void {
    setText(this.countEl, `${this.field.value.length} / ${this.maxLength}`);
  }
}
