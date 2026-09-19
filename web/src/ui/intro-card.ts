/**
 * IntroCard — 序章卡（本局引子）。
 *
 * 开场生成期间模糊压暗舞台并展示叙事引子（campus 线即叙事种子），把
 * "等待故事生成"变成剧情的一部分：标题 + 引子全文 + 生成指示。首条
 * 台词到达（或结局/报错/表单打开）时整卡淡出。
 *
 * 同一局后续的生成等待走 compact 过场（只留标题与指示），避免同一段
 * 引子反复整版重读——全文只在开场等待（本局还没有已呈现台词）出现。
 *
 * 遮罩本体是 backdrop-filter 元素，入退场均为自身 opacity 动画
 * （Backdrop Root 限制只作用于祖先带 opacity 的情形，见 .dialogue 注释）。
 */
import { setText, show } from "./dom.js";

export interface SessionIntroView {
  title?: string;
  text: string;
}

/** 退出动画兜底：animationend 可能因元素中途 display:none 丢失。 */
const HIDE_FAILSAFE_MS = 500;

export class IntroCard {
  private readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private hideTimer: number | null = null;
  /** 当前展示内容（同内容重复 show 不重放入场动画）。 */
  private shown: { title: string; text: string; full: boolean } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.titleEl = root.querySelector(".intro__title") as HTMLElement;
    this.textEl = root.querySelector(".intro__text") as HTMLElement;
    root.addEventListener("animationend", (event) => {
      if (
        this.hideTimer !== null &&
        event.target === this.root &&
        this.root.classList.contains("intro--out")
      ) {
        this.finishHide();
      }
    });
  }

  /**
   * 展示引子。`full` = 开场序章（标题 + 全文）；否则 compact 过场
   * （标题 + 生成指示）。已可见且内容未变时是 no-op。
   */
  show(intro: SessionIntroView, full: boolean): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const title = intro.title ?? "";
    const shown = this.shown;
    if (
      shown !== null &&
      !this.root.hidden &&
      shown.title === title &&
      shown.text === intro.text &&
      shown.full === full
    ) {
      return;
    }
    this.shown = { title, text: intro.text, full };
    this.root.classList.remove("intro--out");
    this.root.classList.toggle("intro--compact", !full);
    this.titleEl.hidden = title.length === 0;
    setText(this.titleEl, title);
    setText(this.textEl, intro.text);
    show(this.root, true);
  }

  /** 淡出收卡；已隐藏或正在退出时是 no-op。 */
  hide(): void {
    if (this.root.hidden || this.hideTimer !== null) return;
    this.shown = null;
    this.root.classList.add("intro--out");
    this.hideTimer = window.setTimeout(() => this.finishHide(), HIDE_FAILSAFE_MS);
  }

  private finishHide(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.root.hidden) return;
    this.root.classList.remove("intro--out");
    show(this.root, false);
  }
}
