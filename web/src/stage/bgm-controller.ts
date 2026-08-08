/**
 * BgmController — 薄 <audio> 封装（spec §6.3）。
 * 观察 visualState.bgm；undefined（含 Core 已把 bgm stop 折叠成 undefined）
 * 即暂停清空。不接入 TTS PCM/AudioWorklet 管线。
 */
import type { BrowserAssetResolver } from "./browser-asset-resolver.js";

export class BgmController {
  private currentId: string | undefined;
  private readonly audio: HTMLAudioElement;
  private volume = 1;
  private muted = false;

  constructor(
    private readonly resolver: BrowserAssetResolver,
    createAudio: () => HTMLAudioElement = () => new Audio(),
  ) {
    this.audio = createAudio();
    this.audio.loop = true;
    this.audio.preload = "auto";
  }

  /** Start 手势内调用：0 音量播放一次首曲再暂停，解锁 autoplay 策略。 */
  unlock(): void {
    const firstId = Object.keys(this.resolver.manifest?.bgm ?? {})[0];
    if (firstId === undefined) return;
    const url = this.resolver.resolveBgm(firstId);
    if (url === undefined) return;
    this.audio.src = url;
    this.audio.volume = 0;
    void this.audio
      .play()
      .then(() => {
        this.audio.pause();
        this.audio.volume = this.muted ? 0 : this.volume;
      })
      .catch(() => {});
  }

  apply(id: string | undefined): void {
    if (id === this.currentId) return;
    this.currentId = id;
    if (id === undefined) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      return;
    }
    const url = this.resolver.resolveBgm(id);
    if (url === undefined) return; // 未知/不可用：保持静音
    this.audio.src = url;
    this.audio.loop = true;
    this.audio.volume = this.muted ? 0 : this.volume;
    void this.audio.play().catch(() => {});
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.audio.volume = this.muted ? 0 : this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.audio.volume = muted ? 0 : this.volume;
  }
}
