/**
 * StageRenderer — the browser's placeholder stage renderer (docs
 * llm-outputs-refactor.md §86 web, §107).
 *
 * Turns the wire `visualState` into a minimal DOM picture: a tinted
 * background slab, per-character silhouette cards on the five positional
 * slots, and a `data-bgm` indicator on the container. Asset art, audio
 * playback and core types are all out of scope — pure DOM + state.
 *
 * The two renderer-owned layers (`stage__bg`, `stage__chars`) are appended
 * to the container exactly ONCE (in the constructor, at the END so they
 * stack above the decorative mesh/grain/shafts/orbs/vig). `apply` is
 * idempotent and diff-free: it re-renders both layers from scratch, so
 * calling it repeatedly never duplicates nodes.
 */
import { clearChildren, el } from "../ui/dom.js";
import type { StageCharacterState, StageVisualState } from "./stage-types.js";

/**
 * Deterministic hue (0–359) derived from a string id, so an asset or
 * character always gets the same placeholder color across renders.
 */
export function deterministicHue(key: string): number {
  let sum = 0;
  for (let i = 0; i < key.length; i += 1) sum += key.charCodeAt(i);
  return sum % 360;
}

export class StageRenderer {
  private readonly bgLayer: HTMLDivElement;
  private readonly charsLayer: HTMLDivElement;

  constructor(private readonly container: HTMLElement) {
    this.bgLayer = el("div", "stage__bg");
    this.charsLayer = el("div", "stage__chars");
    container.append(this.bgLayer, this.charsLayer);
  }

  /** Idempotent, diff-free re-render of the whole stage picture. */
  apply(state: StageVisualState): void {
    this.renderBackground(state.background);
    this.renderCharacters(state.characters);
    if (state.bgm !== undefined) {
      this.container.dataset.bgm = state.bgm;
    } else {
      delete this.container.dataset.bgm;
    }
  }

  private renderBackground(background: string | undefined): void {
    clearChildren(this.bgLayer);
    if (background === undefined) return;
    const item = el("div", "stage__bg-item");
    item.dataset.asset = background;
    item.style.background = `hsl(${deterministicHue(background)}, 30%, 18%)`;
    item.append(el("span", "stage__bg-label", background));
    this.bgLayer.append(item);
  }

  private renderCharacters(characters: Record<string, StageCharacterState>): void {
    clearChildren(this.charsLayer);
    // Sorted keys → deterministic render order across identical states.
    for (const key of Object.keys(characters).sort()) {
      const character = characters[key];
      if (character === undefined) continue;
      const node = el("div", `stage__char stage__char--${character.position}`);
      node.dataset.char = key;
      node.hidden = !character.visible;
      node.style.background = `hsl(${deterministicHue(key)}, 45%, 35%)`;
      node.append(
        el(
          "span",
          "stage__char-label",
          `${character.displayName} · ${character.spriteSet}/${character.variant}`,
        ),
      );
      this.charsLayer.append(node);
    }
  }
}
