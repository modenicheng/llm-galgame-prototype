/**
 * createRuntimeApplication — the Node-side composition root (§7.1).
 *
 * Builds the entire runtime: config, prompts, LLM adapter, storage,
 * clock, IDs, media intent planner, audio catalog, TTS provider and
 * task service, UI projection, and the Game itself. Hosts (CLI, web)
 * consume the returned `RuntimeApplication` and differ only in their
 * presentation layer.
 */
import { DEFAULT_NARRATIVE_CONFIG, loadApiKey, loadAuthorConfig, loadConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import { loadVoices, validateDashscopeEnv } from "../config/voices.js";
import { Game } from "../game.js";
import { GeneratorPortFacade, StoryGenerator } from "../adapters/llm/openai-compatible-generator.js";
import { GameGraphStore } from "../adapters/storage/game-graph-store.js";
import { ConsoleDiagnosticSink } from "../adapters/platform/console-diagnostic-sink.js";
import { SessionIdGenerator } from "../adapters/platform/session-id-generator.js";
import { SystemClock } from "../adapters/platform/system-clock.js";
import { RunGraphCoordinator } from "../application/graph/run-graph-coordinator.js";
import { ConfluenceJudgeAdapter } from "../adapters/llm/confluence-judge-adapter.js";
import type { ConfluenceJudgePort } from "../core/ports/confluence-judge-port.js";
import { loadPrompts } from "../prompts.js";
import path from "node:path";
import { WORLD_PROMPTS_DIR } from "../application/world/world-generator.js";
import { OutlineStore } from "../adapters/storage/outline-store.js";
import { CanonStore } from "../adapters/storage/canon-store.js";
import { StatsStore } from "../adapters/storage/stats-store.js";
import type { CanonStorePort } from "../core/ports/canon-store-port.js";
import { OutlineWriterAdapter } from "../adapters/llm/outline-writer-adapter.js";
import { CanonAdjudicatorAdapter } from "../adapters/llm/canon-adjudicator-adapter.js";
import { AgentRunnerAdapter } from "../adapters/llm/agent-runner-adapter.js";
import { DirectorService } from "../application/director/director-service.js";
import { CanonPromoter } from "../application/canon/canon-promoter.js";
import type {
  OutlineMaintainerPort,
} from "../application/outline/outline-writer.js";
import type { OutlineStorePort } from "../core/ports/outline-store-port.js";
import { Metrics } from "../runtime/metrics.js";
import { RuntimeStatus } from "../runtime/status.js";
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
import { loadStoryPlan } from "../adapters/static/story-plan-loader.js";
import type { NarrativeDirectorPort } from "../core/ports/narrative-director-port.js";

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

/** v2 剧情图根目录缺省值（§9）；宿主（local-web 的 .last-game）共用同一常量。 */
export const DEFAULT_GAMES_ROOT = "games";

/**
 * TTS provider wiring (§7.6): dashscope → real provider, mock → the
 * streaming mock, disabled/absent → null. With null the catalog still
 * receives descriptors but every synthesis request rejects with
 * "audio_disabled".
 */
function selectTtsProvider(config: AppConfig, voices: Awaited<ReturnType<typeof loadVoices>>): TtsProviderPort | null {
  const synthesis = config.media.audio.synthesis;
  if (synthesis?.provider === "dashscope") {
    const apiKey = process.env[synthesis.api_key_env] ?? "";
    if (apiKey === "") {
      throw new Error(`DashScope TTS API key missing: set ${synthesis.api_key_env} in .env`);
    }
    const missing = validateDashscopeEnv(voices, process.env);
    if (missing.length > 0) {
      throw new Error(`DashScope TTS env incomplete — missing: ${missing.join(", ")}`);
    }
    return new DashScopeCosyVoiceProvider({
      apiKey,
      ...(process.env.DASHSCOPE_TTS_BASE_URL !== undefined
        ? { baseUrl: process.env.DASHSCOPE_TTS_BASE_URL }
        : {}),
      timeoutMs: config.api.timeout_ms,
    });
  }
  if (synthesis?.provider === "mock") {
    return new MockStreamingTtsProvider({ sampleRate: synthesis.sample_rate });
  }
  return null;
}

/**
 * Audio app layer (§7.3–§7.5). Descriptors are built for every line even
 * when synthesis is disabled so the planner/catalog contract holds.
 * TaskStatusEvent fan-out: hosts subscribe via app.taskStatusSubscribe.
 */
function buildAudioStack(
  config: AppConfig,
  voices: Awaited<ReturnType<typeof loadVoices>>,
  provider: TtsProviderPort | null,
): {
  catalog: AudioCatalogServiceImpl;
  planner: AudioIntentPlanner;
  ttsTasks: TtsTaskServiceImpl;
  taskStatusListeners: Set<(event: TaskStatusEvent) => void>;
} {
  const synthesis = config.media.audio.synthesis;
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
  const taskStatusListeners = new Set<(event: TaskStatusEvent) => void>();
  const ttsTasks = new TtsTaskServiceImpl({
    catalog,
    provider,
    maxConcurrency: synthesis?.max_concurrency ?? 2,
    onStatus: (event) => {
      for (const listener of taskStatusListeners) listener(event);
    },
  });
  return { catalog, planner, ttsTasks, taskStatusListeners };
}

/**
 * v2 剧情图协调器（§9）：confluence.enabled 时给协调器挂 LLM 判定员（后台
 * 比较，不阻塞播放）；判定失败只告警，运行时不受影响。confluence 段容忍
 * 手拼 config 的缺省（options.config 可绕过 zod 默认值填充）。
 */
function buildGraphCoordinator(
  gamesRoot: string,
  gameId: string,
  outline?: { store: OutlineStorePort; maintainer?: OutlineMaintainerPort },
  confluenceJudge?: ConfluenceJudgePort,
  canon?: CanonStorePort,
): RunGraphCoordinator {
  const graphStore = new GameGraphStore(gamesRoot, gameId);
  return new RunGraphCoordinator(
    graphStore,
    new SystemClock(),
    (prefix) => `${prefix}${crypto.randomUUID()}`,
    {
      ...(confluenceJudge !== undefined
        ? { judge: confluenceJudge, diagnostics: new ConsoleDiagnosticSink() }
        : {}),
      ...(outline !== undefined ? { outline } : {}),
      ...(canon !== undefined ? { canon } : {}),
      // M5.4：周目完结结算（结局达成 + 边通过计数）。
      stats: new StatsStore(gamesRoot, gameId),
    },
  );
}

/**
 * M4.1 导演装配（M3.5/M3.6 扩展）：runner + 图存储 + 汇流判定员 +
 * 大纲/ canon 读取（导演可见、演员不可见——§5.2 防火墙）。
 * confluence.enabled 门控保持（测试/CI 零网络）；判定失败只告警。
 */
function buildDirectorService(options: {
  gamesRoot: string;
  gameId: string;
  apiKey: string;
  api: AppConfig["api"];
  confluenceEnabled: boolean;
  outline?: { store: OutlineStorePort; maintainer?: OutlineMaintainerPort } | undefined;
  canon: CanonStorePort;
}): DirectorService {
  const { gamesRoot, gameId, apiKey, api } = options;
  return new DirectorService({
    runner: new AgentRunnerAdapter({ apiKey, api }),
    store: new GameGraphStore(gamesRoot, gameId),
    // M3.5 ①：导演读大纲 ending 候选；缺省新世界无大纲 → endingPressure
    // 只能来自模型判定。
    ...(options.outline !== undefined ? { outline: options.outline.store } : {}),
    // M3.6 ③：canon 晋升事实进导演输入。
    canon: options.canon,
    ...(options.confluenceEnabled
      ? {
          judge: new ConfluenceJudgeAdapter({
            apiKey,
            api,
            diagnostics: new ConsoleDiagnosticSink(),
          }),
        }
      : {}),
  });
}

/** M3.6 ②：晋升管线（后台，周目完结/弃局后触发；串行合批，失败只告警）。 */
function buildCanonPromoter(options: {
  gamesRoot: string;
  gameId: string;
  apiKey: string;
  api: AppConfig["api"];
  canon: CanonStorePort;
}): CanonPromoter {
  const { gamesRoot, gameId, apiKey, api } = options;
  return new CanonPromoter({
    graph: new GameGraphStore(gamesRoot, gameId),
    canon: options.canon,
    adjudicator: new CanonAdjudicatorAdapter({
      apiKey,
      api,
      diagnostics: new ConsoleDiagnosticSink(),
    }),
    diagnostics: new ConsoleDiagnosticSink(),
  });
}

export async function createRuntimeApplication(
  options: RuntimeApplicationOptions = {},
): Promise<RuntimeApplication> {
  const config: AppConfig =
    options.config ?? (await loadConfig(options.configPath ?? "config.yaml"));
  const authorConfig = await loadAuthorConfig("prompts/author.yaml");
  const gamesRoot = options.gamesRoot ?? DEFAULT_GAMES_ROOT;
  const perGamePromptsDir =
    options.gameId !== undefined
      ? path.join(gamesRoot, options.gameId, WORLD_PROMPTS_DIR)
      : undefined;
  const { bundle, instructions } = await loadPrompts("prompts", perGamePromptsDir);
  const voices = await loadVoices(options.voicesPath ?? "voices.yaml");
  const apiKey = loadApiKey(config);
  // Asset catalog (docs §57–§60): resource bindings for the model prompt
  // (model catalog) and the runtime (character registry + resolver).
  const assetCatalog = await loadAssetCatalog(config.assets.catalog);

  const status = new RuntimeStatus();
  const metrics = new Metrics();
  const generator = new StoryGenerator(
    config,
    bundle,
    instructions,
    apiKey,
    authorConfig,
    metrics,
    assetCatalog,
  );

  const provider = selectTtsProvider(config, voices);
  const { catalog, planner, ttsTasks, taskStatusListeners } = buildAudioStack(
    config,
    voices,
    provider,
  );

  const projection = new UiProjectionStoreImpl();

  // v2 剧情图（§9）：gameId 是世界的身份，在运行时生命周期内固定；周目
  // （run）才是重开/回溯的单位。图存储与协调器跨 restart 共享。宿主可传
  // options.gameId 固定世界（「继续游戏」指向同一目录）；缺省每次启动
  // 生成新世界。
  const gameId = options.gameId ?? `game_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  // M3.4：显式世界接线 OutlineStore（确定性迁移 + 大纲后台维护）；缺省新世界
  // 无大纲 → 协调器走 ol_seed 种子回退。
  let outline: { store: OutlineStorePort; maintainer?: OutlineMaintainerPort } | undefined;
  if (options.gameId !== undefined) {
    const outlineStore = new OutlineStore(gamesRoot, gameId);
    outline = {
      store: outlineStore,
      maintainer: new OutlineWriterAdapter({ apiKey, api: config.api }),
    };
  }
  // M3.6：canon 存储（跨周目世界真相）。缺省新世界 = 空 canon（读宽容），
  // 晋升管线周目完结/弃局后 fire-and-forget。
  const canonStore = new CanonStore(gamesRoot, gameId);
  // M4.1 ④：汇流判定员的持有与装配移入导演；协调器只接收实例（调度机制
  // 零改动）。confluence.enabled 门控不变（测试/CI 零网络）。
  const confluenceEnabled =
    config.narrative.confluence?.enabled ?? DEFAULT_NARRATIVE_CONFIG.confluence.enabled;
  const director = buildDirectorService({
    gamesRoot,
    gameId,
    apiKey,
    api: config.api,
    confluenceEnabled,
    outline,
    canon: canonStore,
  });
  const graphCoordinator = buildGraphCoordinator(
    gamesRoot,
    gameId,
    outline,
    director.exposeConfluenceJudge(),
    canonStore,
  );
  const canonPromoter = buildCanonPromoter({
    gamesRoot,
    gameId,
    apiKey,
    api: config.api,
    canon: canonStore,
  });

  /**
   * Assemble the per-session game: fresh session store, narrative
   * director, and the Game itself. `restart()` reuses this to
   * rebuild the runtime in place with a new session id (Task 10).
   */
  const buildGameFor = async (
    config: AppConfig,
    sessionId: string,
    options: RuntimeApplicationOptions,
    runMode: "resume" | "restart" = "resume",
  ): Promise<Game> => {
    // --- Narrative director assembly (§7.1) ---
    const diagnostics = new ConsoleDiagnosticSink();
    let narrativeDirector: NarrativeDirectorPort | undefined;
    {
      const plan = await loadStoryPlan(
        options.storyPlanPath ?? config.narrative.story_plan_path,
        diagnostics,
      );
      const narrativeStore = new JsonNarrativeMemoryStore(
        options.sessionDir ?? config.game.sessions_dir,
        sessionId,
      );
      const consolidator = new NarrativeConsolidatorAdapter({
        apiKey,
        api: config.api,
        config: config.narrative,
        diagnostics,
      });
      const service = new NarrativeDirectorService({
        config: config.narrative,
        store: narrativeStore,
        consolidator,
        plan,
        diagnostics,
      });
      await service.initialize();
      narrativeDirector = service;
    }

    return new Game(config, new GeneratorPortFacade(generator), status, planner, metrics, {
      graph: graphCoordinator,
      clock: new SystemClock(),
      ids: new SessionIdGenerator(),
      sessionId,
      diagnostics,
      runMode,
      ...(narrativeDirector ? { narrativeDirector } : {}),
      director,
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
  // browser can restore the page without restarting the Game. A run's
  // formal end also fires the M3.6 canon promotion (background).
  const watchGame = (g: Game): void => {
    g.subscribe((output) => {
      projection.applyOutput(output);
      if (output.type === "session_ended") void canonPromoter.promoteFromRuns();
    });
  };
  watchGame(game);

  const app: RuntimeApplication = {
    game,
    gameId,
    audioCatalog: catalog,
    ttsTasks,
    projection,
    config,
    metrics,
    assetCatalog,
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
      // 关停旧会话（unwind + 落盘），再以 restart 模式重建 game：弃局活跃
      // 周目、在游标节点开 retrace 新周目（M1.5）；无档则开新 root 周目。
      game.dispatch({ type: "shutdown" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await game.flush();
      const freshSessionId = new SessionIdGenerator().nextSessionId();
      game = await buildGameFor(config, freshSessionId, options, "restart");
      watchGame(game);
      // 弃局周目已定格（abandonedAt）→ 晋升管线后台跑一轮（M3.6 ②）。
      void canonPromoter.promoteFromRuns();
      // 原地替换 game 字段并返回同一 app 对象：宿主持有的 app 引用保持有效，
      // 只需重新调用 app.game.run()。
      app.game = game;
      return app;
    },
  };
  return app;
}
