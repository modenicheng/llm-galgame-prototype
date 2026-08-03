/**
 * PreviewPanel — the confirm stage of the free-text flow (§13).
 *
 * The editing stage now lives in the unified InteractionPanel
 * (interaction-panel.ts); this file keeps only the INPUT_PREVIEW surface:
 * the frozen text is shown for confirm; Enter confirms (`confirm_input`),
 * Esc cancels (`cancel_input`) and the interaction reopens for editing.
 *
 * `asInputInteraction` is shared with the InteractionPanel for parsing the
 * `input` spec (placeholder / max_length).
 */
import { asRecord, setText, show } from "./dom.js";

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
