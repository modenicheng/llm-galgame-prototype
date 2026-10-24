/**
 * SettingsMenu — the combined player-settings popover (设置菜单).
 *
 * 语音音量 / BGM 音量 / 静音 / 文字速度 four rows in one panel anchored under
 * the controls bar — audio tuning lives here instead of being flattened into
 * the bar. Opened by the bar's 设置 trigger; closes on toggle, an outside
 * click or Esc (Esc handling stays in main.ts, which owns the key routing).
 */
import { el, show, setText } from "./dom.js";

export interface SettingsMenuHooks {
  onVoiceVolume(v: number): void;
  onBgmVolume(v: number): void;
  onMute(muted: boolean): void;
  onTextSpeed(charsPerSec: number): void;
}

export interface SettingsMenuInitial {
  voiceVolume: number;
  bgmVolume: number;
  muted: boolean;
  textSpeed: number;
}

export interface SettingsMenuOptions {
  /**
   * The trigger element (the bar's 设置 button): clicks on it are never
   * "outside" — the toggle owns flipping the open state for that click.
   */
  anchor?: HTMLElement;
  /** Test seam; defaults to the global document. */
  document?: Document;
}

const SLIDER_MIN = 0;
const SLIDER_MAX = 100;
const SPEED_MIN = 8;
const SPEED_MAX = 64;
const SPEED_STEP = 4;
const SPEED_DEFAULT = 32;

export class SettingsMenu {
  private readonly panel: HTMLElement;
  private readonly voiceSlider: HTMLInputElement;
  private readonly voiceValue: HTMLElement;
  private readonly bgmSlider: HTMLInputElement;
  private readonly bgmValue: HTMLElement;
  private readonly muteCheck: HTMLInputElement;
  private readonly speedSlider: HTMLInputElement;
  private readonly speedValue: HTMLElement;
  private readonly hooks: SettingsMenuHooks;
  private readonly anchor: HTMLElement | null;
  private readonly doc: Document;

  private openState = false;
  private readonly onDocClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Node)) return;
    if (this.panel.contains(event.target)) return;
    if (this.anchor !== null && this.anchor.contains(event.target)) return;
    this.close();
  };

  constructor(
    root: HTMLElement,
    hooks: SettingsMenuHooks,
    initial: SettingsMenuInitial,
    options: SettingsMenuOptions = {},
  ) {
    this.hooks = hooks;
    this.anchor = options.anchor ?? null;
    this.doc = options.document ?? document;

    this.panel = el("div", "settings-menu") as HTMLDivElement;
    this.panel.hidden = true;

    this.panel.append(el("p", "settings-menu__title", "设置"));
    this.panel.append(el("p", "settings-menu__subtitle", "音频"));

    const voice = this.buildSliderRow(
      "语音音量",
      SLIDER_MIN,
      SLIDER_MAX,
      Math.round(initial.voiceVolume * SLIDER_MAX),
      (v) => {
        this.voiceValue.textContent = `${v}%`;
        this.hooks.onVoiceVolume(v / SLIDER_MAX);
      },
      1,
      (v) => `${v}%`,
    );
    this.voiceSlider = voice.slider;
    this.voiceValue = voice.value;

    const bgm = this.buildSliderRow(
      "BGM 音量",
      SLIDER_MIN,
      SLIDER_MAX,
      Math.round(initial.bgmVolume * SLIDER_MAX),
      (v) => {
        this.bgmValue.textContent = `${v}%`;
        this.hooks.onBgmVolume(v / SLIDER_MAX);
      },
      1,
      (v) => `${v}%`,
    );
    this.bgmSlider = bgm.slider;
    this.bgmValue = bgm.value;

    const muteRow = el("label", "settings-menu__row settings-menu__row--check") as HTMLLabelElement;
    this.muteCheck = el("input", "settings-menu__check") as HTMLInputElement;
    this.muteCheck.type = "checkbox";
    this.muteCheck.checked = initial.muted;
    this.muteCheck.addEventListener("change", () => {
      this.hooks.onMute(this.muteCheck.checked);
    });
    muteRow.append(this.muteCheck, el("span", "settings-menu__label", "全部静音"));
    this.panel.append(muteRow);

    this.panel.append(el("p", "settings-menu__subtitle", "文字"));
    const speed = this.buildSliderRow(
      "字速",
      SPEED_MIN,
      SPEED_MAX,
      initial.textSpeed,
      (v) => {
        this.speedValue.textContent = `${v} 字/秒`;
        this.hooks.onTextSpeed(v);
      },
      SPEED_STEP,
      (v) => `${v} 字/秒`,
    );
    this.speedSlider = speed.slider;
    this.speedValue = speed.value;

    const reset = el("button", "settings-menu__reset", "恢复默认") as HTMLButtonElement;
    reset.type = "button";
    reset.addEventListener("click", () => this.resetDefaults());
    this.panel.append(reset);

    this.panel.append(el("p", "settings-menu__hint", "设置保存在本机，刷新后自动恢复"));
    root.append(this.panel);
  }

  isOpen(): boolean {
    return this.openState;
  }

  toggle(): void {
    if (this.openState) this.close();
    else this.open();
  }

  open(): void {
    if (this.openState) return;
    this.openState = true;
    this.panel.hidden = false;
    this.doc.addEventListener("click", this.onDocClick);
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.panel.hidden = true;
    this.doc.removeEventListener("click", this.onDocClick);
  }

  /** External state sync (e.g. app-driven changes) without firing hooks. */
  setValues(initial: SettingsMenuInitial): void {
    this.voiceSlider.value = String(Math.round(initial.voiceVolume * SLIDER_MAX));
    setText(this.voiceValue, `${this.voiceSlider.value}%`);
    this.bgmSlider.value = String(Math.round(initial.bgmVolume * SLIDER_MAX));
    setText(this.bgmValue, `${this.bgmSlider.value}%`);
    this.muteCheck.checked = initial.muted;
    this.speedSlider.value = String(initial.textSpeed);
    setText(this.speedValue, `${initial.textSpeed} 字/秒`);
  }

  /** Restore defaults in the UI and through the hooks (one save per row). */
  resetDefaults(): void {
    this.setValues({ voiceVolume: 1, bgmVolume: 1, muted: false, textSpeed: SPEED_DEFAULT });
    this.hooks.onVoiceVolume(1);
    this.hooks.onBgmVolume(1);
    this.hooks.onMute(false);
    this.hooks.onTextSpeed(SPEED_DEFAULT);
  }

  private buildSliderRow(
    label: string,
    min: number,
    max: number,
    value: number,
    onInput: (v: number) => void,
    step = 1,
    format: (v: number) => string = String,
  ): { slider: HTMLInputElement; value: HTMLElement } {
    const row = el("label", "settings-menu__row") as HTMLLabelElement;
    row.append(el("span", "settings-menu__label", label));
    const slider = el("input", "settings-menu__slider") as HTMLInputElement;
    slider.type = "range";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(value);
    const valueEl = el("span", "settings-menu__value", "");
    slider.addEventListener("input", () => {
      onInput(Number(slider.value));
    });
    valueEl.textContent = format(value);
    row.append(slider, valueEl);
    this.panel.append(row);
    return { slider, value: valueEl };
  }
}
