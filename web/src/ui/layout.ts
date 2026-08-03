/**
 * The static DOM skeleton of the game screen. `buildAppDom` injects the full
 * layout (background layers, HUD, scene panels, overlays) into `#app` and
 * returns handles to every interactive region. All dynamic content lives in
 * the widgets; this file only declares structure and class hooks for the
 * design system in `styles.css`.
 */
import { el } from "./dom.js";

export interface AppDomRefs {
  stage: HTMLElement;
  hud: HTMLElement;
  scene: HTMLElement;
  dialogueRoot: HTMLElement;
  interactionRoot: HTMLElement;
  previewRoot: HTMLElement;
  waitingEl: HTMLElement;
  controlsRoot: HTMLElement;
  startRoot: HTMLElement;
  endRoot: HTMLElement;
  bannerRoot: HTMLElement;
}

/** `button` variant: explicit `type="button"` so Enter/Space never submit a form. */
function button(className: string, text?: string, ariaLabel?: string): HTMLButtonElement {
  const node = el("button", className, text) as HTMLButtonElement;
  node.type = "button";
  if (ariaLabel !== undefined) node.setAttribute("aria-label", ariaLabel);
  return node;
}

export function buildAppDom(root: HTMLElement): AppDomRefs {
  root.textContent = "";

  const stage = el("div", "stage") as HTMLDivElement;
  stage.append(
    el("div", "stage__mesh"),
    el("div", "stage__grain"),
    el("div", "stage__shafts"),
    el("div", "stage__orb stage__orb--moon"),
    el("div", "stage__orb stage__orb--lantern"),
    el("div", "stage__vig"),
  );

  const hud = el("div", "hud") as HTMLDivElement;
  const brand = el("div", "hud__brand") as HTMLDivElement;
  brand.append(
    el("span", "hud__brand-mark", "灯影夜话"),
    el("span", "hud__brand-sub", "· 本地 AI 视觉小说 ·"),
  );
  hud.append(brand);

  const scene = el("section", "scene") as HTMLElement;

  // Dialogue box — nameplate tab + paper panel.
  const dialogueRoot = el("section", "dialogue") as HTMLElement;
  const nameplate = el("div", "dialogue__nameplate") as HTMLDivElement;
  nameplate.append(
    el("span", "dialogue__speaker", ""),
    el("span", "dialogue__line-id", ""),
  );
  const panel = el("div", "dialogue__panel") as HTMLDivElement;
  panel.append(
    el("p", "dialogue__text", ""),
    button("dialogue__hint", "▼", "继续"),
  );
  dialogueRoot.append(nameplate, panel);
  scene.append(dialogueRoot);

  // Unified choice/hybrid/input form (§11.3). The InteractionPanel owns all
  // dynamic content; the static skeleton only declares the class hooks.
  const interactionRoot = el("section", "interaction-panel") as HTMLElement;
  const interactionChoices = el("section", "interaction-panel__choices") as HTMLElement;
  const divider = el("div", "interaction-panel__divider") as HTMLDivElement;
  divider.append(el("span", "", "或者"));
  const interactionInput = el("section", "interaction-panel__input") as HTMLElement;
  const inputField = el("textarea", "input-panel__field") as HTMLTextAreaElement;
  const inputMeta = el("div", "input-panel__meta") as HTMLDivElement;
  inputMeta.append(
    el("span", "input-panel__count", ""),
    el("span", "input-panel__keys", "Enter 发送"),
  );
  interactionInput.append(inputField, inputMeta);
  interactionRoot.append(
    el("p", "interaction-panel__prompt", ""),
    interactionChoices,
    divider,
    interactionInput,
  );
  scene.append(interactionRoot);
  // Preview confirm panel.
  const previewRoot = el("section", "preview") as HTMLElement;
  const previewActions = el("div", "preview__actions") as HTMLDivElement;
  previewActions.append(
    button("btn btn--ghost preview__cancel", "取消", "取消预览"),
    button("btn btn--primary preview__confirm", "确认", "确认发送"),
  );
  previewRoot.append(
    el("p", "preview__label", "—— 预览 ——"),
    el("blockquote", "preview__text", ""),
    previewActions,
    el("p", "preview__keys", "Enter 确认 · Esc 取消"),
  );
  scene.append(previewRoot);

  // Waiting indicator (input committed / generation in flight).
  const waitingEl = el("section", "waiting") as HTMLElement;
  const dots = el("span", "waiting__dots") as HTMLSpanElement;
  dots.append(el("i", ""), el("i", ""), el("i", ""));
  waitingEl.append(dots, el("span", "waiting__label", "故事正在书写"));
  scene.append(waitingEl);

  const controlsRoot = el("section", "controls") as HTMLElement;

  // Start overlay (autoplay unlock, §10.5).
  const startRoot = el("section", "overlay overlay--start") as HTMLElement;
  const startInner = el("div", "start-inner") as HTMLDivElement;
  const rule = el("div", "start-rule") as HTMLDivElement;
  rule.append(
    el("span", "start-rule__tick"),
    el("span", "start-rule__bar"),
    el("span", "start-rule__tick"),
  );
  const warningEl = el("p", "start-warning", "");
  warningEl.hidden = true;
  startInner.append(
    el("p", "start-eyebrow", "深夜灯下 · 一段由 AI 共写的宿命之约"),
    el("h1", "start-title", "灯影夜话"),
    rule,
    el("p", "start-tagline", "雨夜、灯影与未说出口的话——每一次选择，都由你与 AI 共同落笔。"),
    button("btn btn--start", "开始游戏"),
    el("p", "start-hint", "点击后将启用声音，并建立本机会话连接"),
    warningEl,
  );
  startRoot.append(startInner);

  // End overlay.
  const endRoot = el("section", "overlay overlay--end") as HTMLElement;
  const endInner = el("div", "end-inner") as HTMLDivElement;
  endInner.append(
    el("div", "end-seal", "终"),
    el("h2", "end-title", "剧终"),
    el("p", "end-text", ""),
    button("btn btn--ghost end-restart", "重新开始"),
  );
  endRoot.append(endInner);

  // Error banner.
  const bannerRoot = el("div", "banner banner--error") as HTMLDivElement;
  bannerRoot.append(
    el("span", "banner__label", "出错了"),
    el("span", "banner__text", ""),
  );

  root.append(stage, hud, scene, controlsRoot, startRoot, endRoot, bannerRoot);

  return {
    stage,
    hud,
    scene,
    dialogueRoot,
    interactionRoot,
    previewRoot,
    waitingEl,
    controlsRoot,
    startRoot,
    endRoot,
    bannerRoot,
  };
}
