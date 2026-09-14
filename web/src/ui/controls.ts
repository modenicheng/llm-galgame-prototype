/**
 * ControlsBar — the top-right session controls (§20 playback controls):
 * manual/auto mode toggle, volume, mute, text speed and the connection +
 * playback status indicator.
 */
import type { ConnectionState } from "../runtime/runtime-client.js";
import type { PlaybackMode } from "../audio/audio-coordinator.js";
import { setText, show } from "./dom.js";

export interface ControlsHooks {
  onModeToggle(next: PlaybackMode): void;
  onVolume(v: number): void;
  onMute(muted: boolean): void;
  onSpeed(charsPerSec: number): void;
  /** Booth restart: opens a fresh session; current progress is lost. */
  onRestart(): void;
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
  private readonly volumeInput: HTMLInputElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly speedBtn: HTMLButtonElement;
  private readonly restartBtn: HTMLButtonElement;
  private readonly sessionChip: HTMLButtonElement;
  private readonly statusDot: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly hooks: ControlsHooks;

  private mode: PlaybackMode = "manual";
  private muted = false;
  private speed = 32;
  private restartPending = false;
  private sessionId: string | undefined;

  constructor(root: HTMLElement, hooks: ControlsHooks, initial: { mode: PlaybackMode; volume: number; muted: boolean; speed: number }) {
    this.root = root;
    this.hooks = hooks;
    this.mode = initial.mode;
    this.muted = initial.muted;
    this.speed = initial.speed;

    const wrap = document.createElement("div");
    wrap.className = "controls__bar";

    this.modeBtn = document.createElement("button");
    this.modeBtn.type = "button";
    this.modeBtn.className = "ctl ctl--mode";
    this.modeBtn.addEventListener("click", () => {
      const next: PlaybackMode = this.mode === "manual" ? "auto" : "manual";
      this.mode = next;
      this.renderMode();
      this.hooks.onModeToggle(next);
    });

    const volumeLabel = document.createElement("label");
    volumeLabel.className = "ctl ctl--volume";
    volumeLabel.append(document.createElement("span"));
    (volumeLabel.firstChild as HTMLElement).textContent = "音量";
    this.volumeInput = document.createElement("input");
    this.volumeInput.type = "range";
    this.volumeInput.min = "0";
    this.volumeInput.max = "100";
    this.volumeInput.step = "1";
    this.volumeInput.value = String(Math.round(initial.volume * 100));
    this.volumeInput.addEventListener("input", () => {
      this.hooks.onVolume(Number(this.volumeInput.value) / 100);
    });
    volumeLabel.append(this.volumeInput);

    this.muteBtn = document.createElement("button");
    this.muteBtn.type = "button";
    this.muteBtn.className = "ctl ctl--mute";
    this.muteBtn.addEventListener("click", () => {
      this.muted = !this.muted;
      this.renderMute();
      this.hooks.onMute(this.muted);
    });

    this.speedBtn = document.createElement("button");
    this.speedBtn.type = "button";
    this.speedBtn.className = "ctl ctl--speed";
    this.speedBtn.addEventListener("click", () => {
      this.speed = this.speed >= 64 ? 8 : this.speed * 2;
      this.renderSpeed();
      this.hooks.onSpeed(this.speed);
    });

    this.restartBtn = document.createElement("button");
    this.restartBtn.type = "button";
    this.restartBtn.className = "ctl ctl--restart";
    this.restartBtn.addEventListener("click", () => {
      if (!this.restartPending) this.hooks.onRestart();
    });

    this.sessionChip = document.createElement("button");
    this.sessionChip.type = "button";
    this.sessionChip.className = "ctl ctl--session";
    this.sessionChip.hidden = true;
    this.sessionChip.addEventListener("click", () => {
      const id = this.sessionId;
      if (id !== undefined && typeof navigator?.clipboard?.writeText === "function") {
        void navigator.clipboard.writeText(id).catch(() => {
          // Clipboard may be denied; the chip text still shows the short id.
        });
      }
    });

    const status = document.createElement("div");
    status.className = "ctl ctl--status";
    this.statusDot = document.createElement("span");
    this.statusDot.className = "ctl__dot";
    this.statusText = document.createElement("span");
    this.statusText.className = "ctl__status-text";
    status.append(this.statusDot, this.statusText);

    wrap.append(
      this.modeBtn,
      volumeLabel,
      this.muteBtn,
      this.speedBtn,
      this.restartBtn,
      status,
      this.sessionChip,
    );
    this.root.append(wrap);

    this.renderMode();
    this.renderMute();
    this.renderSpeed();
    this.renderRestart();
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

  setConnection(state: ConnectionState): void {
    this.root.dataset.connection = state;
    this.renderStatus();
  }

  setAudio(playing: boolean, bufferedMs: number): void {
    this.root.dataset.playing = playing ? "1" : "0";
    this.bufferedMs = bufferedMs;
    this.renderStatus();
  }

  /** Restart-in-flight state: the button is disabled until the new session lands. */
  setRestartPending(pending: boolean): void {
    this.restartPending = pending;
    this.renderRestart();
  }

  /** Show the live session id (short) with click-to-copy of the full id. */
  setSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId;
    if (sessionId === undefined) {
      this.sessionChip.hidden = true;
      return;
    }
    this.sessionChip.hidden = false;
    this.sessionChip.title = `点击复制会话 ID：${sessionId}`;
    setText(this.sessionChip, `会话 ${sessionId.slice(0, 8)}`);
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

  private renderMute(): void {
    setText(this.muteBtn, this.muted ? "静音" : "有声");
    this.muteBtn.classList.toggle("ctl--active", this.muted);
  }

  private renderSpeed(): void {
    setText(this.speedBtn, `字速 ${this.speed}`);
  }

  private renderRestart(): void {
    this.restartBtn.disabled = this.restartPending;
    setText(this.restartBtn, this.restartPending ? "重开中…" : "重开");
  }
}
