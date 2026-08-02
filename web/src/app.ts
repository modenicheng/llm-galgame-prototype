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
import { PcmDecoder } from "./audio/pcm-decoder.js";
import { RuntimeClient, type ConnectionState, type RuntimeCommandWire, type WebSocketCtor } from "./runtime/runtime-client.js";
import { GameViewModel, type RuntimePlayableEventWire, type ViewModelState } from "./runtime/game-view-model.js";
import { AudioDb } from "./storage/audio-db.js";
import { AudioCacheWriter, type CacheWriteOptions } from "./storage/audio-cache-writer.js";
import { AudioCacheReader } from "./storage/audio-cache-reader.js";
import { AudioCacheCleaner, type CleanerOptions } from "./storage/audio-cache-cleaner.js";

/** §10.3 + §11.4 + §17.5 fallback values, used when GET /api/config is absent. */
export const DEFAULT_PUBLIC_WEB_CONFIG: PublicWebConfig = {
  audio: {
    playback: {
      startup_buffer_ms: 350,
      critical_watermark_ms: 500,
      low_watermark_ms: 2500,
      target_buffer_ms: 6500,
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
  /** Test seams. */
  fetchImpl?: typeof fetch;
  webSocketImpl?: WebSocketCtor;
  db?: AudioDb;
}

export interface GameAppState {
  view: ViewModelState;
  connection: ConnectionState;
  playbackMode: PlaybackMode;
  volume: number;
  muted: boolean;
  textSpeed: number;
  audioPlaying: boolean;
  bufferedAheadMs: number;
  underrunCount: number;
  configSource: "server" | "defaults";
  showLineIds: boolean;
  /** Non-null when the last start() attempt failed (P2 start-failure wedge). */
  startError: string | null;
}

interface DescriptorEntry {
  descriptor: AudioDescriptor;
  /** Audio acquisition state for the line. */
  state: "idle" | "checking" | "downloading" | "cached" | "failed";
  /** True once samples were handed to the coordinator (any path). */
  fed: boolean;
  taskId: string | null;
  abort: AbortController | null;
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
  private readonly db: AudioDb;
  private readonly listeners = new Set<(s: GameAppState) => void>();

  private client: RuntimeClient | null = null;
  private coordinator: AudioCoordinator | null = null;
  private writer: AudioCacheWriter | null = null;
  private reader: AudioCacheReader | null = null;
  private cleaner: AudioCacheCleaner | null = null;
  private downloader: AudioDownloader | null = null;

  private config: PublicWebConfig = DEFAULT_PUBLIC_WEB_CONFIG;
  private configSource: "server" | "defaults" = "defaults";
  private connection: ConnectionState = "closed";
  private playbackMode: PlaybackMode = "manual";
  private volume = 1;
  private muted = false;
  private textSpeed = 32;
  private audioPlaying = false;
  private underrunCount = 0;

  private readonly descriptors = new Map<string, DescriptorEntry>();
  private readonly enqueued = new Set<string>();
  private readonly cacheDecoders = new Map<string, PcmDecoder>();
  private currentLineId: string | null = null;

  private started = false;
  /** Start failure surfaced to the UI banner (P2 start-failure wedge). */
  private startError: string | null = null;
  private bufferTimer: ReturnType<typeof setInterval> | null = null;
  private cleanerTimer: ReturnType<typeof setTimeout> | null = null;
  private readingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Auto-mode pause before the post-playback advance (§9.3). */
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: GameAppOptions) {
    this.options = options;
    this.db = options.db ?? new AudioDb();
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
      await this.coordinator.init();

      await this.db.open();
      const writeOptions: CacheWriteOptions = {
        writeBatchBytes: this.config.audio.cache.write_batch_bytes,
        flushIntervalMs: this.config.audio.cache.write_flush_interval_ms,
      };
      this.writer = new AudioCacheWriter(this.db, writeOptions);
      this.reader = new AudioCacheReader(this.db);
      this.cleaner = new AudioCacheCleaner(this.db, CLEANER_DEFAULTS);
      this.downloader = new AudioDownloader({
        token: this.options.token,
        writer: this.writer,
        decoder: () => new PcmDecoder(),
        onPcm: (lineId, samples) => this.onPcm(lineId, samples),
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
      volume: this.volume,
      muted: this.muted,
      textSpeed: this.textSpeed,
      audioPlaying: this.audioPlaying,
      bufferedAheadMs: Math.round(this.coordinator?.bufferedAheadMs() ?? 0),
      underrunCount: this.underrunCount,
      configSource: this.configSource,
      showLineIds: this.config.game.show_line_ids,
      startError: this.startError,
    };
  }

  // -------------------------------------------------------------------------
  // Player commands (§9.3)
  // -------------------------------------------------------------------------

  /** Manual advance: halt local playback immediately and ask the runtime. */
  advance(): void {
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

  setMode(mode: PlaybackMode): void {
    this.playbackMode = mode;
    if (mode === "manual") {
      this.cancelReadingTimer();
      this.cancelPauseTimer();
    }
    this.coordinator?.setMode(mode);
    this.emitState();
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.coordinator?.setVolume(this.volume);
    this.emitState();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.coordinator?.setMuted(muted);
    this.emitState();
  }

  setTextSpeed(charsPerSec: number): void {
    this.textSpeed = Math.min(120, Math.max(5, charsPerSec));
    this.emitState();
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

  private onCurrentLine(lineId: string, line: RuntimePlayableEventWire): void {
    this.currentLineId = lineId;
    this.cancelReadingTimer();
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
    };
    entry.descriptor = descriptor; // keep the latest priority
    this.descriptors.set(lineId, entry);

    const isCurrent = lineId === this.currentLineId;
    this.ensureEnqueued(lineId);
    if (isCurrent) {
      // The segment may exist now (enqueued at descriptor time) — start the
      // buffered samples; this also cancels the no-audio reading fallback.
      this.coordinator?.start(lineId);
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
      this.coordinator?.start(lineId);
    }
    this.reconcileAudio();
  }

  private onInvalidated(lineId: string): void {
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
    const cacheKey = entry?.descriptor.cacheKey;
    switch (status) {
      case "finished":
        if (cacheKey !== undefined && this.writer !== null) {
          await this.writer.finishComplete(cacheKey).catch(() => {});
          // finishComplete is cache bookkeeping only. The downloader already
          // fed every PCM chunk live via onPcm — re-reading the cache here
          // would play the whole line a second time (§12.4/§12.2).
          if (entry !== undefined && entry.state === "downloading") {
            entry.state = "cached";
            entry.abort = null;
            entry.fed = true;
          }
        }
        break;
      case "failed":
        if (cacheKey !== undefined && this.writer !== null) {
          await this.writer.markFailed(cacheKey).catch(() => {});
        }
        if (entry !== undefined && entry.state === "downloading") {
          entry.state = "failed";
          entry.abort?.abort();
          entry.abort = null;
        }
        break;
      case "canceled":
        if (cacheKey !== undefined && this.writer !== null) {
          await this.writer.markPartial(cacheKey).catch(() => {});
        }
        if (entry !== undefined && entry.state === "downloading") {
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

  private onPcm(lineId: string, samples: Int16Array): void {
    this.coordinator?.feedPcm(lineId, samples);
    this.reconcileAudio();
  }

  private ensureEnqueued(lineId: string): void {
    if (this.enqueued.has(lineId) || this.coordinator === null) return;
    const entry = this.descriptors.get(lineId);
    if (entry === undefined) return;
    const scope = entry.descriptor.scope.type;
    // Candidate/preview audio never enters the playback timeline (§22
    // invariants 16/17) — unless the line became the current one.
    if (scope !== "active" && lineId !== this.currentLineId) return;
    this.coordinator.enqueueLine(lineId, entry.descriptor.cacheKey, 0, 0);
    this.enqueued.add(lineId);
  }

  /** Cache lookup → feed-from-cache or download (§2 loop, §12.2). */
  private ensureAudio(lineId: string): void {
    const entry = this.descriptors.get(lineId);
    if (entry === undefined || entry.state !== "idle") return;
    if (this.reader === null || this.writer === null || this.downloader === null) return;
    // §10.3 prefetch headroom: the current line is always on the critical
    // path, but future lines are only fetched while the contiguous buffer
    // has room below the target — bounds every fill burst (P3).
    if (
      lineId !== this.currentLineId &&
      this.coordinator !== null &&
      this.coordinator.bufferedAheadMs() >= this.config.audio.playback.target_buffer_ms
    ) {
      return;
    }
    entry.state = "checking";
    const { cacheKey } = entry.descriptor;
    void (async () => {
      try {
        const lookup = await this.reader!.lookup(cacheKey);
        // Invalidated meanwhile: the entry may be gone or a newer entry may
        // have replaced it — never continue a stale lookup (P3 race).
        if (entry.state !== "checking" || this.descriptors.get(lineId) !== entry) return;
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
        if (this.descriptors.get(lineId) === entry) {
          entry.state = "idle";
          this.reconcileAudio();
        }
      }
    })();
  }

  private async startDownload(entry: DescriptorEntry): Promise<void> {
    if (entry.state === "downloading" || entry.state === "cached") return;
    entry.state = "downloading";
    // One taskId for both the POST body and the bookkeeping (P3 dead field).
    entry.taskId = crypto.randomUUID();
    const controller = new AbortController();
    entry.abort = controller;
    const { lineId, cacheKey } = entry.descriptor;
    try {
      await this.downloader!.download(entry.descriptor, controller.signal, entry.taskId);
      // Stream consumed; `complete` is decided by audio.task_status finished.
    } catch {
      if (entry.state !== "downloading") return; // task_status already settled it
      entry.abort = null;
      entry.state = "failed";
      if (controller.signal.aborted) {
        await this.writer!.markPartial(cacheKey).catch(() => {});
      } else {
        await this.writer!.markFailed(cacheKey).catch(() => {});
      }
      this.scheduleReadingFallback();
      this.emitState();
    }
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
    this.client?.sendCommand(crypto.randomUUID(), command);
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
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
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

function interactionIdOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const id = (value as { interaction_id?: unknown }).interaction_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
