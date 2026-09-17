/**
 * The static DOM skeleton of the game screen. `buildAppDom` injects the full
 * layout into `#app` and returns handles to every interactive region:
 * a full-viewport atmospheric backdrop, the centered 16:9 stage frame
 * (background layers + StageRenderer layers + dialogue scene, WebGAL-style
 * letterbox), and viewport-anchored chrome (controls, overlays).
 * All dynamic content lives in the widgets; this file only declares
 * structure and class hooks for the design system in `styles.css`.
 */
import { el } from "./dom.js";

export interface AppDomRefs {
  stage: HTMLElement;
  scene: HTMLElement;
  interactionVeil: HTMLElement;
  dialogueRoot: HTMLElement;
  interactionRoot: HTMLElement;
  previewRoot: HTMLElement;
  waitingEl: HTMLElement;
  waitingPhaseEl: HTMLElement;
  controlsRoot: HTMLElement;
  startRoot: HTMLElement;
  endRoot: HTMLElement;
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

  // 全屏纯黑底：16:9 舞台框之外的 letterbox 区域（WebGAL 式黑边）。
  const backdrop = el("div", "stage") as HTMLDivElement;

  // 16:9 舞台框（WebGAL 式 letterbox）：氛围层只存在于框内（背景图
  // 加载前/占位时的底），StageRenderer 的背景/立绘层随后叠加其上，
  // scene 内的对白/选项/输入面板随框底对齐——任何窗口比例下构图一致。
  const stage = el("div", "stage-frame") as HTMLDivElement;
  stage.append(
    el("div", "stage__mesh"),
    el("div", "stage__grain"),
    el("div", "stage__shafts"),
    el("div", "stage__orb stage__orb--moon"),
    el("div", "stage__orb stage__orb--lantern"),
    el("div", "stage__vig"),
  );
  // 交互遮罩：表单（选项/输入/预览）出现时压暗并轻模糊舞台，保证表单文字
  // 在亮背景/立绘上的可读性（样式见 .stage__veil）。创建即隐藏，避免首帧
  // 渲染前闪现；显隐由 main.ts 的 render 路由随表单/预览模式驱动。
  const interactionVeil = el("div", "stage__veil") as HTMLDivElement;
  interactionVeil.hidden = true;

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
  const waitingPhaseEl = el("span", "waiting__phase", "");
  const dots = el("span", "waiting__dots") as HTMLSpanElement;
  dots.append(el("i", ""), el("i", ""), el("i", ""));
  waitingEl.append(dots, el("span", "waiting__label", "故事正在书写"), waitingPhaseEl);
  scene.append(waitingEl);

  // 对白 UI 挂进 16:9 舞台框（构图随框缩放，见上方 stage-frame 注释）。
  // 遮罩在 DOM 序上位于 scene 之前、舞台氛围层之后（z 序由 z-index 决定）。
  stage.append(interactionVeil, scene);

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
  // 结局档位徽章（TE|HE|NE|BE，配色见 .end-grade--*）：由 EndScreen 按模型
  // 的 @ending 档位填充；未识别/缺省回退 NE 灰青色。
  const endGrade = el("span", "end-grade", "") as HTMLElement;
  endGrade.hidden = true;
  endInner.append(
    el("div", "end-seal", "终"),
    endGrade,
    el("h2", "end-title", "剧终"),
    el("p", "end-text", ""),
    el("p", "end-session", ""),
    button("btn btn--ghost end-restart", "重新开始"),
  );
  endRoot.append(endInner);

  // 生成过程的错误/状态一律不上玩家端（操作员看 /monitor）；fatal 时舞台
  // 停在最后一帧，控制条里的重开按钮承担恢复入口。
  root.append(backdrop, stage, controlsRoot, startRoot, endRoot);

  return {
    stage,
    scene,
    interactionVeil,
    dialogueRoot,
    interactionRoot,
    previewRoot,
    waitingEl,
    waitingPhaseEl,
    controlsRoot,
    startRoot,
    endRoot,
  };
}
