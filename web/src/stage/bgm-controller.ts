/**
 * BgmController — 薄 <audio> 封装（spec §6.3）。
 * 观察 visualState.bgm；undefined（含 Core 已把 bgm stop 折叠成 undefined）
 * 即淡出后暂停清空。不接入 TTS PCM/AudioWorklet 管线。
 *
 * 播放微调（可配置，随 manifest 下发，见 resources.yaml bgm_playback）：
 * - 裁切窗口 start/end：窗口内循环（到达 end 回卷 start），循环由本类管理
 *   （帧回调 + timeupdate 双保险，后者覆盖后台标签页）；
 * - 淡入/淡出：开始播曲淡入、切歌与停止先淡出再接续（顺序式，单 <audio>）。
 * 无配置时行为与裸 <audio loop> 完全一致。
 */
import type { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { BgmPlayback } from "./stage-types.js";
import type { BgmBus } from "../audio/bgm-bus.js";
import type { DynamicsChainParams } from "@shared/wire/audio-dsp.js";

/** 窗口被时长钳制后小于该值视为退化配置，退回整曲循环。 */
const MIN_WINDOW_SEC = 0.05;

/** 时钟抽象：生产用 rAF + performance.now，测试手动驱动。 */
export interface BgmClock {
  now(): number;
  /** 单次帧回调；活动期间（渐变中/裁切监听中）由控制器自行续订。 */
  scheduleFrame(callback: () => void): void;
}

const defaultClock: BgmClock = {
  now: () => performance.now(),
  scheduleFrame: (callback) => {
    void requestAnimationFrame(callback);
  },
};

/** 一次音量渐变：gain 从 from 缓动到 to（线性）。 */
interface VolumeRamp {
  kind: "in" | "out";
  durationMs: number;
  elapsedMs: number;
  from: number;
  to: number;
}

/** 已解析的循环窗口；end 为 Infinity 表示「start 起播到文件尾后回卷」。 */
interface TrimWindow {
  start: number;
  end: number;
}

export class BgmController {
  private currentId: string | undefined;
  /** audio 元素当前装载的曲目（= 已真正开始/即将播放的）；currentId 是期望态。 */
  private loadedId: string | undefined;
  private readonly audio: HTMLAudioElement;
  private volume = 1;
  private muted = false;
  /** 音量乘数（淡入淡出进度），实际音量 = 目标音量 × gain。 */
  private gain = 1;
  private ramp: VolumeRamp | null = null;
  /** 淡出完成后要接续的动作（清空或起下一曲）。 */
  private afterFadeOut: (() => void) | null = null;
  private trim: TrimWindow | null = null;
  private frameQueued = false;
  private lastTick = 0;
  /**
   * Web Audio 图总线（可选，start 时由 GameApp 注入）。注入后淡入淡出写
   * bus.fadeGain（采样级精确），audio.volume 只承担用户音量/静音；null =
   * legacy 路径，淡入淡出继续并入 audio.volume（引入图之前的行为）。
   */
  private bus: BgmBus | null = null;

  constructor(
    private readonly resolver: BrowserAssetResolver,
    createAudio: () => HTMLAudioElement = () => new Audio(),
    private readonly clock: BgmClock = defaultClock,
  ) {
    this.audio = createAudio();
    this.audio.loop = true;
    this.audio.preload = "auto";
    this.audio.addEventListener("loadedmetadata", () => this.onMetadata());
    this.audio.addEventListener("timeupdate", () => this.enforceTrim());
    this.audio.addEventListener("ended", () => this.onEnded());
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
        this.applyVolume();
      })
      .catch(() => {});
  }

  apply(id: string | undefined): void {
    if (id === this.currentId) return;
    const prevLoaded = this.loadedId;
    this.currentId = id;
    if (id === undefined) {
      this.beginFadeOutThen(() => this.clearAudio());
      return;
    }
    if (this.resolver.resolveBgm(id) === undefined) return; // 未知/不可用：保持当前曲目
    if (prevLoaded === undefined) {
      // 全新起曲（或 stop 后复起）：startTrack 自会重置全部播放状态
      this.startTrack(id);
      return;
    }
    this.beginFadeOutThen(() => this.startTrack(id));
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.applyVolume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolume();
  }

  /** 供 GameApp 建立 BGM 图用（createMediaElementSource 需要元素本身）。 */
  get mediaElement(): HTMLAudioElement {
    return this.audio;
  }

  /**
   * 接入 Web Audio 图总线（start 手势后的启动期调用一次）。当前淡入淡出
   * 乘数原样迁入 fadeGain，切换瞬时无缝；之后淡入淡出走采样级 GainNode。
   */
  attachGraph(bus: BgmBus): void {
    this.bus = bus;
    bus.fadeGain.gain.value = this.gain;
    this.applyVolume();
  }

  /** BGM 链动态处理参数热更（无总线时静默忽略）。 */
  setDynamicsParams(params: DynamicsChainParams): void {
    this.bus?.setDynamicsParams(params);
  }

  // ---------------------------------------------------------------------------
  // 内部：曲目装载与渐变引擎
  // ---------------------------------------------------------------------------

  private playbackOf(id: string): BgmPlayback | undefined {
    return this.resolver.manifest?.bgm[id]?.playback;
  }

  private startTrack(id: string): void {
    const url = this.resolver.resolveBgm(id);
    if (url === undefined) {
      this.clearAudio();
      return;
    }
    const playback = this.playbackOf(id);
    this.loadedId = id;
    this.afterFadeOut = null;
    const start = playback?.start ?? 0;
    const end = playback?.end;
    this.trim =
      end !== undefined
        ? { start, end }
        : start > 0
          ? { start, end: Number.POSITIVE_INFINITY }
          : null;
    // 有窗口时原生 loop 必须关掉，回卷由 enforceTrim/onEnded 管理
    this.audio.loop = this.trim === null;
    this.audio.src = url;
    const fadeInMs = (playback?.fadeIn ?? 0) * 1000;
    if (fadeInMs > 0) {
      this.ramp = { kind: "in", durationMs: fadeInMs, elapsedMs: 0, from: 0, to: 1 };
      this.gain = 0;
    } else {
      this.ramp = null;
      this.gain = 1;
    }
    this.applyFadeGain();
    this.lastTick = this.clock.now();
    this.ensureLoop();
    void this.audio.play().catch(() => {});
  }

  /** 淡出当前曲目后执行 then；无可淡出（或时长 0）时立即执行。 */
  private beginFadeOutThen(then: () => void): void {
    this.afterFadeOut = then;
    if (this.loadedId === undefined) {
      this.runAfterFadeOut();
      return;
    }
    const fadeOutMs = (this.playbackOf(this.loadedId)?.fadeOut ?? 0) * 1000;
    if (fadeOutMs <= 0) {
      this.audio.pause();
      this.runAfterFadeOut();
      return;
    }
    if (this.ramp !== null && this.ramp.kind === "out") return; // 淡出已在途：只换接续动作
    this.ramp = {
      kind: "out",
      durationMs: fadeOutMs,
      elapsedMs: 0,
      from: this.gain,
      to: 0,
    };
    this.lastTick = this.clock.now();
    this.ensureLoop();
  }

  private runAfterFadeOut(): void {
    const then = this.afterFadeOut;
    this.afterFadeOut = null;
    then?.();
  }

  private clearAudio(): void {
    this.loadedId = undefined;
    this.trim = null;
    this.ramp = null;
    this.afterFadeOut = null;
    this.gain = 1;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.applyFadeGain();
  }

  private applyVolume(): void {
    const target = this.muted ? 0 : this.volume;
    if (this.bus !== null) {
      // 图模式：淡入淡出乘数在 fadeGain 上，元素只承担用户音量/静音。
      this.audio.volume = Math.min(1, Math.max(0, target));
      return;
    }
    this.audio.volume = Math.min(1, Math.max(0, target * this.gain));
  }

  /** 淡入淡出乘数落到生效点：图模式写 fadeGain，legacy 模式并入 audio.volume。 */
  private applyFadeGain(): void {
    if (this.bus !== null) {
      this.bus.fadeGain.gain.value = this.gain;
    } else {
      this.applyVolume();
    }
  }

  private onMetadata(): void {
    const trim = this.trim;
    if (trim !== null) {
      const duration = this.audio.duration;
      if (Number.isFinite(duration)) {
        trim.end = Math.min(trim.end, duration);
        if (trim.end - trim.start < MIN_WINDOW_SEC) {
          // 配置窗口超出实际时长（或 start 越过文件尾）：退回整曲循环
          this.trim = null;
          this.audio.loop = true;
        }
      }
      const seekTo = this.trim?.start ?? 0;
      if (seekTo > 0) {
        try {
          this.audio.currentTime = seekTo;
        } catch {
          // 个别浏览器在元数据刚就绪时 seek 会抛；错过窗口起点可接受
        }
      }
    }
    this.ensureLoop();
  }

  private enforceTrim(): void {
    const trim = this.trim;
    if (trim === null || !Number.isFinite(trim.end)) return;
    if (this.audio.currentTime >= trim.end) {
      this.audio.currentTime = trim.start;
    }
  }

  private onEnded(): void {
    if (this.loadedId === undefined || this.trim === null) return;
    // end 缺省（播到文件尾回卷）或钳制后正好播完的情形
    this.audio.currentTime = this.trim.start;
    void this.audio.play().catch(() => {});
  }

  private tick(now: number): void {
    const deltaMs = now - this.lastTick;
    this.lastTick = now;
    const ramp = this.ramp;
    if (ramp !== null) {
      ramp.elapsedMs += deltaMs;
      const progress = ramp.durationMs <= 0 ? 1 : Math.min(1, ramp.elapsedMs / ramp.durationMs);
      this.gain = ramp.from + (ramp.to - ramp.from) * progress;
      if (progress >= 1) {
        this.ramp = null;
        if (ramp.kind === "out") {
          this.audio.pause();
          this.runAfterFadeOut();
        }
      }
      this.applyFadeGain();
    }
    this.enforceTrim();
  }

  private ensureLoop(): void {
    if (this.frameQueued) return;
    this.frameQueued = true;
    this.clock.scheduleFrame(() => {
      this.frameQueued = false;
      this.tick(this.clock.now());
      if (this.ramp !== null || (this.trim !== null && !this.audio.paused)) {
        this.ensureLoop();
      }
    });
  }
}
