/**
 * StageRenderer — keyed 舞台渲染（spec §6.2）。
 *
 * 背景：持久 <img>，切换时新图 load 后加 .stage__bg-img--ready 淡入，
 *       旧图随层清空移除（crossfade 由 CSS transition 完成）。
 * 角色：每 characterId 一个 <figure> 持久节点；variant 变只换 img.src，
 *       position 变只换 slot class，visible 变只切 hidden。
 *       无 URL（manifest 缺失/未知 id）时回退色块占位（deterministicHue）。
 */
import { clearChildren, el } from "../ui/dom.js";
import type { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { StageCharacterState, StageVisualState } from "./stage-types.js";

const SLOT_CLASSES = [
  "stage__char--far_left",
  "stage__char--left",
  "stage__char--center",
  "stage__char--right",
  "stage__char--far_right",
] as const;

/** Deterministic hue (0–359) from a string id — 占位色块用。 */
export function deterministicHue(key: string): number {
  let sum = 0;
  for (let i = 0; i < key.length; i += 1) sum += key.charCodeAt(i);
  return sum % 360;
}

interface CharacterNode {
  root: HTMLElement;
  img: HTMLImageElement;
  label: HTMLElement;
}

export class StageRenderer {
  private readonly bgLayer: HTMLDivElement;
  private readonly charsLayer: HTMLDivElement;
  private backgroundId: string | undefined;
  private readonly characterNodes = new Map<string, CharacterNode>();

  constructor(
    private readonly container: HTMLElement,
    private readonly resolver: BrowserAssetResolver,
  ) {
    this.bgLayer = el("div", "stage__bg");
    this.charsLayer = el("div", "stage__chars");
    container.append(this.bgLayer, this.charsLayer);
  }

  apply(state: StageVisualState): void {
    this.applyBackground(state.background);
    this.applyCharacters(state.characters);
    if (state.bgm !== undefined) {
      this.container.dataset.bgm = state.bgm;
    } else {
      delete this.container.dataset.bgm;
    }
  }

  private applyBackground(id: string | undefined): void {
    if (id === this.backgroundId) return;
    this.backgroundId = id;
    clearChildren(this.bgLayer);
    if (id === undefined) return;

    const url = this.resolver.resolveBackground(id);
    if (url === undefined) {
      this.renderBackgroundPlaceholder(id);
      return;
    }

    const img = document.createElement("img");
    img.alt = id;
    img.dataset.asset = id;
    img.classList.add("stage__bg-img");
    img.addEventListener("load", () => img.classList.add("stage__bg-img--ready"), { once: true });
    // 加载失败回退到占位色块（与 url===undefined 分支同呈现），并移除坏图。
    img.addEventListener(
      "error",
      () => {
        img.remove();
        this.renderBackgroundPlaceholder(id);
      },
      { once: true },
    );
    img.src = url;
    this.bgLayer.append(img);
  }

  private renderBackgroundPlaceholder(id: string): void {
    const item = el("div", "stage__bg-item");
    item.dataset.asset = id;
    item.style.background = `hsl(${deterministicHue(id)}, 30%, 18%)`;
    item.append(el("span", "stage__bg-label", id));
    this.bgLayer.append(item);
  }

  private applyCharacters(characters: Record<string, StageCharacterState>): void {
    const wanted = new Set(Object.keys(characters));

    for (const [key, node] of this.characterNodes) {
      if (!wanted.has(key)) {
        node.root.remove();
        this.characterNodes.delete(key);
      }
    }

    for (const key of Object.keys(characters).sort()) {
      const character = characters[key]!;
      let node = this.characterNodes.get(key);
      if (node === undefined) {
        node = this.ensureCharacter(key);
      }
      this.updateCharacter(node, key, character);
    }
  }

  private ensureCharacter(key: string): CharacterNode {
    const root = document.createElement("figure");
    root.className = "stage__char";
    root.dataset.char = key;
    const img = document.createElement("img");
    img.alt = key;
    const label = document.createElement("figcaption");
    root.append(img, label);
    this.charsLayer.append(root);
    const node: CharacterNode = { root, img, label };
    this.characterNodes.set(key, node);
    return node;
  }

  private updateCharacter(node: CharacterNode, key: string, character: StageCharacterState): void {
    const url = this.resolver.resolveSprite(character.spriteSet, character.variant);

    if (url === undefined) {
      this.applyCharacterPlaceholder(node, key);
    } else {
      node.root.classList.remove("stage__char--placeholder");
      node.root.style.background = "";
      if (node.img.getAttribute("src") !== url) {
        // 换新 src 前挂 once 错误回退：失败则回落占位（与 url===undefined
        // 分支同呈现）；占位后 src 被移除，下次换到有效 url 会重新加载。
        node.img.addEventListener("error", () => this.applyCharacterPlaceholder(node, key), {
          once: true,
        });
        node.img.src = url;
      }
    }

    for (const slot of SLOT_CLASSES) node.root.classList.remove(slot);
    node.root.classList.add(`stage__char--${character.position}`);

    node.root.hidden = !character.visible;
    node.label.textContent = character.displayName;
  }

  private applyCharacterPlaceholder(node: CharacterNode, key: string): void {
    node.root.classList.add("stage__char--placeholder");
    node.root.style.background = `hsl(${deterministicHue(key)}, 45%, 35%)`;
    node.img.removeAttribute("src");
  }
}
