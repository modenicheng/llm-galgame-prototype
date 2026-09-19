/**
 * AudioCoordinator — owns browser-side playback policy (§12.2, §9.3).
 *
 * One shared AudioContext + one AudioWorklet node for ALL lines (§10.4);
 * the context is created by the caller (the Wave-2 UI owns the user-gesture
 * that unlocks autoplay) and never reconstructed here. PCM never travels
 * over the runtime WebSocket (§22 invariant 12); it arrives via feedPcm.
 *
 * Responsibilities:
 * - Startup buffer (§10.3): a line's first `startup_buffer_ms` of samples
 *   accumulate before the worklet is fed and playback starts.
 * - Timeline: lines are enqueued in order; skip() jumps ahead and drops
 *   unplayed samples; bufferedAheadMs() drives the low-watermark scheduler.
 * - Modes (§9.3): manual advances on start(); auto emits
 *   onLinePlaybackFinished after pause_after_ms and lets the UI advance.
 */
import type { PublicWebConfig } from "@shared/wire/public-web-config.js";
import type { DynamicsChainParams } from "@shared/wire/audio-dsp.js";
import { AudioTimeline } from "./audio-timeline.js";
import workletSource from "./pcm-worklet.js?raw";
import dynamicsWorkletSource from "./dynamics-worklet.js?raw";

export interface AudioCoordinatorOptions {
  context: AudioContext;
  playbackConfig: PublicWebConfig["audio"]["playback"];
  format: PublicWebConfig["audio"]["format"];
  /** 语音链动态处理参数（gate→压缩→限幅）；缺省走 worklet 内置默认。 */
  dspParams?: DynamicsChainParams;
}

export type PlaybackMode = "manual" | "auto";

/** dynamics worklet 的遥测快照（≈21ms 一次）。 */
export interface VoiceAudioState {
  outDb: number;
  gateOpen: boolean;
  compGrDb: number;
  limGrDb: number;
}

export interface AudioCoordinatorEvents {
  onLinePlaybackStarted(lineId: string): void;
  onLinePlaybackFinished(lineId: string): void;
  onUnderrun(): void;
  /** 语音链电平遥测；BgmDucker（闪避）与监控仪表的消费入口。 */
  onAudioState?(state: VoiceAudioState): void;
}

export class AudioCoordinator {
  private readonly context: AudioContext;
  private readonly playbackConfig: PublicWebConfig["audio"]["playback"];
  private readonly sampleRate: number;
  private readonly events: AudioCoordinatorEvents;
  private readonly timeline: AudioTimeline;
  /** Samples fed per line but not yet handed to the worklet. */
  private readonly pendingByLine = new Map<string, Int16Array[]>();

  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  /** 语音链动态处理节点（可选增强；加载失败保持 null，链路直连旁路）。 */
  private dynamicsNode: AudioWorkletNode | null = null;
  private dspParams: DynamicsChainParams | null;

  private mode: PlaybackMode = "manual";
  private volume = 1;
  private muted = false;
  /**
   * 回看挂起（app 在回看面板打开时置位）：样本照常入队、累积，但永不
   * arm 起播，EOF 也不触发空行完结（完结会引发 app 的自动推进）。
   * 恢复由 app 在关面板时解除挂起并 start() 当前行。
   */
  private suspended = false;

  private currentLineId: string | null = null;
  private playbackStarted = false;
  private startupSamples = 0;
  private fedForCurrentLine = 0;
  private playbackStartMs = 0;
  /**
   * Lines whose producer has signalled EOF (§10.6): the HTTP stream was
   * fully consumed (or failed) and no more PCM will arrive. Playback of
   * such a line finishes only after the worklet reports `drained`.
   */
  private readonly producerEof = new Set<string>();
  /** Pending start (voice_delay_ms) — playback begins only after it fires. */
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AudioCoordinatorOptions, events: AudioCoordinatorEvents) {
    this.context = options.context;
    this.playbackConfig = options.playbackConfig;
    this.sampleRate = options.format.sampleRate;
    this.dspParams = options.dspParams ?? null;
    this.events = events;
    this.timeline = new AudioTimeline(this.sampleRate);
  }

  /** Load the worklet module and create the (single) playback node. */
  async init(): Promise<void> {
    if (this.workletNode) {
      return;
    }
    // Environment capability check (§10.5): older browsers / embedded
    // webviews may expose AudioContext without AudioWorklet support. Only
    // THIS genuinely missing capability degrades to text-only — a failing
    // addModule is a build/network bug and must not be silently hidden.
    const contextNodeFactory = (
      this.context as AudioContext & {
        createAudioWorkletNode?: (name: string, options?: AudioWorkletNodeOptions) => AudioWorkletNode;
      }
    ).createAudioWorkletNode;
    if (
      (typeof contextNodeFactory !== "function" && typeof AudioWorkletNode === "undefined") ||
      this.context.audioWorklet === undefined
    ) {
      return;
    }
    // Vite 8 inlines `?url` imports as a `data:` URL, which
    // audioWorklet.addModule() rejects (same-origin / blob only per spec).
    // Load the source via `?raw` and give the worklet a blob: URL instead
    // — works identically in dev and in the production bundle.
    const blob = new Blob([workletSource], { type: "application/javascript" });
    const workletUrl = URL.createObjectURL(blob);
    // The OS/browser can suspend the AudioContext mid-session (device switch,
    // exclusive mode, bluetooth takeover, power saving). While suspended the
    // worklet is not pulled, `drained` never fires and playback silently
    // wedges — attempt an automatic resume whenever that happens. A rejected
    // resume (rare, mostly mobile gesture requirements) simply waits for the
    // next statechange event.
    this.context.addEventListener("statechange", () => {
      if (this.context.state === "suspended") {
        void this.context.resume().catch(() => {
          // resume() can reject without a user gesture; the next statechange
          // (or any click that reaches the page) retries.
        });
      }
    });
    try {
      await this.context.audioWorklet.addModule(workletUrl);
      const options: AudioWorkletNodeOptions = {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { sourceRate: this.sampleRate },
      };
      const node =
        typeof contextNodeFactory === "function"
          ? contextNodeFactory.call(this.context, "pcm-playback", options)
          : new AudioWorkletNode(this.context, "pcm-playback", options);
      const gain = this.context.createGain();
      gain.gain.value = this.muted ? 0 : this.volume;
      // 动态处理链（gate→压缩→限幅）是可选增强：加载失败只旁路，绝不
      // 升级为致命错误（与上面 pcm-playback 的 fail-fast 不同级）。
      const dynamics = await this.initDynamicsNode(contextNodeFactory);
      if (dynamics !== null) {
        node.connect(dynamics);
        dynamics.connect(gain);
        dynamics.port.onmessage = (event: MessageEvent) => {
          this.handleDynamicsMessage(event);
        };
        if (this.dspParams !== null) {
          dynamics.port.postMessage({ type: "params", params: this.dspParams });
        }
        this.dynamicsNode = dynamics;
      } else {
        node.connect(gain);
      }
      gain.connect(this.context.destination);
      node.port.onmessage = (event: MessageEvent) => {
        this.handleWorkletMessage(event);
      };
      this.workletNode = node;
      this.gainNode = gain;
      if (this.playbackStarted && this.currentLineId !== null) {
        // Samples fed before the worklet existed were kept queued
        // (beginPlayback could not flush them) — hand them over now.
        this.flushPending(this.currentLineId);
      }
    } finally {
      // The blob URL is only needed during addModule; revoke it once the
      // module is loaded (or the attempt failed) to avoid leaking.
      URL.revokeObjectURL(workletUrl);
    }
  }

  /** Feed decoded PCM for a line. Future lines are buffered, not played. */
  feedPcm(lineId: string, samples: Int16Array): void {
    this.timeline.queueSamples(lineId, samples.length);
    let chunks = this.pendingByLine.get(lineId);
    if (!chunks) {
      chunks = [];
      this.pendingByLine.set(lineId, chunks);
    }
    chunks.push(samples);
    if (lineId !== this.currentLineId) {
      return; // future line — queued for when its turn comes
    }
    this.fedForCurrentLine += samples.length;
    if (!this.playbackStarted) {
      this.startupSamples += samples.length;
      if (this.startupSamples >= this.startupThresholdSamples()) {
        this.armPlaybackStart();
      }
    } else {
      this.flushPending(lineId);
    }
  }

  /**
   * The producer has finished feeding PCM for `lineId` (§10.6). No more
   * samples will arrive, so a line below the startup threshold can start
   * immediately, and a playing line finishes once the worklet drains.
   */
  notifyLineEof(lineId: string): void {
    if (lineId !== this.currentLineId) {
      // Dropped lines (dropLine removed both the timeline segment and any
      // pending chunks) must not re-enter the tracking set via a late EOF
      // from an aborted downloader — the set is only cleaned for the
      // current line.
      if (
        !this.timeline.hasSegment(lineId) &&
        this.pendingByLine.get(lineId) === undefined
      ) {
        return;
      }
      // Not the active line — recorded; switchToLine consults it later.
      this.producerEof.add(lineId);
      return;
    }
    if (!this.playbackStarted) {
      if (this.linePendingCount(lineId) === 0 || this.workletNode === null) {
        if (this.suspended) {
          // 挂起中不完结：finishLine 会触发 onLinePlaybackFinished →
          // 自动推进，玩家还在回看面板里读历史。恢复时 start() 接管。
          this.producerEof.add(lineId);
          return;
        }
        // Nothing playable (empty stream) or no playback path (degraded
        // environment) — the line is done without ever starting.
        this.finishLine(lineId);
        return;
      }
      this.producerEof.add(lineId);
      this.armPlaybackStart(); // EOF overrides the startup-buffer gate
      return;
    }
    this.producerEof.add(lineId);
    if (this.workletNode === null) {
      // Degraded environment: samples were never handed to a worklet, so no
      // drained event can ever arrive — finish on EOF directly.
      this.finishLine(lineId);
      return;
    }
    // Tell the worklet no more samples will arrive: its final dry block is a
    // normal completion, not a starvation underrun.
    this.postWorkletMessage({ type: "eof", lineId });
    // playing with a worklet — finishLine fires on drained
  }

  enqueueLine(lineId: string, cacheKey: string, pauseBeforeMs: number, pauseAfterMs: number): void {
    this.timeline.append({ lineId, cacheKey, pauseBeforeMs, pauseAfterMs });
  }

  /** Begin playback of the given line, dropping any unplayed lines before it. */
  start(lineId: string): void {
    this.switchToLine(lineId);
  }

  /** Jump the timeline to `lineId`, halting current playback and clearing unplayed audio. */
  skip(lineId: string): void {
    this.switchToLine(lineId);
  }

  /** Halt current line playback (silent — no finished event). */
  stop(): void {
    this.cancelStartTimer();
    this.postWorkletMessage({ type: "clear" });
    if (this.currentLineId !== null) {
      this.producerEof.delete(this.currentLineId);
    }
    this.currentLineId = null;
    this.playbackStarted = false;
    this.startupSamples = 0;
    this.fedForCurrentLine = 0;
  }
  /**
   * Remove a line entirely (§12.5 invalidation): its timeline segment,
   * queued sample count and any not-yet-fed pending PCM. When the line is
   * the current one, playback halts silently — dead audio must not keep
   * bufferedAheadMs, the finish timer or the worklet feed alive.
   */
  dropLine(lineId: string): void {
    if (lineId === this.currentLineId) {
      this.cancelStartTimer();
      this.postWorkletMessage({ type: "clear" });
      this.currentLineId = null;
      this.playbackStarted = false;
      this.startupSamples = 0;
      this.fedForCurrentLine = 0;
    }
    this.producerEof.delete(lineId);
    this.timeline.remove(lineId);
    this.pendingByLine.delete(lineId);
  }

  setMode(mode: PlaybackMode): void {
    this.mode = mode;
  }

  /**
   * 回看挂起/恢复。挂起即停：撤掉待起的 start 计时、清空 worklet 在播
   * 内容并退回未起播态——未喂入 worklet 的 pending 样本保持累积（挂起期
   * 下载/缓存的当前行样本不丢），恢复时 start() 会按剩余样本重新武装。
   */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (!suspended) return;
    this.cancelStartTimer();
    this.postWorkletMessage({ type: "clear" });
    if (this.currentLineId !== null) {
      this.playbackStarted = false;
      this.startupSamples = this.linePendingCount(this.currentLineId);
      this.fedForCurrentLine = this.startupSamples;
    }
  }

  /** False when the environment lacks AudioWorklet (text-only mode). */
  get available(): boolean {
    return this.workletNode !== null;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  /**
   * 语音链动态处理参数热更（/monitor 保存 → runtime WS 推送）。节点未就绪
   * （降级环境）时只记录参数，init 时或不可用——不报错。
   */
  setDynamicsParams(params: DynamicsChainParams): void {
    this.dspParams = params;
    this.dynamicsNode?.port.postMessage({ type: "params", params });
  }

  /**
   * 语音链的 DSP 输入端（dynamics 节点）。回看回放并入此节点以共享同一路
   * 动态处理与音量；null = 降级环境（无 dynamics），回放保持自有路径。
   */
  get voiceChainInput(): AudioNode | null {
    return this.dynamicsNode;
  }

  bufferedAheadMs(): number {
    return this.timeline.contiguousBufferedMs();
  }

  isPlaying(): boolean {
    // The start-timer window counts as playing: a scene change or choice
    // interaction during voice_delay_ms must halt the pending start too.
    return (this.playbackStarted || this.startTimer !== null) && this.currentLineId !== null;
  }

  private switchToLine(lineId: string): void {
    if (!this.timeline.hasSegment(lineId)) {
      return; // unknown line — never enqueued, so nothing to play
    }
    if (lineId === this.currentLineId && this.playbackStarted) {
      return; // already playing this line — restarting would drop audio mid-line
    }
    this.cancelStartTimer();
    this.postWorkletMessage({ type: "clear" });
    this.currentLineId = lineId;
    this.playbackStarted = false;
    this.startupSamples = 0;
    this.fedForCurrentLine = 0;
    this.timeline.skipTo(lineId);
    // Drop samples of lines that skipTo removed from the timeline.
    for (const key of [...this.pendingByLine.keys()]) {
      if (!this.timeline.hasSegment(key)) {
        this.pendingByLine.delete(key);
      }
    }
    const pending = this.linePendingCount(lineId);
    this.startupSamples = pending;
    this.fedForCurrentLine = pending;
    if (this.producerEof.has(lineId)) {
      if (pending === 0 || this.workletNode === null) {
        // Nothing playable (empty stream) or no playback path (degraded
        // environment) — the line is done without ever starting.
        this.finishLine(lineId);
        return;
      }
      this.armPlaybackStart(); // EOF: start even below the threshold
      return;
    }
    if (pending >= this.startupThresholdSamples()) {
      this.armPlaybackStart();
    }
  }
  /** Start the voice_delay_ms countdown; playback begins when it fires. */
  private armPlaybackStart(): void {
    if (this.playbackStarted || this.startTimer !== null) {
      return; // already started or already counting down
    }
    if (this.suspended) {
      return; // 回看挂起：样本继续攒，不起播
    }
    const lineId = this.currentLineId;
    if (lineId === null) {
      return;
    }
    const delayMs = this.playbackConfig.voice_delay_ms ?? 0;
    if (delayMs <= 0) {
      this.beginPlayback();
      return;
    }
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.beginPlayback();
    }, delayMs);
  }

  private beginPlayback(): void {
    const lineId = this.currentLineId;
    if (lineId === null || this.playbackStarted) {
      return;
    }
    this.playbackStarted = true;
    this.playbackStartMs = performance.now();
    this.flushPending(lineId);
    // May reject under autoplay policy; the UI resumes inside the user gesture.
    void this.context.resume().catch(() => {});
    this.events.onLinePlaybackStarted(lineId);
  }

  private cancelStartTimer(): void {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  private finishLine(lineId: string): void {
    if (this.currentLineId !== lineId) {
      return; // line was skipped or stopped while the drain was pending
    }
    this.currentLineId = null;
    this.playbackStarted = false;
    this.startupSamples = 0;
    this.fedForCurrentLine = 0;
    this.producerEof.delete(lineId);
    this.events.onLinePlaybackFinished(lineId);
  }

  private flushPending(lineId: string): void {
    const chunks = this.pendingByLine.get(lineId);
    if (!chunks || chunks.length === 0 || !this.workletNode) {
      return; // keep queued until the node exists
    }
    // Mark the line before flushing so the worklet can report drained.
    this.postWorkletMessage({ type: "line", lineId });
    for (const chunk of chunks) {
      this.postWorkletMessage(chunk);
    }
    this.pendingByLine.delete(lineId);
    // Cache-fed lines may already be at EOF before playback reaches them —
    // forward the marker so their completion is not misread as underrun.
    if (this.producerEof.has(lineId)) {
      this.postWorkletMessage({ type: "eof", lineId });
    }
  }

  private linePendingCount(lineId: string): number {
    const chunks = this.pendingByLine.get(lineId);
    if (!chunks) {
      return 0;
    }
    let total = 0;
    for (const chunk of chunks) {
      total += chunk.length;
    }
    return total;
  }

  private startupThresholdSamples(): number {
    return Math.ceil((this.playbackConfig.startup_buffer_ms / 1000) * this.sampleRate);
  }

  private postWorkletMessage(message: unknown): void {
    this.workletNode?.port.postMessage(message);
  }

  private handleWorkletMessage(event: MessageEvent): void {
    const data: unknown = event.data;
    if (data === null || typeof data !== "object" || !("type" in data)) {
      return;
    }
    if (data.type === "underrun") {
      this.events.onUnderrun();
      return;
    }
    if (data.type === "drained") {
      const lineId = (data as { type: string; lineId?: unknown }).lineId;
      if (
        typeof lineId === "string" &&
        this.currentLineId === lineId &&
        this.producerEof.has(lineId)
      ) {
        this.finishLine(lineId);
      }
    }
  }

  private applyGain(): void {
    if (this.gainNode) {
      this.gainNode.gain.value = this.muted ? 0 : this.volume;
    }
  }

  /**
   * Load the (optional) voice dynamics worklet. Returns null when the module
   * or node cannot be created — the caller then wires the plain topology.
   */
  private async initDynamicsNode(
    contextNodeFactory:
      | ((name: string, options?: AudioWorkletNodeOptions) => AudioWorkletNode)
      | undefined,
  ): Promise<AudioWorkletNode | null> {
    try {
      // 与 pcm-playback 相同的 blob URL 模式（Vite ?raw，见 init 内注释）。
      const blob = new Blob([dynamicsWorkletSource], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      try {
        await this.context.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      const options: AudioWorkletNodeOptions = {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      };
      const node =
        typeof contextNodeFactory === "function"
          ? contextNodeFactory.call(this.context, "dynamics", options)
          : new AudioWorkletNode(this.context, "dynamics", options);
      return node;
    } catch (error) {
      console.warn("[audio] dynamics worklet unavailable — voice DSP bypassed", error);
      return null;
    }
  }

  private handleDynamicsMessage(event: MessageEvent): void {
    const data = event.data as { type?: unknown; outDb?: unknown; gateOpen?: unknown; compGrDb?: unknown; limGrDb?: unknown } | null;
    if (data === null || typeof data !== "object" || data.type !== "state") {
      return;
    }
    if (
      typeof data.outDb !== "number" ||
      typeof data.gateOpen !== "boolean" ||
      typeof data.compGrDb !== "number" ||
      typeof data.limGrDb !== "number"
    ) {
      return;
    }
    this.events.onAudioState?.({
      outDb: data.outDb,
      gateOpen: data.gateOpen,
      compGrDb: data.compGrDb,
      limGrDb: data.limGrDb,
    });
  }
}
