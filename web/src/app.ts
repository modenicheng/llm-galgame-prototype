/**
 * GameApp — the browser session composition root (V2 §9, §10.5, §12.2).
 *
 * Owns the projection (GameViewModel), the Runtime WebSocket (RuntimeClient),
 * the playback policy (AudioCoordinator), the IndexedDB cache
 * (AudioCacheWriter/Reader/Cleaner), the TTS download pipeline
 * (AudioDownloader) and the low-watermark reconcile loop. It never reads
 * Game internals and never calls the LLM/TTS directly — the only values the
 * browser submits are {taskId, lineId, cacheKey} + the session token
 * (§22 invariants 2/3/9).
 *
 * The AudioContext is created by the caller (main.ts) inside the user
 * gesture that unlocks autoplay (§10.5) and handed to `start()`; this module
 * imports ONLY @shared/wire, sibling web modules and platform types.
 */
import type { AudioDescriptor, AudioPriority } from "@shared/wire/audio-descriptor.js";
import type { PublicWebConfig } from "@shared/wire/public-web-config.js";
import type { ServerMessage } from "@shared/wire/server-message.js";
import { AudioCoordinator, type AudioCoordinatorEvents, type PlaybackMode } from "./audio/audio-coordinator.js";
import { AudioDownloader } from "./audio/audio-downloader.js";
import { ClipPlayer } from "./audio/clip-player.js";
import { PcmDecoder } from "./audio/pcm-decoder.js";
import { RuntimeClient, type ConnectionState, type RuntimeCommandWire, type WebSocketCtor } from "./runtime/runtime-client.js";
import { GameViewModel, type RuntimePlayableEventWire, type ViewModelState } from "./runtime/game-view-model.js";
import { BacklogStore, type BacklogEntry } from "./runtime/backlog-store.js";
import type { BgmController } from "./stage/bgm-controller.js";
import type { StageCueWire } from "./stage/stage-types.js";
import { AudioDb } from "./storage/audio-db.js";
import { AudioCacheWriter, type CacheWriteOptions } from "./storage/audio-cache-writer.js";
import { AudioCacheReader } from "./storage/audio-cache-reader.js";
import { AudioCacheCleaner, type CleanerOptions } from "./storage/audio-cache-cleaner.js";
import { DEFAULT_PLAYER_SETTINGS, type PlayerSettings } from "./storage/player-settings.js";
import { randomId } from "./random-id.js";

/** §10.3 + §11.4 + §17.5 fallback values, used when GET /api/config is absent. */
export const DEFAULT_PUBLIC_WEB_CONFIG: PublicWebConfig = {
  audio: {
    playback: {
      startup_buffer_ms: 350,
      critical_watermark_ms: 500,
      low_watermark_ms: 2500,
      target_buffer_ms: 6500,
      voice_delay_ms: 0,
    },
    cache: {
      write_batch_bytes: 262144,
      write_flush_interval_ms: 300,
    },
    format: {
      encoding: "pcm_s16le",
      sampleRate: 22050,
      channels: 1,
      bitDepth: 16,
    },
  },
  game: {
    show_line_ids: false,
  },
};

/** §17.5 cache cleaner defaults (not part of the public config). */
const CLEANER_DEFAULTS: CleanerOptions = {
  maxBytes: 536870912,
  cleanupTargetBytes: 402653184,
  partialTtlMinutes: 10,
  candidateTtlHours: 1,
};

const BUFFER_REPORT_INTERVAL_MS = 2000;
const CLEANER_INTERVAL_MS = 10 * 60 * 1000;
/** Reading-rate fallback for auto mode when a line has no audio (§9.3). */
const READING_CHARS_PER_SEC = 5;

export interface GameAppOptions {
  /** e.g. `ws://127.0.0.1:port/ws/runtime`; the token is appended by RuntimeClient. */
  wsUrl: string;
  token: string;
  /** Preloaded server config; when omitted the app fetches GET /api/config. */
  config?: PublicWebConfig;
  /** Optional BGM playback controller; when absent bgm volume/mute stay app-only. */
  bgmController?: BgmController;
  /** Restored player preferences (volumes/mute/speed); defaults when absent. */
  initialSettings?: PlayerSettings;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  webSocketImpl?: WebSocketCtor;
  db?: AudioDb;
}

export interface GameAppState {
  view: ViewModelState;
  connection: ConnectionState;
  playbackMode: PlaybackMode;
  /** 语音（TTS）音量，0..1；独立于 BGM。 */
  voiceVolume: number;
  /** BGM 音量，0..1；独立于语音。 */
  bgmVolume: number;
  muted: boolean;
  textSpeed: number;
  audioPlaying: boolean;
  bufferedAheadMs: number;
  underrunCount: number;
  configSource: "server" | "defaults";
  showLineIds: boolean;
  /** Non-null when the last start() attempt failed (P2 start-failure wedge). */
  startError: string | null;
  /** 回看面板开着：剧情推进（点击/自动）被挂起，语音停播。 */
  backlogOpen: boolean;
  /** 正在回放的行（回看面板）；null = 无回放在播。 */
  replayLineId: string | null;
}

interface DescriptorEntry {
  descriptor: AudioDescriptor;
  /** Audio acquisition state for the line. */
  state: "idle" | "checking" | "downloading" | "cached" | "failed";
  /** True once samples were handed to the coordinator (any path). */
  fed: boolean;
  taskId: string | null;
  abort: AbortController | null;
  /** The in-flight startDownload promise; null once it settles. */
  download: Promise<void> | null;
  /** `task_status finished` arrived while the HTTP body was still draining —
   * the cache asset is sealed complete only after the drain ends (P1 race). */
  pendingFinish: boolean;
  /** Client-side retry budget for transient synthesis failures. */
  retries: number;
}

/** The portion of LinePerformance the browser is allowed to read. */
interface PauseInfo {
  pause_after_ms?: number;
}

const PRIORITY_RANK: Record<AudioPriority, number> = {
  current: 0,
  next: 1,
  active_future: 2,
  candidate_first_line: 3,
  background: 4,
};

export class GameApp {
  private readonly options: GameAppOptions;
  private readonly viewModel = new GameViewModel();
  private readonly backlog = new BacklogStore();
  private readonly db: AudioDb;
  private readonly bgmController: BgmController | null;
  private readonly listeners = new Set<(s: GameAppState) => void>();

  private client: RuntimeClient | null = null;
  private coordinator: AudioCoordinator | null = null;
  /** 回看面板的缓存音频回放器（start 时随 AudioContext 创建）。 */
  private clipPlayer: ClipPlayer | null = null;
  private writer: AudioCacheWriter | null = null;
  private reader: AudioCacheReader | null = null;
  private cleaner: AudioCacheCleaner | null = null;
  private downloader: AudioDownloader | null = null;

  private config: PublicWebConfig = DEFAULT_PUBLIC_WEB_CONFIG;
  private configSource: "server" | "defaults" = "defaults";
  private connection: ConnectionState = "closed";
  private playbackMode: PlaybackMode = "manual";
  private voiceVolume: number;
  private bgmVolume: number;
  private muted: boolean;
  private textSpeed: number;
  private audioPlaying = false;
  private underrunCount = 0;

  private readonly descriptors = new Map<string, DescriptorEntry>();
  private readonly enqueued = new Set<string>();
  private readonly cacheDecoders = new Map<string, PcmDecoder>();
  private currentLineId: string | null = null;
  /** Consecutive cache lookup failures; ≥3 trips the unhealthy breaker. */
  private cacheFailures = 0;
  /** Once true, cache lookups are skipped (downloads serve directly). */
  private cacheUnhealthy = false;
  /** Last session id seen in the projection; a change means restart. */
  private lastSessionId: string | null = null;

  private started = false;
  /** Start failure surfaced to the UI banner (P2 start-failure wedge). */
  private startError: string | null = null;
  private bufferTimer: ReturnType<typeof setInterval> | null = null;
  private cleanerTimer: ReturnType<typeof setTimeout> | null = null;
  private readingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Auto-mode pause before the post-playback advance (§9.3). */
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  /** 回看面板开着：故事推进挂起（点击被遮罩挡、自动定时器全撤）。 */
  private backlogOpen = false;
  /** 当前正在回放的行（回看面板）；null = 无回放。 */
  private replayLineId: string | null = null;
  /** Last projection-seq seen in the view model — a bump seeds the backlog
   * from `recentLines` (reconnect restore covers the lost window's tail). */
  private lastProjectionSeq = 0;
  /** 已写入回看的引子所属 session（一局一次；重连重复投影不重写）。 */
  private introPushedFor: string | null = null;

  constructor(options: GameAppOptions) {
    this.options = options;
    this.db = options.db ?? new AudioDb();
    this.bgmController = options.bgmController ?? null;
    const initial = options.initialSettings ?? DEFAULT_PLAYER_SETTINGS;
    this.voiceVolume = clampUnit(initial.voiceVolume);
    this.bgmVolume = clampUnit(initial.bgmVolume);
    this.muted = initial.muted;
    this.textSpeed = clampSpeed(initial.textSpeed);
    // The BGM controller predates start(): apply the restored values now so
    // the first unlocked track already plays at the persisted level.
    this.bgmController?.setVolume(this.bgmVolume);
    this.bgmController?.setMuted(this.muted);
    this.viewModel.subscribe(() => this.handleViewNotify());
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Begin the session. `context` must have been created/resumed inside the
   * Start click gesture (§10.5): load config → register the worklet →
   * open the cache → open the WebSocket (sends `client.ready`).
   */
  async start(context: AudioContext): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      try {
        this.config = await this.loadConfig();
      } catch {
        this.config = DEFAULT_PUBLIC_WEB_CONFIG;
        this.configSource = "defaults";
      }

      this.coordinator = new AudioCoordinator(
        {
          context,
          playbackConfig: this.config.audio.playback,
          format: this.config.audio.format,
        },
        this.coordinatorEvents,
      );
      // The coordinator constructor cannot know the restored preferences —
      // push them before any playback starts (init only builds the node).
      this.coordinator.setVolume(this.voiceVolume);
      this.coordinator.setMuted(this.muted);
      // AudioWorklet is optional (§10.5): a capability miss (no standard
      // AudioWorkletNode constructor / audioWorklet) degrades to text-only.
      // But a THROWN init (addModule fetch/CSP/network failure) is a real
      // bug — surface it instead of silently swallowing into text-only.
      try {
        await this.coordinator.init();
      } catch (error) {
        this.coordinator.stop();
        this.coordinator = null;
        this.startError = error instanceof Error ? error.message : String(error);
        this.emitState();
        throw error;
      }
      if (this.coordinator !== null && !this.coordinator.available) {
        this.coordinator = null;
      }
      // The cache is a performance cache, not story truth: a failed open
      // (corruption, quota, private mode) degrades to a no-cache session —
      // the db stays `available=false`, every writer/reader/cleaner call
      // no-ops by design, and streaming playback continues without it.
      try {
        await this.db.open();
      } catch (error) {
        console.warn("[audio] IndexedDB open failed — continuing without cache", error);
      }
      const writeOptions: CacheWriteOptions = {
        writeBatchBytes: this.config.audio.cache.write_batch_bytes,
        flushIntervalMs: this.config.audio.cache.write_flush_interval_ms,
      };
      this.writer = new AudioCacheWriter(this.db, writeOptions);
      this.reader = new AudioCacheReader(this.db);
      this.cleaner = new AudioCacheCleaner(this.db, CLEANER_DEFAULTS);
      // 回看回放器与主管线共享同一个已解锁的 AudioContext。
      this.clipPlayer = new ClipPlayer(context);
      this.clipPlayer.setVolume(this.voiceVolume);
      this.clipPlayer.setMuted(this.muted);
      this.downloader = new AudioDownloader({
        token: this.options.token,
        writer: this.writer,
        decoder: () => new PcmDecoder(),
        onPcm: (lineId, samples) => this.onPcm(lineId, samples),
        onEof: (lineId) => this.coordinator?.notifyLineEof(lineId),
        ...(this.options.fetchImpl !== undefined
          ? { fetchImpl: this.options.fetchImpl }
          : {}),
      });

      this.client = new RuntimeClient({
        wsUrl: this.options.wsUrl,
        token: this.options.token,
        onServerMessage: (msg) => this.onServerMessage(msg),
        onConnectionChange: (state) => {
          this.connection = state;
          if (state === "open") this.startBufferReports();
          this.emitState();
        },
        ...(this.options.webSocketImpl !== undefined
          ? { webSocketImpl: this.options.webSocketImpl }
          : {}),
      });
      void this.client.connect();

      void this.runCleaner();
      this.startError = null;
      this.emitState();
    } catch (error) {
      // A throwing init step (worklet registration, IndexedDB open) must not
      // wedge the session: reset the gate so a retry constructs everything
      // fresh, tear down whatever was half-built, and surface the error.
      this.started = false;
      this.client?.close();
      this.client = null;
      this.coordinator?.stop();
      this.coordinator = null;
      this.startError = error instanceof Error ? error.message : String(error);
      this.emitState();
      throw error;
    }
  }

  /** Tear down the WebSocket and all timers; the cache stays on disk. */
  stop(): void {
    this.client?.close();
    this.client = null;
    this.stopBufferReports();
    this.cancelReadingTimer();
    this.cancelPauseTimer();
    this.stopReplay();
    if (this.cleanerTimer !== null) {
      clearTimeout(this.cleanerTimer);
      this.cleanerTimer = null;
    }
    this.coordinator?.stop();
    this.emitState();
  }

  subscribe(listener: (s: GameAppState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  state(): GameAppState {
    return {
      view: this.viewModel.state(),
      connection: this.connection,
      playbackMode: this.playbackMode,
      voiceVolume: this.voiceVolume,
      bgmVolume: this.bgmVolume,
      muted: this.muted,
      textSpeed: this.textSpeed,
      audioPlaying: this.audioPlaying,
      bufferedAheadMs: Math.round(this.coordinator?.bufferedAheadMs() ?? 0),
      underrunCount: this.underrunCount,
      configSource: this.configSource,
      showLineIds: this.config.game.show_line_ids,
      startError: this.startError,
      backlogOpen: this.backlogOpen,
      replayLineId: this.replayLineId,
    };
  }

  /**
   * 取走并清空暂存的瞬态演出 cues（spec §6.4）。UI 渲染层在消费
   * visualState 时调用一次；重连投影恢复不重放（applyProjection 已清空）。
   */
  consumeCues(): StageCueWire[] {
    return this.viewModel.consumeCues();
  }

  // -------------------------------------------------------------------------
  // Player commands (§9.3)
  // -------------------------------------------------------------------------

  /** Manual advance: halt local playback immediately and ask the runtime. */
  advance(): void {
    if (this.backlogOpen) return; // 回看打开时剧情不推进（遮罩挡点击，这里挡键盘路径）
    this.cancelReadingTimer();
    this.cancelPauseTimer();
    this.coordinator?.stop();
    this.sendCommand({ type: "advance" });
  }

  selectChoice(optionId: string): void {
    const interaction = this.viewModel.state().currentInteraction;
    const id = interactionIdOf(interaction);
    if (id === null) return;
    this.sendCommand({ type: "select_choice", interactionId: id, optionId });
  }

  submitInput(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const interaction = this.viewModel.state().currentInteraction;
    const id = interactionIdOf(interaction);
    if (id === null) return;
    this.sendCommand({ type: "preview_input", interactionId: id, text: trimmed });
  }

  confirmPreview(): void {
    const preview = this.viewModel.state().currentPreview;
    if (preview === undefined) return;
    this.sendCommand({ type: "confirm_input", previewId: preview.previewId });
  }

  cancelPreview(): void {
    const preview = this.viewModel.state().currentPreview;
    if (preview === undefined) return;
    this.sendCommand({ type: "cancel_input", previewId: preview.previewId });
  }

  /**
   * Ask the host to rebuild the runtime with a fresh session (campus booth:
   * end-screen restart and stuck-session recovery). The new session id
   * rotates the narrative seed; the rebased websocket pushes a fresh
   * projection snapshot, which drives the UI transition.
   */
  restartSession(): void {
    this.sendCommand({ type: "restart_session" });
  }

  setMode(mode: PlaybackMode): void {
    this.playbackMode = mode;
    if (mode === "manual") {
      this.cancelReadingTimer();
      this.cancelPauseTimer();
    }
    this.coordinator?.setMode(mode);
    this.emitState();
  }

  setVoiceVolume(v: number): void {
    this.voiceVolume = clampUnit(v);
    this.coordinator?.setVolume(this.voiceVolume);
    this.clipPlayer?.setVolume(this.voiceVolume); // 回放即语音，同一路电平
    this.emitState();
  }

  setBgmVolume(v: number): void {
    this.bgmVolume = clampUnit(v);
    this.bgmController?.setVolume(this.bgmVolume);
    this.emitState();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.coordinator?.setMuted(muted);
    this.bgmController?.setMuted(muted);
    this.clipPlayer?.setMuted(muted);
    this.emitState();
  }

  setTextSpeed(charsPerSec: number): void {
    this.textSpeed = clampSpeed(charsPerSec);
    this.emitState();
  }

  // -------------------------------------------------------------------------
  // 回看（backlog）：历史浏览 + 缓存语音回放
  //
  // 语音回放走 IndexedDB 性能缓存而不是重新合成：播过的行其 complete 资产
  // 本来就逐块落在缓存里（本会话资产受 activeCacheKeys 保护，不被清理器
  // 逐出），回放零服务端开销、零合成延迟、与直播听到的是同一次采样。
  // 资产缺失（文本降级/跨局逐出）时该行回退纯文本回看，绝不触发重合成。
  // -------------------------------------------------------------------------

  /** 回看面板的历史快照（旧→新）。 */
  backlogEntries(): readonly BacklogEntry[] {
    return this.backlog.list();
  }

  /**
   * 打开/关闭回看面板。打开 = 挂起故事推进：停掉在播语音、撤掉自动推进
   * 定时器（阅读回退/交互后停顿），服务器仍在生成、面板照常追加新行。
   * 关闭 = 从当前行恢复（音频续不上时由阅读回退/玩家点击接管）。
   */
  setBacklogOpen(open: boolean): void {
    if (open === this.backlogOpen) return;
    this.backlogOpen = open;
    if (open) {
      this.stopReplay();
      this.cancelReadingTimer();
      this.cancelPauseTimer();
      // 挂起而非丢弃：在播语音即刻停止，当前行未播的样本留在管线里，
      // 关面板时 start() 从剩余样本续播（playbackStarted 翻转归 coordinator）。
      this.coordinator?.setSuspended(true);
      this.audioPlaying = false;
    } else {
      this.resumeLiveVoice();
    }
    this.emitState();
  }

  /**
   * Replay a past line from the cache. Returns "unavailable" when the line
   * has no replayable audio (no descriptor / invalidated / asset not
   * complete) — the panel then keeps it text-only.
   */
  async replayLine(lineId: string): Promise<"started" | "unavailable"> {
    const entry = this.backlog.get(lineId);
    if (this.clipPlayer === null || this.reader === null) return "unavailable";
    if (entry === undefined || entry.cacheKey === null) return "unavailable";
    const cacheKey = entry.cacheKey;
    const sampleRate =
      entry.sampleRate > 0 ? entry.sampleRate : this.config.audio.format.sampleRate;
    let samples: Int16Array;
    try {
      samples = await this.decodeCacheAsset(cacheKey);
    } catch {
      return "unavailable";
    }
    // Defensive: the backlog gate already halts live voice, but a replay
    // must never overlap it even if the gate is ever bypassed.
    if (this.coordinator?.isPlaying() === true) {
      this.coordinator.stop();
      this.audioPlaying = false;
    }
    this.clipPlayer.setVolume(this.voiceVolume);
    this.clipPlayer.setMuted(this.muted);
    this.stopReplay(); // switch replays: stops the previous clip cleanly
    if (samples.length === 0) return "unavailable";
    this.replayLineId = lineId;
    this.clipPlayer.play(samples, sampleRate, () => {
      if (this.replayLineId === lineId) {
        this.replayLineId = null;
        this.emitState();
      }
    });
    this.emitState();
    return "started";
  }

  /** Halt the in-flight replay, if any. */
  stopReplay(): void {
    this.clipPlayer?.stop();
    if (this.replayLineId !== null) {
      this.replayLineId = null;
      this.emitState();
    }
  }

  /** Whole-asset decode for replay (lines are short; a full buffer is fine). */
  private async decodeCacheAsset(cacheKey: string): Promise<Int16Array> {
    const decoder = new PcmDecoder();
    const chunks: Int16Array[] = [];
    let total = 0;
    for await (const chunk of this.reader!.readChunks(cacheKey)) {
      const samples = decoder.push(chunk);
      if (samples.length > 0) {
        chunks.push(samples);
        total += samples.length;
      }
    }
    const tail = decoder.flush();
    if (tail.length > 0) {
      chunks.push(tail);
      total += tail.length;
    }
    const samples = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return samples;
  }

  /** Backlog open → close: re-arm the current line's voice + auto pacing. */
  private resumeLiveVoice(): void {
    if (this.backlogOpen) return;
    this.coordinator?.setSuspended(false);
    const view = this.viewModel.state();
    if (view.mode !== "PLAYING" || view.currentLine === undefined) return;
    const lineId = view.currentLine.line_id;
    if (lineId !== this.currentLineId) return; // stale view — the next line re-arms
    this.ensureEnqueued(lineId);
    this.coordinator?.start(lineId);
    void this.ensureAudio(lineId);
    this.scheduleReadingFallback();
    this.reconcileAudio();
  }

  // -------------------------------------------------------------------------
  // Server message routing
  // -------------------------------------------------------------------------

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "audio.descriptor":
        this.onDescriptor(msg.descriptor);
        break;
      case "audio.priority_changed":
        this.onPriorityChanged(msg.lineId, msg.priority);
        break;
      case "audio.invalidated":
        this.onInvalidated(msg.lineId);
        break;
      case "audio.task_status":
        void this.onTaskStatus(msg.taskId, msg.lineId, msg.status, msg.error).catch(() => {
          // Status bookkeeping is best-effort; never throw into the socket path.
        });
        break;
      default:
        this.viewModel.applyServerMessage(msg); // projection.snapshot + runtime.output
        break;
    }
  }

  private handleViewNotify(): void {
    const view = this.viewModel.state();
    this.observeSessionChange(view.sessionId);
    // 序章是本局剧情的一部分：引子进回看历史（narration 条目，无音频、
    // 纯文本），一局只写一次——line_id 带 session id，重连重复投影被
    // BacklogStore 按 id 去重，这里再按 session 二次防御。
    const intro = view.sessionIntro;
    if (
      intro !== undefined &&
      view.sessionId !== undefined &&
      this.introPushedFor !== view.sessionId
    ) {
      this.introPushedFor = view.sessionId;
      this.backlog.push({
        type: "narration",
        lineId: `session-intro:${view.sessionId}`,
        text: intro.title !== undefined ? `【${intro.title}】\n${intro.text}` : intro.text,
      });
    }
    // A projection restore (reconnect) bumps projectionSeq: seed the backlog
    // from recentLines so the lost window's tail re-enters the history
    // (push dedupes; the current line's own re-presentation is a no-op).
    if (view.projectionSeq !== this.lastProjectionSeq) {
      this.lastProjectionSeq = view.projectionSeq;
      for (const line of view.recentLines) this.pushBacklogLine(line);
    }
    if (view.mode === "PLAYING" && view.currentLine !== undefined) {
      if (view.currentLine.line_id !== this.currentLineId) {
        this.onCurrentLine(view.currentLine.line_id, view.currentLine);
      }
    } else if (view.mode !== "PLAYING") {
      // A decision point, waiting state or ending halts the current audio.
      this.cancelReadingTimer();
      if (this.coordinator?.isPlaying() === true || this.audioPlaying) {
        this.coordinator?.stop();
        this.audioPlaying = false;
      }
    }
    this.emitState();
  }

  // -------------------------------------------------------------------------
  // Audio lifecycle
  // -------------------------------------------------------------------------

  /**
   * A new projection session id means the host restarted the game. The old
   * session's audio bookkeeping must not leak into the new one: descriptors
   * would be re-fetched (or even re-synthesized after a cache cleanup) for
   * dead lines whose priority still sorts them to the front.
   */
  private observeSessionChange(sessionId: string | undefined): void {
    if (sessionId === undefined || sessionId === this.lastSessionId) return;
    const previousSession = this.lastSessionId;
    this.lastSessionId = sessionId;
    if (previousSession === null) return; // first observation — nothing to drop
    for (const lineId of [...this.descriptors.keys()]) {
      const entry = this.descriptors.get(lineId);
      entry?.abort?.abort();
      this.coordinator?.dropLine(lineId);
      this.descriptors.delete(lineId);
      this.enqueued.delete(lineId);
    }
    this.cacheDecoders.clear();
    this.currentLineId = null;
    // 重开 = 新故事：回看历史是旧会话的，一并清掉；回放与挂起态不跨会话。
    this.backlog.clear();
    this.stopReplay();
    this.cancelReadingTimer();
    this.cancelPauseTimer();
    this.backlogOpen = false;
  }

  /** Feed one presented line into the backlog, attaching replay audio when
   * the descriptor is already known (it usually arrives before the line). */
  private pushBacklogLine(line: RuntimePlayableEventWire): void {
    this.backlog.push({
      type: line.type,
      lineId: line.line_id,
      ...(line.speaker !== undefined ? { speaker: line.speaker } : {}),
      text: line.text,
    });
    const descriptor = this.descriptors.get(line.line_id);
    if (descriptor !== undefined) {
      this.backlog.attachAudio(
        line.line_id,
        descriptor.descriptor.cacheKey,
        descriptor.descriptor.format.sampleRate,
      );
    }
  }

  private onCurrentLine(lineId: string, line: RuntimePlayableEventWire): void {
    this.currentLineId = lineId;
    this.pushBacklogLine(line);
    this.cancelReadingTimer();
    // 回看打开：语音与自动推进全部挂起（关面板时 resumeLiveVoice 接管）。
    if (this.backlogOpen) return;
    this.coordinator?.stop(); // advance while mid-line halts playback (§9.3)
    this.ensureEnqueued(lineId);
    this.coordinator?.start(lineId);
    void this.ensureAudio(lineId);
    this.scheduleReadingFallback();
    this.reconcileAudio();
  }

  private onDescriptor(descriptor: AudioDescriptor): void {
    const lineId = descriptor.lineId;
    const existing = this.descriptors.get(lineId);
    const entry: DescriptorEntry = existing ?? {
      descriptor,
      state: "idle",
      fed: false,
      taskId: null,
      abort: null,
      download: null,
      pendingFinish: false,
      retries: 0,
    };
    entry.descriptor = descriptor; // keep the latest priority
    // Promotion revives a dead candidate line: a candidate_first_line that
    // failed while speculative (no retry budget there) becomes active when
    // its branch is chosen — without this reset the line stays silent for
    // the rest of the session even as `current`.
    if (
      existing !== undefined &&
      existing.state === "failed" &&
      existing.descriptor.scope.type === "candidate" &&
      descriptor.scope.type === "active"
    ) {
      existing.state = "idle";
      existing.retries = 0;
    }
    this.descriptors.set(lineId, entry);
    // 回看行补上回放标识（描述符通常先于行本身到达）。
    this.backlog.attachAudio(lineId, descriptor.cacheKey, descriptor.format.sampleRate);

    const isCurrent = lineId === this.currentLineId;
    this.ensureEnqueued(lineId);
    if (isCurrent) {
      // The segment may exist now (enqueued at descriptor time) — start the
      // buffered samples; this also cancels the no-audio reading fallback.
      // 回看挂起时不 start（armPlaybackStart 已被 coordinator 门控兜底）。
      if (!this.backlogOpen) this.coordinator?.start(lineId);
      this.cancelReadingTimer();
    }
    void this.ensureAudio(lineId);
    this.reconcileAudio();
  }

  private onPriorityChanged(lineId: string, priority: AudioPriority): void {
    const entry = this.descriptors.get(lineId);
    if (entry === undefined) return;
    entry.descriptor = { ...entry.descriptor, priority };
    if (lineId === this.currentLineId) {
      this.ensureEnqueued(lineId);
      if (!this.backlogOpen) this.coordinator?.start(lineId); // 回看挂起：不起播
    }
    this.reconcileAudio();
  }

  private onInvalidated(lineId: string): void {
    // 行被丢弃（分支剪除/修复重生成）：其回放资产随之作废，文本保留——
    // 已播出的文字是玩家读过的历史。
    this.backlog.invalidateAudio(lineId);
    const entry = this.descriptors.get(lineId);
    if (entry !== undefined && entry.state === "downloading" && entry.abort !== null) {
      entry.abort.abort(); // the downloader catch marks the cache partial
    }
    // §12.5: dead audio must not keep the timeline segment, queued samples
    // or bufferedAheadMs alive — otherwise the low-watermark fill is
    // suppressed and playback underruns.
    this.coordinator?.dropLine(lineId);
    this.descriptors.delete(lineId);
    this.enqueued.delete(lineId);
    this.cacheDecoders.delete(entry?.descriptor.cacheKey ?? "");
    this.reconcileAudio();
  }

  private async onTaskStatus(
    _taskId: string,
    lineId: string,
    status: "started" | "finished" | "failed" | "canceled",
    _error?: string,
  ): Promise<void> {
    const entry = this.descriptors.get(lineId);
    switch (status) {
      case "finished":
        if (entry === undefined) break;
        if (entry.download !== null) {
          // The HTTP PCM stream is still draining; sealing the asset now
          // could persist a truncated copy as `complete` (the task finishes
          // server-side before the browser consumes the tail bytes).
          entry.pendingFinish = true;
        } else if (entry.state === "downloading") {
          // Guard: a failed/canceled line must never be sealed complete by
          // a late `finished` (e.g. download lost the race to a mid-stream
          // error and already marked the asset failed).
          await this.finalizeComplete(entry);
        }
        break;
      case "failed":
        if (entry?.descriptor.cacheKey !== undefined && this.writer !== null) {
          await this.writer.markFailed(entry.descriptor.cacheKey).catch(() => {});
        }
        if (entry !== undefined && entry.state === "downloading") {
          entry.state = "failed";
          entry.abort?.abort();
          entry.abort = null;
          this.scheduleAudioRetry(entry);
        }
        break;
      case "canceled":
        if (entry?.descriptor.cacheKey !== undefined && this.writer !== null) {
          await this.writer.markPartial(entry.descriptor.cacheKey).catch(() => {});
        }
        if (entry !== undefined && entry.state === "downloading") {
          // Cancellation is intentional (line invalidated / branch discarded)
          // — never retried.
          entry.state = "failed";
          entry.abort?.abort();
          entry.abort = null;
        }
        break;
      case "started":
        break;
    }
    void _taskId;
    this.scheduleReadingFallback();
    this.reconcileAudio();
    this.emitState();
  }

  /** Seal one line's cache asset as complete and flip it to `cached`. */
  private async finalizeComplete(entry: DescriptorEntry): Promise<void> {
    if (this.writer !== null) {
      await this.writer.finishComplete(entry.descriptor.cacheKey).catch(() => {});
    }
    // finishComplete is cache bookkeeping only. The downloader already
    // fed every PCM chunk live via onPcm — re-reading the cache here
    // would play the whole line a second time (§12.4/§12.2).
    if (entry.state === "downloading") {
      entry.state = "cached";
      entry.abort = null;
      entry.fed = true;
    }
  }

  /**
   * One bounded retry for transient synthesis failures (mid-stream errors,
   * HTTP 5xx). Cancellation is never retried; speculative lines (candidate
   * backlog beyond active_future) stay dead to avoid resurrecting garbage.
   */
  private scheduleAudioRetry(entry: DescriptorEntry): void {
    const MAX_AUDIO_RETRIES = 2;
    if (entry.retries >= MAX_AUDIO_RETRIES) return;
    if (PRIORITY_RANK[entry.descriptor.priority] > PRIORITY_RANK.active_future) return;
    entry.retries += 1;
    const delay = 800 * 2 ** (entry.retries - 1);
    setTimeout(() => {
      if (this.descriptors.get(entry.descriptor.lineId) !== entry) return;
      if (entry.state !== "failed") return;
      entry.state = "idle";
      this.reconcileAudio();
    }, delay);
  }

  private onPcm(lineId: string, samples: Int16Array): void {
    this.coordinator?.feedPcm(lineId, samples);
    this.reconcileAudio();
  }

  private ensureEnqueued(lineId: string): void {
    if (this.enqueued.has(lineId) || this.coordinator === null) return;
    const entry = this.descriptors.get(lineId);
    if (entry === undefined) return;
    const scope = entry.descriptor.scope.type;
    if (scope !== "active" && lineId !== this.currentLineId) return;
    this.coordinator.enqueueLine(lineId, entry.descriptor.cacheKey, 0, 0);
    this.enqueued.add(lineId);
  }

  /** Cache lookup → feed-from-cache or download (§2 loop, §12.2). */
  private ensureAudio(lineId: string): void {
    const entry = this.descriptors.get(lineId);
    if (entry === undefined || entry.state !== "idle") return;
    if (this.reader === null || this.writer === null || this.downloader === null) return;
    // Text-only mode (§10.5 degrade): no playback node, so no synthesis —
    // the story advances on the reading-time fallback.
    if (this.coordinator === null) return;
    // Candidate branches are speculative text only — EXCEPT their first
    // line (priority candidate_first_line, config candidate_prefetch_lines):
    // the branch's opening voice is synthesized ahead of selection so that
    // promoting the branch starts with its audio ready instead of a
    // playback stall. Deep candidate lines stay unsynthesized until the
    // branch is promoted (activateCandidate → active descriptor), bounding
    // the per-branch request cost to one line.
    if (
      entry.descriptor.scope.type === "candidate" &&
      entry.descriptor.priority !== "candidate_first_line"
    ) {
      return;
    }

    // §10.3 prefetch headroom: the current line is always on the critical
    // path, but future lines are only fetched while the contiguous buffer
    // has room below the target — bounds every fill burst (P3).
    if (
      lineId !== this.currentLineId &&
      this.coordinator.bufferedAheadMs() >= this.config.audio.playback.target_buffer_ms
    ) {
      return;
    }
    entry.state = "checking";
    const { cacheKey } = entry.descriptor;
    void (async () => {
      try {
        // Circuit breaker: persistent lookup failures (corrupt db, closed
        // connection) would otherwise loop idle→checking→fail with no
        // backoff; after a few, skip the cache and go straight to download.
        const lookup = this.cacheUnhealthy
          ? { status: "miss" as const, asset: undefined }
          : await this.reader!.lookup(cacheKey);
        // Invalidated meanwhile: the entry may be gone or a newer entry may
        // have replaced it — never continue a stale lookup (P3 race).
        if (entry.state !== "checking" || this.descriptors.get(lineId) !== entry) return;
        this.cacheFailures = 0;
        if (lookup.status === "complete") {
          entry.state = "cached";
          this.sendCacheReport(lineId, cacheKey, "hit");
          await this.feedFromCache(entry);
        } else {
          this.sendCacheReport(lineId, cacheKey, lookup.asset !== undefined ? "partial" : "miss");
          entry.state = "idle";
          await this.startDownload(entry);
        }
        this.scheduleReadingFallback();
        this.reconcileAudio();
        this.emitState();
      } catch {
        // A cache error is non-fatal: the story continues without audio.
        this.cacheFailures += 1;
        if (this.cacheFailures >= 3) this.cacheUnhealthy = true;
        if (this.descriptors.get(lineId) === entry) {
          entry.state = "idle";
          this.reconcileAudio();
        }
      }
    })();
  }

  private startDownload(entry: DescriptorEntry): Promise<void> {
    if (entry.state === "downloading" || entry.state === "cached") return Promise.resolve();
    entry.state = "downloading";
    // One taskId for both the POST body and the bookkeeping (P3 dead field).
    entry.taskId = randomId();
    entry.pendingFinish = false;
    const controller = new AbortController();
    entry.abort = controller;
    const { lineId, cacheKey } = entry.descriptor;
    const taskId = entry.taskId;
    const run = (async () => {
      try {
        await this.downloader!.download(entry.descriptor, controller.signal, taskId);
        // Stream consumed; `complete` is decided by audio.task_status finished.
      } catch {
        if (entry.state !== "downloading") return; // task_status already settled it
        entry.abort = null;
        entry.state = "failed";
        if (controller.signal.aborted) {
          await this.writer!.markPartial(cacheKey).catch(() => {});
        } else {
          await this.writer!.markFailed(cacheKey).catch(() => {});
          this.scheduleAudioRetry(entry);
        }
        this.scheduleReadingFallback();
        this.emitState();
      } finally {
        entry.download = null;
        // `finished` may have arrived while the HTTP body was still
        // draining; only now has every byte reached the writer, so only
        // now is the asset safe to seal as complete (P1 race).
        if (entry.pendingFinish && entry.state === "downloading") {
          entry.pendingFinish = false;
          await this.finalizeComplete(entry);
          this.scheduleReadingFallback();
          this.reconcileAudio();
          this.emitState();
        }
      }
    })();
    entry.download = run;
    void lineId;
    return run;
  }

  /** Feed a fully cached asset into the coordinator (cross-page hit). */
  private async feedFromCache(entry: DescriptorEntry): Promise<void> {
    if (entry.fed || this.coordinator === null || this.reader === null) return;
    if (!this.enqueued.has(entry.descriptor.lineId)) return; // candidate — hold
    const { lineId, cacheKey } = entry.descriptor;
    let decoder = this.cacheDecoders.get(cacheKey);
    if (decoder === undefined) {
      decoder = new PcmDecoder();
      this.cacheDecoders.set(cacheKey, decoder);
    }
    for await (const chunk of this.reader.readChunks(cacheKey)) {
      const samples = decoder.push(chunk);
      if (samples.length > 0) this.coordinator.feedPcm(lineId, samples);
    }
    const tail = decoder.flush();
    if (tail.length > 0) this.coordinator.feedPcm(lineId, tail);
    this.cacheDecoders.delete(cacheKey);
    entry.fed = true;
    // The cached asset is fully fed — same EOF signal the downloader sends.
    this.coordinator.notifyLineEof(lineId);
  }

  private reconcileAudio(): void {
    if (this.coordinator === null) return;
    // The current line's audio is always ensured (the critical path);
    // future lines are filled below the low watermark, with ensureAudio
    // itself gating prefetch against the §10.3 target (P3).
    if (this.currentLineId !== null) this.ensureAudio(this.currentLineId);
    const below =
      this.coordinator.bufferedAheadMs() <= this.config.audio.playback.low_watermark_ms;
    if (below) {
      for (const lineId of this.fetchPriorityOrder()) {
        if (lineId === this.currentLineId) continue;
        const entry = this.descriptors.get(lineId);
        if (entry === undefined) continue;
        if (entry.state === "idle" || entry.state === "checking") {
          this.ensureAudio(lineId);
        }
      }
    }
  }

  /** Active-path fetch candidates, highest priority first. */
  private fetchPriorityOrder(): string[] {
    return [...this.descriptors.values()]
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.descriptor.priority] - PRIORITY_RANK[b.descriptor.priority],
      )
      .map((entry) => entry.descriptor.lineId);
  }

  /** §9.3 no-audio fallback: auto mode advances by reading-time estimate. */
  private scheduleReadingFallback(): void {
    this.cancelReadingTimer();
    if (this.backlogOpen) return; // 回看挂起：不自动推进
    const lineId = this.currentLineId;
    if (lineId === null || this.playbackMode !== "auto") return;
    const entry = this.descriptors.get(lineId);
    const audioComing =
      entry !== undefined &&
      (entry.state === "checking" ||
        entry.state === "downloading" ||
        (entry.state === "cached" && !entry.fed));
    if (audioComing) return; // audio is on its way — do not pre-advance
    const text = this.viewModel.state().currentLine?.text ?? "";
    const delay = Math.min(
      15000,
      Math.max(1500, Math.round((text.length / READING_CHARS_PER_SEC) * 1000)),
    );
    this.readingTimer = setTimeout(() => {
      this.readingTimer = null;
      if (
        this.currentLineId === lineId &&
        this.playbackMode === "auto" &&
        this.coordinator?.isPlaying() !== true
      ) {
        this.advance();
      }
    }, delay);
  }

  private cancelReadingTimer(): void {
    if (this.readingTimer !== null) {
      clearTimeout(this.readingTimer);
      this.readingTimer = null;
    }
  }

  private readonly coordinatorEvents: AudioCoordinatorEvents = {
    onLinePlaybackStarted: () => {
      this.audioPlaying = true;
      this.cancelReadingTimer();
      this.emitState();
    },
    onLinePlaybackFinished: (lineId) => {
      this.audioPlaying = false;
      if (this.playbackMode === "auto" && lineId === this.currentLineId) {
        const line = this.viewModel.state().currentLine as
          | (RuntimePlayableEventWire & { performance?: PauseInfo })
          | undefined;
        const pauseAfterMs = line?.performance?.pause_after_ms ?? 0;
        if (pauseAfterMs > 0) {
          // The coordinator enqueues with 0 pauses; the app owns the pause.
          // Tracked like the reading timer so a manual click during the
          // pause window cancels it — otherwise the story skips a line (P2).
          this.cancelPauseTimer();
          this.pauseTimer = setTimeout(() => {
            this.pauseTimer = null;
            if (
              this.playbackMode === "auto" &&
              this.currentLineId === lineId &&
              this.coordinator?.isPlaying() !== true
            ) {
              this.advance();
            }
          }, pauseAfterMs);
        } else {
          this.advance();
        }
      }
      this.reconcileAudio();
      this.emitState();
    },
    onUnderrun: () => {
      this.underrunCount += 1;
      this.emitState();
    },
  };

  private cancelPauseTimer(): void {
    if (this.pauseTimer !== null) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Reporting (§8.1)
  // -------------------------------------------------------------------------

  private sendCommand(command: RuntimeCommandWire): void {
    this.client?.sendCommand(randomId(), command);
  }

  private sendCacheReport(lineId: string, cacheKey: string, result: "hit" | "miss" | "partial" | "corrupt"): void {
    this.client?.send({ type: "audio.cache_report", lineId, cacheKey, result });
  }

  private startBufferReports(): void {
    if (this.bufferTimer !== null) return;
    this.bufferTimer = setInterval(() => {
      this.client?.send({
        type: "audio.buffer_report",
        bufferedAheadMs: Math.round(this.coordinator?.bufferedAheadMs() ?? 0),
        underrunCount: this.underrunCount,
      });
    }, BUFFER_REPORT_INTERVAL_MS);
  }

  private stopBufferReports(): void {
    if (this.bufferTimer !== null) {
      clearInterval(this.bufferTimer);
      this.bufferTimer = null;
    }
  }

  private async runCleaner(): Promise<void> {
    if (this.cleaner === null) return;
    await this.cleaner.run(this.activeCacheKeys()).catch(() => {});
    if (this.started) {
      this.cleanerTimer = setTimeout(() => void this.runCleaner(), CLEANER_INTERVAL_MS);
    }
  }

  private activeCacheKeys(): Set<string> {
    const keys = new Set<string>();
    for (const entry of this.descriptors.values()) {
      keys.add(entry.descriptor.cacheKey);
    }
    return keys;
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  private async loadConfig(): Promise<PublicWebConfig> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const response = await fetchImpl("/api/config");
    if (!response.ok) {
      throw new Error(`config fetch failed: HTTP ${response.status}`);
    }
    const json = (await response.json()) as unknown;
    const config = json as PublicWebConfig;
    if (config?.audio?.playback?.low_watermark_ms === undefined) {
      throw new Error("config payload is missing audio.playback");
    }
    this.configSource = "server";
    return config;
  }

  private emitState(): void {
    const snapshot = this.state();
    for (const listener of [...this.listeners]) {
      listener(snapshot);
    }
  }
}

export function interactionIdOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const id = (value as { interaction_id?: unknown }).interaction_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function clampUnit(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function clampSpeed(charsPerSec: number): number {
  return Math.round(Math.min(120, Math.max(5, charsPerSec)));
}
