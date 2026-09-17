/**
 * createRuntimeApplication — the Node-side composition root (§7.1).
 *
 * Builds the entire runtime: config, prompts, LLM adapter, storage,
 * clock, IDs, media intent planner, audio catalog, TTS provider and
 * task service, UI projection, and the Game itself. Hosts (CLI, web)
 * consume the returned `RuntimeApplication` and differ only in their
 * presentation layer.
 */
import { loadApiKey, loadAuthorConfig, loadConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import { loadVoices, validateDashscopeEnv, validateDashscopeModelConfig } from "../config/voices.js";
import { Game } from "../game.js";
import { GeneratorPortFacade, StoryGenerator } from "../adapters/llm/openai-compatible-generator.js";
import { NodeJsonlSessionStore } from "../adapters/storage/node-jsonl-session-store.js";
import { LlmStreamRecorder } from "../adapters/storage/llm-stream-recorder.js";
import { ConsoleDiagnosticSink } from "../adapters/platform/console-diagnostic-sink.js";
import { SessionIdGenerator } from "../adapters/platform/session-id-generator.js";
import { SystemClock } from "../adapters/platform/system-clock.js";
import { loadPrompts } from "../prompts.js";
import { Metrics } from "../runtime/metrics.js";
import { RuntimeStatus } from "../status.js";
import { MonitorHub } from "../application/monitor/monitor-hub.js";
import type { DslStreamObserver } from "../core/ports/dsl-stream-observer.js";
import {
  instrumentMemoryConsolidator,
  instrumentPlotPlanner,
  instrumentRecapSummarizer,
} from "../application/monitor/instrumented-context-ports.js";
import { BroadcastDiagnosticSink } from "../adapters/platform/broadcast-diagnostic-sink.js";
import { UiProjectionStoreImpl } from "../application/ui/ui-projection-store.js";
import { AudioCatalogServiceImpl } from "../application/audio/audio-catalog-service.js";
import { AudioDescriptorFactory } from "../application/audio/audio-descriptor-factory.js";
import { AudioIntentPlanner } from "../application/audio/audio-intent-planner.js";
import {
  TtsTaskServiceImpl,
  type TaskStatusEvent,
} from "../application/audio/tts-task-service.js";
import { PerformanceCompilerImpl } from "../application/audio/performance-compiler.js";
import { MockStreamingTtsProvider } from "../adapters/tts/mock-streaming-tts-provider.js";
import { DashScopeCosyVoiceProvider } from "../adapters/tts/dashscope-cosyvoice-provider.js";
import type { TtsProviderPort } from "../core/ports/tts-provider-port.js";
import type {
  RuntimeApplication,
  RuntimeApplicationOptions,
} from "../application/runtime-application.js";
import { loadAssetCatalog } from "../application/assets/asset-catalog-loader.js";
import { NarrativeDirectorService } from "../application/narrative/narrative-director-service.js";
import { JsonNarrativeMemoryStore } from "../adapters/storage/json-narrative-memory-store.js";
import { NarrativeConsolidatorAdapter } from "../adapters/llm/narrative-consolidator-adapter.js";
import { PlotPlannerAdapter } from "../adapters/llm/plot-planner-adapter.js";
import { RecapSummarizerAdapter } from "../adapters/llm/recap-summarizer-adapter.js";
import { loadStoryPlan } from "../adapters/static/story-plan-loader.js";
import type { NarrativeDirectorPort } from "../core/ports/narrative-director-port.js";
import {
  loadScenarioSeedCatalog,
  scenarioSeedToInitialState,
  selectScenarioSeed,
} from "../campus/scenario-seeds.js";
import type { StoryState } from "../story/types.js";

/** 校园分支：event 模式每局叙事种子目录（scenario seed catalog）。 */
const CAMPUS_SCENARIO_CATALOG = "prompts/campus-ops.yaml";
/** 展位演示可显式指定本局种子 id（对应目录中的 seed.id）。 */
const CAMPUS_SCENARIO_SEED_ENV = "CAMPUS_SCENARIO_SEED_ID";

/**
 * FNV-1a 32-bit hash — a deterministic, session-independent seed per
 * lineId. Same line → same seed → same recipe → same cacheKey.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export async function createRuntimeApplication(
  options: RuntimeApplicationOptions = {},
): Promise<RuntimeApplication> {
  const config: AppConfig =
    options.config ?? (await loadConfig(options.configPath ?? "config.yaml"));
  const authorConfig = await loadAuthorConfig("prompts/author.yaml");
  const { bundle, instructions } = await loadPrompts("prompts");
  const voices = await loadVoices(options.voicesPath ?? "voices.yaml");
  const apiKey = loadApiKey(config);
  // Asset catalog (docs §57–§60): resource bindings for the model prompt
  // (model catalog) and the runtime (character registry + resolver).
  const assetCatalog = await loadAssetCatalog(config.assets.catalog);

  const status = new RuntimeStatus();
  const metrics = new Metrics();
  // Monitor dashboard hub (docs/monitor-dashboard.md): app-level so it
  // survives session restarts; `game` is read through a closure so restart
  // rebases the polled view without re-wiring.
  const monitor = new MonitorHub({
    status,
    metrics,
    info: {
      model: config.api.model,
      narrativeMode: config.narrative.mode,
      apiBaseUrl: config.api.base_url ?? "",
      knownSpeakers: Object.entries(assetCatalog.characters).flatMap(([characterId, binding]) => [
        binding.scriptName,
        characterId,
      ]),
      textBuffer: {
        startThresholdLines: config.text_buffer.start_threshold_lines,
        targetLines: config.text_buffer.target_lines,
        refillThresholdLines: config.text_buffer.refill_threshold_lines,
      },
      eventMode: {
        // 测试会用缺 event 块的窄 config 组装；0 = 该级禁用，与语义一致。
        wrapupInteractions: config.narrative.event?.wrapup_interactions ?? 0,
        closingPushInteractions: config.narrative.event?.closing_push_interactions ?? 0,
        maxInteractions: config.narrative.event?.max_interactions ?? 0,
      },
    },
    game: () => game,
  });
  // 全量 DSL 流落盘（2026-09-17 可观测性）：/monitor 只有有界内存视图
  // （ring + 截断），落盘器把写手输入输出逐字节留档到会话目录 llm/，
  // 含中途死亡的 attempt 现场。与 monitor 一起经 safe 包裹器注入——两者
  // 的异常都不得影响生成主路径（设计 §错误处理）。
  const recorder = config.observability.record_llm_streams
    ? new LlmStreamRecorder()
    : null;
  const writerObservers: DslStreamObserver[] = [monitor.writerObserver];
  if (recorder !== null) writerObservers.push(recorder);
  const generator = new StoryGenerator(
    config,
    bundle,
    instructions,
    apiKey,
    authorConfig,
    metrics,
    assetCatalog,
    safeDslStreamObserver(fanOutDslStreamObserver(writerObservers)),
  );

  // TTS provider wiring (§7.6): dashscope → real provider, mock → the
  // streaming mock, disabled/absent → null. With null the catalog still
  // receives descriptors but every synthesis request rejects with
  // "audio_disabled".
  const synthesis = config.media.audio.synthesis;
  let provider: TtsProviderPort | null;
  if (synthesis?.provider === "dashscope") {
    const apiKey = process.env[synthesis.api_key_env] ?? "";
    if (apiKey === "") {
      throw new Error(`DashScope TTS API key missing: set ${synthesis.api_key_env} in .env`);
    }
    const missing = validateDashscopeEnv(voices, process.env);
    if (missing.length > 0) {
      throw new Error(`DashScope TTS env incomplete — missing: ${missing.join(", ")}`);
    }
    const modelErrors = validateDashscopeModelConfig(voices, process.env, synthesis.sample_rate);
    if (modelErrors.length > 0) {
      throw new Error(`DashScope TTS model config invalid — ${modelErrors.join("; ")}`);
    }
    provider = new DashScopeCosyVoiceProvider({
      apiKey,
      ...(process.env.DASHSCOPE_TTS_BASE_URL !== undefined
        ? { baseUrl: process.env.DASHSCOPE_TTS_BASE_URL }
        : {}),
      ...(process.env.DASHSCOPE_QWEN3_TTS_BASE_URL !== undefined
        ? { qwen3BaseUrl: process.env.DASHSCOPE_QWEN3_TTS_BASE_URL }
        : {}),
      timeoutMs: config.api.timeout_ms,
    });
  } else if (synthesis?.provider === "mock") {
    provider = new MockStreamingTtsProvider({ sampleRate: synthesis.sample_rate });
  } else {
    provider = null;
  }

  // Audio app layer (§7.3–7.5). Descriptors are built for every line even
  // when synthesis is disabled so the planner/catalog contract holds.
  const catalog = new AudioCatalogServiceImpl();
  const factory = new AudioDescriptorFactory({
    characters: config.characters,
    voices,
    // The factory needs a discriminator even when synthesis is disabled;
    // "mock" yields stable mock bindings for every speaker.
    provider: synthesis?.provider === "dashscope" ? "dashscope" : "mock",
    modelProfile: synthesis?.model_profile ?? "cosyvoice_v3_flash",
    sampleRate: synthesis?.sample_rate ?? 22050,
    format: "pcm_s16le",
    env: process.env,
    compiler: new PerformanceCompilerImpl(),
    seedFor: (lineId) => fnv1a(lineId),
  });
  const planner = new AudioIntentPlanner({
    catalog,
    factory,
    candidatePrefetchLines: config.media.audio.planner?.candidate_prefetch_lines ?? 1,
    maxActiveFutureLines: config.media.audio.planner?.max_active_future_lines ?? 4,
  });
  // TaskStatusEvent fan-out: hosts subscribe via app.taskStatusSubscribe.
  const taskStatusListeners = new Set<(event: TaskStatusEvent) => void>();
  const ttsTasks = new TtsTaskServiceImpl({
    catalog,
    provider,
    maxConcurrency: synthesis?.max_concurrency ?? 2,
    onStatus: (event) => {
      for (const listener of taskStatusListeners) listener(event);
    },
  });

  const projection = new UiProjectionStoreImpl();

  /**
   * Assemble the per-session game: fresh session store + (longform)
   * narrative director + the Game itself. `restart()` reuses this to
   * rebuild the runtime in place with a new session id (Task 10).
   */
  const buildGameFor = async (
    config: AppConfig,
    sessionId: string,
    options: RuntimeApplicationOptions,
  ): Promise<Game> => {
    // 落盘器跟随会话目录（支持 options.sessionDir 覆盖）；restart 换新
    // sessionId 时在此切换，落盘记录与存档同生命周期。
    if (recorder !== null) {
      await recorder.beginSession(options.sessionDir ?? config.game.sessions_dir, sessionId);
    }
    const store = new NodeJsonlSessionStore(options.sessionDir ?? config.game.sessions_dir);
    // --- Narrative director assembly (§7.1) ---
    // Diagnostics fan out to the console AND the monitor hub (dashboard log).
    const diagnostics = new BroadcastDiagnosticSink(
      new ConsoleDiagnosticSink(),
      (level, scope, message) => monitor.pushDiagnostic(level, scope, message),
    );
    let narrativeDirector: NarrativeDirectorPort | undefined;
    if (config.narrative.mode === "longform") {
      const plan = await loadStoryPlan(
        options.storyPlanPath ?? config.narrative.story_plan_path,
        diagnostics,
      );
      const narrativeStore = new JsonNarrativeMemoryStore(
        options.sessionDir ?? config.game.sessions_dir,
        sessionId,
      );
      const consolidator = instrumentMemoryConsolidator(
        new NarrativeConsolidatorAdapter({
          apiKey,
          api: config.api,
          config: config.narrative,
          diagnostics,
          metrics,
        }),
        monitor,
      );
      const planner = instrumentPlotPlanner(
        new PlotPlannerAdapter({
          apiKey,
          api: config.api,
          config: config.narrative,
          diagnostics,
          metrics,
        }),
        monitor,
      );
      const service = new NarrativeDirectorService({
        config: config.narrative,
        store: narrativeStore,
        consolidator,
        planner,
        plan,
        diagnostics,
      });
      await service.initialize();
      narrativeDirector = service;
    }

    // Campus branch: event-mode sessions start from one narrative seed,
    // chosen deterministically from the fresh session id (restart → new
    // session id → seed rotation). The generic runtime only ever sees a
    // pre-seeded initial story state (GamePorts.initialStoryState).
    let initialStoryState: StoryState | undefined;
    if (config.narrative.mode === "event") {
      const catalog = await loadScenarioSeedCatalog(CAMPUS_SCENARIO_CATALOG);
      const seed = selectScenarioSeed(
        catalog,
        sessionId,
        process.env[CAMPUS_SCENARIO_SEED_ENV],
      );
      initialStoryState = scenarioSeedToInitialState(seed);
    }

    // 滚动前情梗概压缩器（2026-09-17 上下文审计）：滑出历史窗口的事件
    // 压缩进 [Recap]；失败时 Game 内部回退确定性摘要。包装器把生命周期
    // 报告给监控后台（context LLM 面板）。
    const recapSummarizer = instrumentRecapSummarizer(
      new RecapSummarizerAdapter({
        apiKey,
        api: config.api,
        diagnostics,
        metrics,
      }),
      monitor,
    );

    return new Game(config, new GeneratorPortFacade(generator), status, planner, metrics, {
      store,
      clock: new SystemClock(),
      ids: new SessionIdGenerator(),
      sessionId,
      diagnostics,
      recapSummarizer,
      ...(initialStoryState !== undefined ? { initialStoryState } : {}),
      ...(narrativeDirector ? { narrativeDirector } : {}),
    }, assetCatalog);
  };

  // One session id for the whole runtime: the game's session file AND the
  // narrative-memory directory are bound to it (spec §6), so narrative
  // state never leaks across sessions and a resumed session restores its
  // own memory.
  const sessionId =
    options.sessionId ?? new SessionIdGenerator().nextSessionId();
  let game = await buildGameFor(config, sessionId, options);

  // Every runtime output feeds the projection (§7.7) so a reconnecting
  // browser can restore the page without restarting the Game.
  game.subscribe((output) => projection.applyOutput(output));

  const app: RuntimeApplication = {
    game,
    audioCatalog: catalog,
    ttsTasks,
    projection,
    config,
    metrics,
    assetCatalog,
    monitor,
    taskStatusSubscribe: (listener) => {
      taskStatusListeners.add(listener);
      return () => taskStatusListeners.delete(listener);
    },
    shutdown: async () => {
      // Stop the run loop: the command wakes waitForCommand, which throws
      // RuntimeShutdownError out of game.run(). Yield one macrotask so the
      // unwinding completes before we resolve.
      game.dispatch({ type: "shutdown" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // 关停落盘：导演 pending 事件整理 + 计划/快照持久化（audit P1-7）。
      await game.flush();
    },
    restart: async () => {
      // 关停旧会话（unwind + 落盘），再用新 session id 重建 game。
      game.dispatch({ type: "shutdown" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await game.flush();
      // 旧会话的音频描述符全部失效：catalog 是跨重建共享的，残留的
      // descriptor（priority 可能仍是 current）会在浏览器重连时被快照
      // 重放，触发对死行的缓存重放甚至真实重合成。
      for (const descriptor of catalog.listDescriptors()) {
        catalog.invalidate(descriptor.lineId, "session_closed");
      }
      const freshSessionId = new SessionIdGenerator().nextSessionId();
      game = await buildGameFor(config, freshSessionId, options);
      game.subscribe((output) => projection.applyOutput(output));
      // session_started 在 run() 内才发射，晚于宿主的 ws rebase 推快照——
      // 投影必须在这里显式重置，浏览器重连/重挂才能拿到干净的新会话快照。
      projection.reset(freshSessionId);
      // 监控 ring 同步换局：旧会话的 writer/context 任务不落入新会话文档。
      monitor.clearWriterHistory();
      // 原地替换 game 字段并返回同一 app 对象：宿主持有的 app 引用保持有效，
      // 只需重新调用 app.game.run()。
      app.game = game;
      return app;
    },
  };
  return app;
}


/**
 * Fan every observer hook out to several observers in order; a hook an
 * observer does not implement is simply skipped for that observer.
 */
function fanOutDslStreamObserver(observers: readonly DslStreamObserver[]): DslStreamObserver {
  const call = <A extends unknown[]>(
    pick: (observer: DslStreamObserver) => ((...args: A) => void) | undefined,
  ) =>
    (...args: A): void => {
      for (const observer of observers) pick(observer)?.(...args);
    };
  return {
    onAttemptStart: call((observer) => observer.onAttemptStart),
    onPrompt: call((observer) => observer.onPrompt),
    onDelta: call((observer) => observer.onDelta),
    onLine: call((observer) => observer.onLine),
    onGroup: call((observer) => observer.onGroup),
    onRepair: call((observer) => observer.onRepair),
    onUsage: call((observer) => observer.onUsage),
    onAttemptEnd: call((observer) => observer.onAttemptEnd),
  };
}

/**
 * Wrap every observer hook so a broken monitor can never take the
 * generation main path down (design: 监控观察者异常不得影响生成主路径).
 */
function safeDslStreamObserver(observer: DslStreamObserver): DslStreamObserver {
  const safe = <A extends unknown[]>(name: string, call: (...args: A) => void) =>
    (...args: A): void => {
      try {
        call(...args);
      } catch (error) {
        console.warn(`[monitor] observer ${name} failed`, error);
      }
    };
  const wrapped: DslStreamObserver = {
    onAttemptStart: safe("onAttemptStart", observer.onAttemptStart.bind(observer)),
    onDelta: safe("onDelta", observer.onDelta.bind(observer)),
    onLine: safe("onLine", observer.onLine.bind(observer)),
    onGroup: safe("onGroup", observer.onGroup.bind(observer)),
    onAttemptEnd: safe("onAttemptEnd", observer.onAttemptEnd.bind(observer)),
  };
  if (observer.onPrompt !== undefined) {
    wrapped.onPrompt = safe("onPrompt", observer.onPrompt.bind(observer));
  }
  if (observer.onRepair !== undefined) {
    wrapped.onRepair = safe("onRepair", observer.onRepair.bind(observer));
  }
  if (observer.onUsage !== undefined) {
    wrapped.onUsage = safe("onUsage", observer.onUsage.bind(observer));
  }
  return wrapped;
}
