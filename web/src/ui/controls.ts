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
  /** Toggles the 回看 panel (reading history + voice replay). */
  onOpenBacklog(): void;
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
  private readonly settingsBtn: HTMLButtonElement;
  private readonly backlogBtn: HTMLButtonElement;
  private readonly restartBtn: HTMLButtonElement;
  private readonly sessionChip: HTMLButtonElement;
  private readonly statusDot: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly hooks: ControlsHooks;

  private mode: PlaybackMode = "manual";
  private restartPending = false;
  private sessionId: string | undefined;

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
      const next: PlaybackMode = this.mode === "manual" ? "auto" : "manual";
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

    this.backlogBtn = document.createElement("button");
    this.backlogBtn.type = "button";
    this.backlogBtn.className = "ctl ctl--backlog";
    this.backlogBtn.addEventListener("click", () => {
      this.hooks.onOpenBacklog();
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
      this.settingsBtn,
      this.backlogBtn,
      this.restartBtn,
      status,
      this.sessionChip,
    );
    this.root.append(wrap);

    this.renderMode();
    this.renderSettings();
    this.renderBacklog();
    this.renderRestart();
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

  setBacklogOpen(open: boolean): void {
    this.backlogBtn.classList.toggle("ctl--active", open);
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

  private renderSettings(): void {
    setText(this.settingsBtn, "设置");
  }

  private renderBacklog(): void {
    setText(this.backlogBtn, "回看");
  }

  private renderRestart(): void {
    this.restartBtn.disabled = this.restartPending;
    setText(this.restartBtn, this.restartPending ? "重开中…" : "重开");
  }
}
