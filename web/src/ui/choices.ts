/**
 * Choices — the branch option list (choice / hybrid interactions).
 * Rendered as staggered lantern cards; each card carries an `--i` custom
 * property so the CSS entrance animation cascades.
 */
import { asRecord, clearChildren, el } from "./dom.js";

export interface ChoiceOptionLike {
  id: string;
  text: string;
}

export interface ChoiceInteractionLike {
  interaction_id: string;
  prompt: string;
  options: ChoiceOptionLike[];
}

/** Narrow an unknown interaction wire object to a choice surface, or null. */
export function asChoiceInteraction(value: unknown): ChoiceInteractionLike | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = record.interaction_id;
  const prompt = record.prompt;
  const options = record.options;
  if (typeof id !== "string" || typeof prompt !== "string" || !Array.isArray(options)) {
    return null;
  }
  const parsed: ChoiceOptionLike[] = [];
  for (const raw of options) {
    const option = asRecord(raw);
    if (option === null || typeof option.id !== "string" || typeof option.text !== "string") {
      continue;
    }
    parsed.push({ id: option.id, text: option.text });
  }
  if (parsed.length === 0) return null;
  return { interaction_id: id, prompt, options: parsed };
}

/**
 * Render ONLY the option list (no prompt) into `container`. Used by the
 * InteractionPanel, which owns the single prompt for the whole form (§11.3).
 */
export function renderChoiceOptions(
  container: HTMLElement,
  interaction: unknown,
  onSelect: (optionId: string) => void,
): void {
  clearChildren(container);
  const parsed = asChoiceInteraction(interaction);
  if (parsed === null) return;

  const list = el("ul", "choices__list") as HTMLUListElement;
  parsed.options.forEach((option, index) => {
    const item = el("li", "choices__item") as HTMLLIElement;
    item.style.setProperty("--i", String(index));
    const card = el("button", "choice", option.text) as HTMLButtonElement;
    card.type = "button";
    card.addEventListener("click", () => onSelect(option.id));
    item.append(card);
    list.append(item);
  });
  container.append(list);
}

