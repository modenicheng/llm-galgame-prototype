/**
 * ControlsBar — the top-right session controls (§20 playback controls):
 * manual/auto mode toggle, the 设置 entry (all audio/text settings live in
 * the SettingsMenu popover, not flattened into this bar) and the connection
 * + playback status indicator.
 */
import type { ConnectionState } from "../runtime/runtime-client.js";
import type { PlaybackMode } from "../audio/audio-coordinator.js";
import { setText, show } from "./dom.js";

export interface ControlsHooks {
  onModeToggle(next: PlaybackMode): void;
  /** Opens the combined settings popover (volumes / mute / text speed). */
  onOpenSettings(): void;
}

const MODE_LABEL: Record<PlaybackMode, string> = {
  manual: "手动",
  auto: "自动",
};

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "连接中…",
  open: "已连接",
  closed: "已断开",
};

export class ControlsBar {
  private bufferedMs = 0;
  private readonly root: HTMLElement;
  private readonly modeBtn: HTMLButtonElement;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly statusDot: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly hooks: ControlsHooks;

  private mode: PlaybackMode = "manual";

  constructor(
    root: HTMLElement,
    hooks: ControlsHooks,
    initial: { mode: PlaybackMode },
  ) {
    this.root = root;
    this.hooks = hooks;
    this.mode = initial.mode;

    const wrap = document.createElement("div");
    wrap.className = "controls__bar";

    this.modeBtn = document.createElement("button");
    this.modeBtn.type = "button";
    this.modeBtn.className = "ctl ctl--mode";
    this.modeBtn.addEventListener("click", () => {
      const next: PlaybackMode = this.mode === "auto" ? "manual" : "auto";
      this.mode = next;
      this.renderMode();
      this.hooks.onModeToggle(next);
    });

    this.settingsBtn = document.createElement("button");
    this.settingsBtn.type = "button";
    this.settingsBtn.className = "ctl ctl--settings";
    this.settingsBtn.addEventListener("click", () => {
      this.hooks.onOpenSettings();
    });

    const status = document.createElement("div");
    status.className = "ctl ctl--status";
    this.statusDot = document.createElement("span");
    this.statusDot.className = "ctl__dot";
    this.statusText = document.createElement("span");
    this.statusText.className = "ctl__status-text";
    status.append(this.statusDot, this.statusText);

    wrap.append(this.modeBtn, this.settingsBtn, status);
    this.root.append(wrap);

    this.renderMode();
    this.renderSettings();
  }

  /** The 设置 trigger — the settings menu treats clicks on it as "not outside". */
  get settingsTrigger(): HTMLButtonElement {
    return this.settingsBtn;
  }

  show(): void {
    show(this.root, true);
  }

  hide(): void {
    show(this.root, false);
  }

  setMode(mode: PlaybackMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.renderMode();
  }

  setSettingsOpen(open: boolean): void {
    this.settingsBtn.classList.toggle("ctl--active", open);
  }

  setConnection(state: ConnectionState): void {
    this.root.dataset.connection = state;
    this.renderStatus();
  }

  setAudio(playing: boolean, bufferedMs: number): void {
    this.root.dataset.playing = playing ? "1" : "0";
    this.bufferedMs = bufferedMs;
    this.renderStatus();
  }

  private renderStatus(): void {
    const connection = (this.root.dataset.connection ?? "connecting") as ConnectionState;
    const buffer = this.bufferedMs > 0 ? ` · 缓冲 ${(this.bufferedMs / 1000).toFixed(1)}s` : "";
    const playing = this.root.dataset.playing === "1" ? "播放中" : "待命";
    setText(this.statusText, `${CONNECTION_LABEL[connection]} · ${playing}${buffer}`);
  }

  private renderMode(): void {
    setText(this.modeBtn, `${MODE_LABEL[this.mode]}推进`);
  }

  private renderSettings(): void {
    setText(this.settingsBtn, "设置");
  }
}
