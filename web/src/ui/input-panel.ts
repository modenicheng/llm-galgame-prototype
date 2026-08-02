/**
 * InputPanel + PreviewPanel — the two-stage free-text flow (§13).
 *
 * INPUT_EDITING: a textarea; the first Enter freezes the draft and sends
 * `preview_input` (preview_input is a separate async operation, so during
 * IME composition Enter must NOT submit).
 * INPUT_PREVIEW: the frozen text is shown for confirm; Enter confirms
 * (`confirm_input`), Esc cancels (`cancel_input`) and the interaction
 * reopens for editing.
 */
import { asRecord, setText, show } from "./dom.js";

export interface InputPanelHooks {
  onSubmit(text: string): void;
}

export interface InputInteractionLike {
  interaction_id: string;
  prompt: string;
  input?: {
    placeholder?: string;
    max_length?: number;
  };
}

/** Narrow an unknown interaction wire object to an input surface, or null. */
export function asInputInteraction(value: unknown): InputInteractionLike | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = record.interaction_id;
  const prompt = record.prompt;
  if (typeof id !== "string" || typeof prompt !== "string") return null;
  const spec = asRecord(record.input);
  return {
    interaction_id: id,
    prompt,
    ...(spec !== null
      ? {
          input: {
            ...(typeof spec.placeholder === "string"
              ? { placeholder: spec.placeholder }
              : {}),
            ...(typeof spec.max_length === "number"
              ? { max_length: spec.max_length }
              : {}),
          },
        }
      : {}),
  };
}

export class InputPanel {
  private readonly root: HTMLElement;
  private readonly promptEl: HTMLElement;
  private readonly field: HTMLTextAreaElement;
  private readonly countEl: HTMLElement;
  private readonly hooks: InputPanelHooks;
  private maxLength = 200;

  constructor(root: HTMLElement, hooks: InputPanelHooks) {
    this.root = root;
    this.hooks = hooks;
    this.promptEl = root.querySelector(".input-panel__prompt") as HTMLElement;
    this.field = root.querySelector(".input-panel__field") as HTMLTextAreaElement;
    this.countEl = root.querySelector(".input-panel__count") as HTMLElement;
    this.field.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (event.isComposing || event.keyCode === 229) return; // IME composition
      event.preventDefault();
      this.submit();
    });
    this.field.addEventListener("input", () => this.updateCount());
  }

  /** Open the editor for an input interaction. Returns true when usable. */
  open(interaction: unknown): boolean {
    const parsed = asInputInteraction(interaction);
    if (parsed === null) return false;
    setText(this.promptEl, parsed.prompt);
    this.maxLength = Math.min(2000, Math.max(1, parsed.input?.max_length ?? 200));
    this.field.value = "";
    this.field.placeholder = parsed.input?.placeholder ?? "在此写下你的回应……";
    this.field.maxLength = this.maxLength;
    this.updateCount();
    show(this.root, true);
    // Defer focus so the mode-switch render has settled.
    window.setTimeout(() => this.field.focus(), 0);
    return true;
  }

  submit(): void {
    const text = this.field.value.trim();
    if (text.length === 0) return;
    this.hooks.onSubmit(text);
  }

  /** Restore a draft after preview cancel (Esc returns to editing intact). */
  restoreDraft(text: string): void {
    this.field.value = text.slice(0, this.maxLength);
    this.updateCount();
    show(this.root, true);
    window.setTimeout(() => this.field.focus(), 0);
  }

  private updateCount(): void {
    setText(this.countEl, `${this.field.value.length} / ${this.maxLength}`);
  }
}

export interface PreviewPanelHooks {
  onConfirm(): void;
  onCancel(): void;
}

export class PreviewPanel {
  private readonly root: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly hooks: PreviewPanelHooks;

  constructor(root: HTMLElement, hooks: PreviewPanelHooks) {
    this.root = root;
    this.hooks = hooks;
    this.textEl = root.querySelector(".preview__text") as HTMLElement;
    (root.querySelector(".preview__confirm") as HTMLButtonElement).addEventListener(
      "click",
      () => this.hooks.onConfirm(),
    );
    (root.querySelector(".preview__cancel") as HTMLButtonElement).addEventListener(
      "click",
      () => this.hooks.onCancel(),
    );
  }

  show(text: string): void {
    setText(this.textEl, text);
    show(this.root, true);
  }
}
