/**
 * BgmController — 薄 <audio> 封装（spec §6.3）。
 * 观察 visualState.bgm；undefined（含 Core 已把 bgm stop 折叠成 undefined）
 * 即暂停清空。不接入 TTS PCM/AudioWorklet 管线。
 */
import type { BrowserAssetResolver } from "./browser-asset-resolver.js";

/** 生成曲播放态 sentinel（动态音乐生成）：apply() 的静态 id 空间不可能命中。 */
const GENERATED_ID = "__generated__";

export class BgmController {
  private currentId: string | undefined;
  private generatedUrl: string | undefined;
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
    if (url === undefined) return; // 未知/不可用：保持当前曲目
    this.audio.src = url;
    this.audio.loop = true;
    this.audio.volume = this.muted ? 0 : this.volume;
    void this.audio.play().catch(() => {});
  }

  /**
   * 生成曲直达播放（动态音乐生成）：blob URL 绕过资产目录。优先级语义
   * 「最新意图胜」——生成曲到达即接管；写手显式 @bgm（apply 的 id 值
   * 变化）随时压回。URL 生命周期由 GeneratedBgm 管理（替换时 revoke）。
   */
  applyGenerated(url: string): void {
    if (this.currentId === GENERATED_ID && this.generatedUrl === url) return;
    this.currentId = GENERATED_ID;
    this.generatedUrl = url;
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
