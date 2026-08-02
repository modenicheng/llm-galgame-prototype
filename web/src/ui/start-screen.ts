/**
 * StartScreen — the autoplay-unlock gate (§10.5). The Start click is the
 * single user gesture that creates/resumes the AudioContext, registers the
 * worklet and opens the Runtime WebSocket.
 */
import { setText, show } from "./dom.js";

export interface StartScreenHooks {
  onStart(): void | Promise<void>;
}

export class StartScreen {
  private readonly root: HTMLElement;
  private readonly btn: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly hooks: StartScreenHooks;

  constructor(root: HTMLElement, hooks: StartScreenHooks) {
    this.root = root;
    this.hooks = hooks;
    this.btn = root.querySelector(".btn--start") as HTMLButtonElement;
    this.hint = root.querySelector(".start-hint") as HTMLElement;
    this.warning = root.querySelector(".start-warning") as HTMLElement;
    this.btn.addEventListener("click", () => {
      void this.handleStart();
    });
  }

  show(): void {
    show(this.root, true);
  }

  hide(): void {
    show(this.root, false);
  }

  setBusy(busy: boolean): void {
    this.btn.disabled = busy;
    setText(this.hint, busy ? "正在启程……" : "点击后将启用声音，并建立本机会话连接");
  }

  setWarning(message: string | null): void {
    setText(this.warning, message ?? "");
    show(this.warning, message !== null && message.length > 0);
  }

  private async handleStart(): Promise<void> {
    if (this.btn.disabled) return;
    this.setBusy(true);
    try {
      await this.hooks.onStart();
    } finally {
      this.setBusy(false);
    }
  }
}
