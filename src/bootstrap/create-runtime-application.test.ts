/**
 * createRuntimeApplication — composition root tests (§7.1).
 *
 * Focus: the root builds a full application from a fake config, the
 * Game's outputs flow into the projection, and shutdown stops the run
 * loop without leaving a pending run() hanging.
 *
 * The LLM adapter module is mocked so no network is touched: the root's
 * internal StoryGenerator is replaced by a controllable double whose
 * envelopes come from `generatorState`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeApplication } from "./create-runtime-application.js";
import type { RuntimeApplication } from "../application/runtime-application.js";
import { makeTestConfig, MemoryController } from "../test-helpers.js";
import { NarrativeDirectorService } from "../application/narrative/narrative-director-service.js";
import { DEFAULT_NARRATIVE_CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import type { GeneratedEvent } from "../story/types.js";
import type { GenerationEnvelope } from "../story/types.js";
import type { EventGroupDraft } from "../core/protocol/gal-dsl/types.js";
import type { GenerationHandle } from "../core/ports/story-generator-port.js";

// The TTS providers (Task B) and the performance compiler impl (Task H)
// land in parallel with this task. The composition test never exercises
// real synthesis, so stub them here to keep the test hermetic regardless
// of landing order. The factory must export the exact names
// create-runtime-application imports.
vi.mock("../adapters/tts/mock-streaming-tts-provider.js", () => ({
  MockStreamingTtsProvider: class {},
}));
vi.mock("../adapters/tts/dashscope-cosyvoice-provider.js", () => ({
  DashScopeCosyVoiceProvider: class {
    constructor(opts: Record<string, unknown>) {
      dashscopeProviderState.instances.push(opts);
    }
  },
}));
vi.mock("../application/audio/performance-compiler.js", async (importOriginal) => ({
  // 词汇表常量被 outline-writer/director-service 的模块级 schema/prompt 引用，
  // 必须保留真值；仅编译器实现换成确定性桩。
  ...(await importOriginal()),
  PerformanceCompilerImpl: class {
    compile() {
      return { rate: 1, pitch: 1, volume: 1, pauseBeforeMs: 0, pauseAfterMs: 0 };
    }
  },
}));

// Mock NarrativeConsolidatorAdapter so the composition root never calls the
// real LLM — the mock succeeds trivially (returns an empty episode with no
// ops), letting consolidation write state files without network access.
vi.mock("../adapters/llm/narrative-consolidator-adapter.js", () => ({
  NarrativeConsolidatorAdapter: class {
    constructor(_opts: unknown) {
      /* no-op — never touches the network */
    }
    async consolidate(_request: unknown) {
      return {
        episode: {
          summary: "测试剧情片段",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal" as const,
        },
        threadOps: [],
        setupOps: [],
        factOps: [],
        beliefOps: [],
        findings: [],
      };
    }
  },
}));



/** Mutable envelopes the mocked StoryGenerator returns (per test). */
const generatorState = vi.hoisted(() => ({
  opening: {
    events: [] as GeneratedEvent[],
    state_patch: undefined as unknown,
    groups: undefined as unknown,
    segmentEnd: undefined as unknown,
  },
  continuation: {
    events: [] as GeneratedEvent[],
    state_patch: undefined as unknown,
    groups: undefined as unknown,
    segmentEnd: undefined as unknown,
  },
}));
/** Constructor opts captured from the mocked DashScope provider. */
const dashscopeProviderState = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
}));

vi.mock("../adapters/llm/openai-compatible-generator.js", () => {
  const handleFrom = (envelope: {
    events: GeneratedEvent[];
    state_patch: unknown;
    groups: unknown;
    segmentEnd: unknown;
  } | undefined): GenerationHandle => {
    const env = envelope ?? {
      events: [],
      state_patch: undefined,
      groups: [],
      segmentEnd: undefined,
    };
    const groups = (env.groups ?? []) as EventGroupDraft[];
    const iterator = groups[Symbol.iterator]();
    return {
      id: "mock",
      events: {
        [Symbol.asyncIterator](): AsyncIterator<EventGroupDraft> {
          return {
            next: () => {
              const step = iterator.next();
              return step.done
                ? Promise.resolve({ value: undefined, done: true })
                : Promise.resolve({ value: step.value, done: false });
            },
          };
        },
      },
      done: Promise.resolve(env as unknown as GenerationEnvelope),
      cancel: () => undefined,
    };
  };
  return {
    StoryGenerator: class {
      generateOpening = vi.fn(() => handleFrom(generatorState.opening));
      generateBranchPrefetch = vi.fn(() => handleFrom(undefined));
      generateInputResponse = vi.fn(() => handleFrom(undefined));
      generateContinuation = vi.fn(() => handleFrom(generatorState.continuation));
      generateInputBridge = vi.fn(() => handleFrom(undefined));
    },
    GeneratorPortFacade: class {
      constructor(private readonly inner: {
        generateOpening: (request: unknown) => unknown;
        generateBranchPrefetch: (request: unknown) => unknown;
        generateInputResponse: (request: unknown) => unknown;
        generateContinuation: (request: unknown) => unknown;
        generateInputBridge: (request: unknown) => unknown;
      }) {}
      generateOpening = (request: unknown) => this.inner.generateOpening(request);
      generateBranchPrefetch = (request: unknown) => this.inner.generateBranchPrefetch(request);
      generateInputResponse = (request: unknown) => this.inner.generateInputResponse(request);
      generateContinuation = (request: unknown) => this.inner.generateContinuation(request);
      generateInputBridge = (request: unknown) => this.inner.generateInputBridge(request);
    },
  };
});

const ORIGINAL_TEST_KEY = process.env.TEST_KEY;
const ORIGINAL_UNUSED_KEY = process.env.UNUSED_KEY;

describe("createRuntimeApplication", () => {
  beforeEach(() => {
    // loadApiKey reads process.env[config.api.api_key_env]; makeTestConfig
    // uses TEST_KEY and the disk fixture uses UNUSED_KEY.
    process.env.TEST_KEY = "test-key";
    process.env.UNUSED_KEY = "unused-key";
  });

  afterEach(() => {
    if (ORIGINAL_TEST_KEY === undefined) delete process.env.TEST_KEY;
    else process.env.TEST_KEY = ORIGINAL_TEST_KEY;
    if (ORIGINAL_UNUSED_KEY === undefined) delete process.env.UNUSED_KEY;
    else process.env.UNUSED_KEY = ORIGINAL_UNUSED_KEY;
  });

  it("builds a RuntimeApplication with all wiring exposed", async () => {
    const config = makeTestConfig({
      characters: {
        suyao: { name: "苏遥", voice_profile: "suyao_main" },
      },
    });
    const app = await createRuntimeApplication({ config });

    expect(app.game).toBeDefined();
    expect(app.audioCatalog).toBeDefined();
    expect(app.ttsTasks).toBeDefined();
    expect(app.projection).toBeDefined();
    expect(app.metrics).toBeDefined();
    expect(app.config).toBe(config);
    expect(typeof app.shutdown).toBe("function");
    expect(typeof app.game.subscribe).toBe("function");
    expect(typeof app.game.dispatch).toBe("function");
    // The Game exposes the metrics collector the CLI prints from.
    expect(app.game.getMetrics()).toBeDefined();
    // M1 registry 端口：无世界启动 = 静态 fallback 世界 roster（characters.yaml
    // 由 M1 落盘；玩家契约按用户裁定 2026-09-19：playerId=player 无名玩家，
    // 林澈/苏遥均为 NPC）。
    expect(app.characterRegistry.mode).toBe("roster");
    const roster = app.characterRegistry.registry?.roster;
    expect(roster).toBeDefined();
    expect(roster!.playerId).toBe("player");
    expect(app.characterRegistry.registry?.require("player").control).toBe("player");
    expect(app.characterRegistry.registry?.require("linche").control).toBe("npc");
    expect(app.characterRegistry.registry?.require("suyao").control).toBe("npc");
    // 「模型不得替玩家生成台词/选择/确认对白」防线指向无名玩家实体：
    // 可发声 cast = 全体 NPC（林澈可被模型演绎），玩家不在其中。
    const npcIds = roster!.characters
      .filter((c) => c.control === "npc")
      .map((c) => c.id)
      .sort();
    expect(npcIds).toEqual(["linche", "suyao"]);
  });

  it("accepts an explicit configPath and reloads the config from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-root-"));
    const configPath = path.join(dir, "config.yaml");
    try {
      await writeFile(
        configPath,
        [
          "api:",
          "  model: fake",
          "  api_key_env: UNUSED_KEY",
          "  timeout_ms: 1000",
          "  token_limit_field: max_completion_tokens",
          "generation:",
          "  temperature: 1.0",
          "  max_tokens: 100",
          "  repair_attempts: 0",
          "prefetch:",
          "  branch_dialogue_lines: 2",
          "  branch_concurrency: 2",
          "  input_bridge:",
          "    enabled: true",
          "    min_events: 1",
          "    max_events: 2",
          "    only_narration: true",
          "input:",
          "  kind: dialogue",
          "  require_preview_confirmation: true",
          "  show_generation_status: false",
          "debug:",
          "  runtime_status: false",
          "media:",
          "  audio:",
          "    synthesis:",
          "      # Explicit: synthesis.provider is the V2 audio switch.",
          "      # Audio stays off here.",
          "      provider: disabled",
          "      max_concurrency: 2",
          "      model_profile: cosyvoice_v3_flash",
          "      api_key_env: UNUSED_KEY",
          "      format: pcm_s16le",
          "      sample_rate: 22050",
          "game:",
          "  sessions_dir: sessions",
          "  show_line_ids: true",
          "app:",
          "  default_host: cli",
          "local_web:",
          "  host: 127.0.0.1",
          "  port: 0",
          "  open_browser: false",
          "  controller_limit: 1",
          "characters:",
          "  suyao:",
          "    name: 苏遥",
          "    voice_profile: suyao_main",
          "",
        ].join("\n"),
        "utf8",
      );
      const app = await createRuntimeApplication({ configPath });
      expect(app.config).toBeDefined();
      expect(app.config.game.show_line_ids).toBe(true);
      expect(app.config.media.audio.synthesis?.provider).toBe("disabled");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

/** Write a minimal voices.yaml with a single suyao_main dashscope binding. */
async function writeDashscopeVoices(dir: string): Promise<string> {
  const voicesPath = path.join(dir, "voices.yaml");
  await writeFile(
    voicesPath,
    [
      "version: 3",
      "profiles:",
      "  suyao_main:",
      "    semantic:",
      "      base_description: 年轻女性。",
      "    providers:",
      "      dashscope:",
      "        model: cosyvoice-v3-flash",
      "        voice_id_env: COSYVOICE_VOICE_SUYAO",
      "",
    ].join("\n"),
    "utf8",
  );
  return voicesPath;
}

/** config with media.audio.synthesis.provider = dashscope. */
function dashscopeConfig(): AppConfig {
  return makeTestConfig({
    media: {
      audio: {
        synthesis: {
          provider: "dashscope",
          max_concurrency: 2,
          model_profile: "cosyvoice_v3_flash",
          api_key_env: "DASHSCOPE_API_KEY",
          format: "pcm_s16le",
          sample_rate: 22050,
        },
      },
    },
    characters: {
      suyao: { name: "苏遥", voice_profile: "suyao_main" },
    },
  });
}

  it("throws at startup when dashscope provider env is incomplete", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-voices-"));
    const voicesPath = await writeDashscopeVoices(dir);
    const originalDashscopeKey = process.env.DASHSCOPE_API_KEY;
    const originalCosyvoiceSuyao = process.env.COSYVOICE_VOICE_SUYAO;
    process.env.DASHSCOPE_API_KEY = "test-dashscope-key";
    delete process.env.COSYVOICE_VOICE_SUYAO;
    try {
      await expect(
        createRuntimeApplication({ config: dashscopeConfig(), voicesPath }),
      ).rejects.toThrow(/COSYVOICE_VOICE_SUYAO/);
    } finally {
      if (originalDashscopeKey === undefined) delete process.env.DASHSCOPE_API_KEY;
      else process.env.DASHSCOPE_API_KEY = originalDashscopeKey;
      if (originalCosyvoiceSuyao === undefined) delete process.env.COSYVOICE_VOICE_SUYAO;
      else process.env.COSYVOICE_VOICE_SUYAO = originalCosyvoiceSuyao;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws at startup when the dashscope API key env is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-voices-"));
    const voicesPath = await writeDashscopeVoices(dir);
    const originalDashscopeKey = process.env.DASHSCOPE_API_KEY;
    const originalCosyvoiceSuyao = process.env.COSYVOICE_VOICE_SUYAO;
    delete process.env.DASHSCOPE_API_KEY;
    process.env.COSYVOICE_VOICE_SUYAO = "cosyvoice-v3-flash-suyao-test";
    try {
      await expect(
        createRuntimeApplication({ config: dashscopeConfig(), voicesPath }),
      ).rejects.toThrow(/DASHSCOPE_API_KEY/);
    } finally {
      if (originalDashscopeKey === undefined) delete process.env.DASHSCOPE_API_KEY;
      else process.env.DASHSCOPE_API_KEY = originalDashscopeKey;
      if (originalCosyvoiceSuyao === undefined) delete process.env.COSYVOICE_VOICE_SUYAO;
      else process.env.COSYVOICE_VOICE_SUYAO = originalCosyvoiceSuyao;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forwards DASHSCOPE_TTS_BASE_URL to the provider when set, omits it when absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-voices-"));
    const voicesPath = await writeDashscopeVoices(dir);
    const originalDashscopeKey = process.env.DASHSCOPE_API_KEY;
    const originalCosyvoiceSuyao = process.env.COSYVOICE_VOICE_SUYAO;
    const originalBaseUrl = process.env.DASHSCOPE_TTS_BASE_URL;
    process.env.DASHSCOPE_API_KEY = "test-dashscope-key";
    process.env.COSYVOICE_VOICE_SUYAO = "cosyvoice-v3-flash-suyao-test";
    try {
      process.env.DASHSCOPE_TTS_BASE_URL = "https://custom.example.com/tts";
      await createRuntimeApplication({ config: dashscopeConfig(), voicesPath });
      expect(dashscopeProviderState.instances.at(-1)?.baseUrl).toBe("https://custom.example.com/tts");

      delete process.env.DASHSCOPE_TTS_BASE_URL;
      await createRuntimeApplication({ config: dashscopeConfig(), voicesPath });
      expect(dashscopeProviderState.instances.at(-1)?.baseUrl).toBeUndefined();
    } finally {
      if (originalDashscopeKey === undefined) delete process.env.DASHSCOPE_API_KEY;
      else process.env.DASHSCOPE_API_KEY = originalDashscopeKey;
      if (originalCosyvoiceSuyao === undefined) delete process.env.COSYVOICE_VOICE_SUYAO;
      else process.env.COSYVOICE_VOICE_SUYAO = originalCosyvoiceSuyao;
      if (originalBaseUrl === undefined) delete process.env.DASHSCOPE_TTS_BASE_URL;
      else process.env.DASHSCOPE_TTS_BASE_URL = originalBaseUrl;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drives a session end-to-end with the MemoryController and the run loop exits", async () => {
    const config = makeTestConfig({
      characters: {
        suyao: { name: "苏遥", voice_profile: "suyao_main" },
      },
    });
    const sessionDir = await mkdtemp(path.join(tmpdir(), "galgame-session-"));
    generatorState.opening = {
      events: [],
      groups: [
        { prelude: [], main: { type: "narration", text: "第一幕" } },
      ],
      state_patch: undefined,
      segmentEnd: { kind: "complete", nonce: "0000", reason: "ending" },
    };

    const app = await createRuntimeApplication({ config, sessionDir, gamesRoot: path.join(sessionDir, "games") });
    const controller = new MemoryController();
    controller.attach(app.game);

    const runPromise = app.game.run();
    await expect(runPromise).resolves.toBeUndefined();

    // Projection reflects the session: started → line → ended.
    const snap = app.projection.snapshot();
    expect(snap.sessionId).toBeDefined();
    expect(snap.phase).toBe("ended");
    expect(snap.ending?.ending_id).toBeDefined();
    expect(snap.currentLine?.line_id).toBeDefined();
    expect(snap.recentLines).toHaveLength(1);
    expect(controller.count("session_started")).toBe(1);
    expect(controller.count("session_ended")).toBe(1);

    await rm(sessionDir, { recursive: true, force: true });
  });

  it("shutdown dispatches the shutdown command and stops a pending run loop", async () => {
    const config = makeTestConfig({
      characters: {
        suyao: { name: "苏遥", voice_profile: "suyao_main" },
      },
    });
    const sessionDir = await mkdtemp(path.join(tmpdir(), "galgame-session-"));
    // Opening yields only an input interaction: no controller attached, so
    // run() parks inside handleInteractionInput awaiting preview_input.
    generatorState.opening = {
      events: [],
      groups: [
        {
          prelude: [],
          main: {
            type: "interaction",
            interaction: {
              prompt: "说什么？",
              mode: "input",
              inputPlaceholder: "...",
            },
          },
        },
      ],
      state_patch: undefined,
      segmentEnd: undefined,
    };

    const app = await createRuntimeApplication({ config, sessionDir, gamesRoot: path.join(sessionDir, "games") });

    // Signal when run() reaches the interaction park point, instead of
    // sleeping a fixed duration: interaction_opened is emitted synchronously
    // immediately before handleInteractionInput awaits the preview command.
    const opened = new Promise<void>((resolve) => {
      app.game.subscribe((output) => {
        if (output.type === "interaction_opened") resolve();
      });
    });

    const runPromise = app.game.run().catch((error: unknown) => {
      console.error("RUN ERROR:", error);
      return error;
    });
    await opened;

    await app.shutdown();
    const result = await runPromise;
    // The run loop unwinds by throwing RuntimeShutdownError — the documented
    // shutdown contract (hosts treat it as a clean exit).
    expect(String(result)).toContain("运行时已收到关闭指令");

    await rm(sessionDir, { recursive: true, force: true });
  });

  it("shutdown flushes narrative pending events and game snapshot into the session dir", async () => {
    const config = makeTestConfig({
      characters: {
        suyao: { name: "苏遥", voice_profile: "suyao_main" },
      },
    });
    const sessionDir = await mkdtemp(path.join(tmpdir(), "galgame-flush-"));
    // Opening commits a narration event, then parks inside the input
    // interaction so run() stays pending until shutdown.
    generatorState.opening = {
      events: [],
      groups: [
        { prelude: [], main: { type: "narration", text: "第一幕" } },
        {
          prelude: [],
          main: {
            type: "interaction",
            interaction: {
              prompt: "说什么？",
              mode: "input",
              inputPlaceholder: "...",
            },
          },
        },
      ],
      state_patch: undefined,
      segmentEnd: undefined,
    };

    const app = await createRuntimeApplication({
      config,
      sessionDir,
      gamesRoot: path.join(sessionDir, "games"),
      sessionId: "sess-flush",
    });

    // Default MemoryController handlers auto-advance narration playback
    // (playback_ready → advance) so the loop reaches the input interaction
    // and parks there, exactly like the shutdown test above.
    const controller = new MemoryController();
    controller.attach(app.game);

    const runPromise = app.game.run().catch((error: unknown) => error);
    await controller.advanceUntilInteractionOrEnd();

    await app.shutdown();
    await runPromise;

    // v2 图记录（§9）：交互已打开 → 决策节点 + 游标落盘；开局段事件不入图。
    const gamesRoot = path.join(sessionDir, "games");
    const gameDirs = (await readdir(gamesRoot)).filter((d) => d.startsWith("game_"));
    expect(gameDirs).toHaveLength(1);
    const gameDir = path.join(gamesRoot, gameDirs[0]!);
    expect(existsSync(path.join(gameDir, "graph", "decisions.jsonl"))).toBe(true);
    expect(existsSync(path.join(gameDir, "cursor.json"))).toBe(true);
    // 导演 flush：pending 事件整理并写入记忆缓存（工作缓存，可丢弃）。
    expect(existsSync(path.join(sessionDir, "sess-flush", "narrative-state.json"))).toBe(true);
    // v1 会话日志已由图存储取代。
    expect(existsSync(path.join(sessionDir, "sess-flush", "events.jsonl"))).toBe(false);

    await rm(sessionDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------
  // M1 角色名册接线：生成世界 roster、入口覆盖、派生卡
  // -------------------------------------------------------------------

  /** 写一个 M1 格式的生成世界（canon 带 control 元信息）+ story_line。 */
  async function seedGeneratedWorld(gamesRoot: string, gameId: string): Promise<void> {
    const worldDir = path.join(gamesRoot, gameId, "world");
    await mkdir(worldDir, { recursive: true });
    await mkdir(path.join(worldDir, "prompts"), { recursive: true });
    await writeFile(path.join(worldDir, "prompts", "story_line.txt"), "生成世界主线。", "utf8");
    await writeFile(
      path.join(worldDir, "canon.json"),
      JSON.stringify(
        {
          revision: 0,
          worldSetting: "深夜旧书店。",
          characters: [
            {
              id: "player_one",
              name: "读者",
              description: "玩家控制角色：深夜来访的读者。",
              control: "player",
              initialLabel: "读者",
            },
            {
              id: "guest_01",
              name: "访客",
              description: "无立绘无声音的动态角色。",
              control: "npc",
              initialLabel: "神秘女子",
            },
          ],
          promotedFacts: [],
          exceptions: [],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  it("M1：生成世界（继续游戏入口）从当前游戏 canon 构建 roster，不掺入 fallback cast", async () => {
    const config = makeTestConfig({
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });
    const root = await mkdtemp(path.join(tmpdir(), "galgame-m1-world-"));
    try {
      const gamesRoot = path.join(root, "games");
      await seedGeneratedWorld(gamesRoot, "game_m1");
      const app = await createRuntimeApplication({
        config,
        sessionDir: root,
        gamesRoot,
        gameId: "game_m1",
        sessionId: "s-m1-1",
      });
      const registry = app.characterRegistry.registry;
      expect(app.characterRegistry.mode).toBe("roster");
      expect(registry).toBeDefined();
      // roster 来自当前游戏 canon：动态无素材角色完整存在。
      expect(registry!.require("guest_01").control).toBe("npc");
      expect(registry!.roster.playerId).toBe("player_one");
      // fallback cast 不掺入生成世界（独立身份命名空间：linche/suyao/player
      // 三个静态条目都不得出现）。
      expect(registry!.get("linche")).toBeUndefined();
      expect(registry!.get("suyao")).toBeUndefined();
      expect(registry!.get("player")).toBeUndefined();

      // 人物卡为派生产物：world/prompts/characters.txt 被（重）生成为
      // 携带 canon roster revision 的派生卡，并进入运行时 prompt。
      const card = await readFile(
        path.join(gamesRoot, "game_m1", "world", "prompts", "characters.txt"),
        "utf8",
      );
      expect(card).toContain("# derived-from: world/canon.json@");
      expect(card).toContain("【访客】(guest_01)");

      // 继续游戏（第二次启动同一世界）：同一 roster（同 revision/playerId）。
      const again = await createRuntimeApplication({
        config,
        sessionDir: root,
        gamesRoot,
        gameId: "game_m1",
        sessionId: "s-m1-2",
      });
      expect(again.characterRegistry.registry?.roster.revision).toBe(registry!.roster.revision);
      expect(again.characterRegistry.registry?.roster.playerId).toBe("player_one");

      // 重开（restart）与回溯（retrace）都发生在同一 gameId 世界内：
      // registry 是世界级单例，restart 原地重建会话不换 roster。
      const restarted = await app.restart();
      expect(restarted.characterRegistry).toBe(app.characterRegistry);
      expect(restarted.characterRegistry.registry?.roster.revision).toBe(registry!.roster.revision);
      await restarted.shutdown();
      await again.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("M1：缺人物卡的生成世界在启动时由 canon 再生（身份不依赖卡）", async () => {
    const config = makeTestConfig({
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });
    const root = await mkdtemp(path.join(tmpdir(), "galgame-m1-card-"));
    try {
      const gamesRoot = path.join(root, "games");
      await seedGeneratedWorld(gamesRoot, "game_m1_card");
      // 世界目录不写 characters.txt（模拟缺卡/被删）。
      const cardPath = path.join(gamesRoot, "game_m1_card", "world", "prompts", "characters.txt");
      await writeFile(
        cardPath,
        "# derived-from: world/canon.json@v2-stale0000stale0000\n\n【手改】(fake)\n",
        "utf8",
      );
      const app = await createRuntimeApplication({
        config,
        sessionDir: root,
        gamesRoot,
        gameId: "game_m1_card",
        sessionId: "s-m1-card",
      });
      const card = await readFile(cardPath, "utf8");
      expect(card).not.toContain("手改");
      expect(card).toContain("【访客】(guest_01)");
      expect(app.characterRegistry.registry?.require("guest_01")).toBeDefined();
      await app.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("M1：旧世界（canon 无 control 元信息）保持 legacy 兼容模式，不猜测玩家", async () => {
    const config = makeTestConfig({
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });
    const root = await mkdtemp(path.join(tmpdir(), "galgame-m1-legacy-"));
    try {
      const gamesRoot = path.join(root, "games");
      const worldDir = path.join(gamesRoot, "game_pre_m1", "world");
      await mkdir(path.join(worldDir, "prompts"), { recursive: true });
      await writeFile(path.join(worldDir, "prompts", "story_line.txt"), "旧世界主线。", "utf8");
      await writeFile(
        path.join(worldDir, "canon.json"),
        JSON.stringify(
          {
            revision: 3,
            worldSetting: "旧世界。",
            characters: [
              { id: "a_1", name: "甲", description: "主角视角。" },
              { id: "b_1", name: "乙", description: "配角。" },
            ],
            promotedFacts: [],
            exceptions: [],
          },
          null,
          2,
        ),
        "utf8",
      );
      const app = await createRuntimeApplication({
        config,
        sessionDir: root,
        gamesRoot,
        gameId: "game_pre_m1",
        sessionId: "s-legacy",
      });
      // 旧世界 = 兼容边界：身份仍走资产目录 legacy 注册表，不猜 control。
      expect(app.characterRegistry.mode).toBe("legacy");
      expect(app.characterRegistry.registry).toBeUndefined();
      await app.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("M1：v2 世界 canon 内容损坏（重复 ID）在装配期大声失败——registry 先于任何演员装配", async () => {
    const config = makeTestConfig({
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });
    const root = await mkdtemp(path.join(tmpdir(), "galgame-m1-bad-"));
    try {
      const gamesRoot = path.join(root, "games");
      const worldDir = path.join(gamesRoot, "game_bad", "world");
      await mkdir(path.join(worldDir, "prompts"), { recursive: true });
      await writeFile(path.join(worldDir, "prompts", "story_line.txt"), "坏世界。", "utf8");
      await writeFile(
        path.join(worldDir, "canon.json"),
        JSON.stringify(
          {
            revision: 0,
            worldSetting: "坏世界。",
            characters: [
              { id: "dup_1", name: "甲", description: "x", control: "player", initialLabel: "甲" },
              { id: "dup_1", name: "乙", description: "x", control: "npc", initialLabel: "乙" },
            ],
            promotedFacts: [],
            exceptions: [],
          },
          null,
          2,
        ),
        "utf8",
      );
      await expect(
        createRuntimeApplication({
          config,
          sessionDir: root,
          gamesRoot,
          gameId: "game_bad",
          sessionId: "s-bad",
        }),
      ).rejects.toThrow(/duplicate_character_id/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("M1：回溯（retrace）入口——同一世界内重开周目，registry 身份不变", async () => {
    const config = makeTestConfig({
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });
    const root = await mkdtemp(path.join(tmpdir(), "galgame-m1-retrace-"));
    try {
      const gamesRoot = path.join(root, "games");
      await seedGeneratedWorld(gamesRoot, "game_m1_bt");
      // 开局：旁白 + input 交互（停驻在决策点，供回溯）。
      generatorState.opening = {
        events: [],
        groups: [
          { prelude: [], main: { type: "narration", text: "深夜的书店。" } },
          {
            prelude: [],
            main: {
              type: "interaction",
              interaction: { prompt: "说什么？", mode: "input", inputPlaceholder: "..." },
            },
          },
        ],
        state_patch: undefined,
        segmentEnd: undefined,
      };
      const app = await createRuntimeApplication({
        config,
        sessionDir: root,
        gamesRoot,
        gameId: "game_m1_bt",
        sessionId: "s-bt-1",
      });
      const registryBefore = app.characterRegistry.registry!;
      const revisionBefore = registryBefore.roster.revision;

      const controller = new MemoryController();
      controller.attach(app.game);
      const run1 = app.game.run().catch((error: unknown) => error);
      await controller.advanceUntilInteractionOrEnd();

      // 决策点落盘：读取 decisions.jsonl 的首个决策 id（宿主回溯通道同源）。
      const decisionsRaw = await readFile(
        path.join(gamesRoot, "game_m1_bt", "graph", "decisions.jsonl"),
        "utf8",
      );
      const decisionId = (JSON.parse(decisionsRaw.trim().split("\n")[0]!) as { id: string }).id;

      // 回溯入口（local-web handleRetrace 同路径）：retrace 命令 → run 退出
      // → prepareRetrace → 重新 run（同 app、同世界）。
      app.game.dispatch({ type: "retrace", decisionId });
      const result1 = await run1;
      expect(String(result1)).toContain("回溯");
      await app.game.prepareRetrace(decisionId);
      const controller2 = new MemoryController();
      controller2.attach(app.game);
      const run2 = app.game.run().catch((error: unknown) => error);
      await controller2.advanceUntilInteractionOrEnd();

      // 回溯后：registry 仍是当前游戏 canon 构建的同一 roster（身份不随
      // 周目重开而重建或掺入 fallback cast）。
      expect(app.characterRegistry.mode).toBe("roster");
      expect(app.characterRegistry.registry).toBe(registryBefore);
      expect(app.characterRegistry.registry!.roster.revision).toBe(revisionBefore);
      expect(app.characterRegistry.registry!.require("guest_01").control).toBe("npc");

      await app.shutdown();
      await run2;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------
  // M5.0 宿主接线：世界身份跨进程固定
  // -------------------------------------------------------------------

  // M3.7：storyLine 只来自 per-game world/prompts——显式 gameId 的测试须先
  // 落一个最小世界提示词目录。
  async function seedWorldPrompts(gamesRoot: string, gameId: string): Promise<void> {
    const promptsDir = path.join(gamesRoot, gameId, "world", "prompts");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(path.join(promptsDir, "story_line.txt"), "测试世界主线。", "utf8");
  }

  it("exposes the explicit gameId and a generated one when omitted", async () => {
    const config = makeTestConfig({
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });
    const root = await mkdtemp(path.join(tmpdir(), "galgame-m50-"));
    generatorState.opening = {
      events: [],
      groups: [{ prelude: [], main: { type: "narration", text: "第一幕" } }],
      state_patch: undefined,
      segmentEnd: { kind: "complete", nonce: "0000", reason: "ending" },
    };
    try {
      const gamesRoot = path.join(root, "games");
      await seedWorldPrompts(gamesRoot, "game_m50_explicit");
      const explicit = await createRuntimeApplication({
        config,
        sessionDir: root,
        gamesRoot,
        gameId: "game_m50_explicit",
      });
      expect(explicit.gameId).toBe("game_m50_explicit");

      const generated = await createRuntimeApplication({
        config,
        sessionDir: root,
        gamesRoot,
      });
      // 缺省 = 每次启动新世界：生成时间戳式 id。
      expect(generated.gameId).toMatch(/^game_/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses the same graph world and restores the cursor across launches with an explicit gameId", async () => {
    const config = makeTestConfig({
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });
    const root = await mkdtemp(path.join(tmpdir(), "galgame-m50-"));
    const gamesRoot = path.join(root, "games");
    await seedWorldPrompts(gamesRoot, "game_m50");
    // 开局：旁白 + input 交互（停驻），让首个决策节点与游标落盘。
    generatorState.opening = {
      events: [],
      groups: [
        { prelude: [], main: { type: "narration", text: "第一幕" } },
        {
          prelude: [],
          main: {
            type: "interaction",
            interaction: {
              prompt: "说什么？",
              mode: "input",
              inputPlaceholder: "...",
            },
          },
        },
      ],
      state_patch: undefined,
      segmentEnd: undefined,
    };
    try {
      const first = await createRuntimeApplication({
        config,
        sessionDir: root,
        gamesRoot,
        gameId: "game_m50",
        sessionId: "s1",
      });
      const controller1 = new MemoryController();
      controller1.attach(first.game);
      const run1 = first.game.run().catch((error: unknown) => error);
      await controller1.advanceUntilInteractionOrEnd();
      await first.shutdown();
      await run1;

      const gameDir = path.join(gamesRoot, "game_m50");
      expect(existsSync(path.join(gameDir, "cursor.json"))).toBe(true);
      const decisionsBefore = await readFile(
        path.join(gameDir, "graph", "decisions.jsonl"),
        "utf8",
      );

      // 第二次启动同一世界：恢复游标（不重开生成、不新建世界、不复制节点）。
      generatorState.opening = {
        events: [],
        groups: [{ prelude: [], main: { type: "narration", text: "不该被生成的开场" } }],
        state_patch: undefined,
        segmentEnd: undefined,
      };
      const second = await createRuntimeApplication({
        config,
        sessionDir: root,
        gamesRoot,
        gameId: "game_m50",
        sessionId: "s2",
      });
      expect(second.gameId).toBe("game_m50");
      const controller2 = new MemoryController();
      controller2.attach(second.game);
      const run2 = second.game.run().catch((error: unknown) => error);
      // 恢复路径重放交互表单并停驻；advanceUntilInteractionOrEnd 到位即证明
      // 表单从快照重放（若误走 fresh 开局，会直接播完旁白结尾而非停驻交互）。
      await controller2.advanceUntilInteractionOrEnd();
      await second.shutdown();
      await run2;

      expect((await readdir(gamesRoot)).filter((d) => !d.startsWith("."))).toEqual([
        "game_m50",
      ]);
      expect(await readFile(path.join(gameDir, "graph", "decisions.jsonl"), "utf8")).toBe(
        decisionsBefore,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------
  // Narrative director assembly tests (Task 11)
  // -------------------------------------------------------------------

  /**
   * Poll until the director's background consolidation has FULLY settled:
   * no consolidation in flight and no pending events left. A mere file
   * existence check is not enough — two narrations can trigger two
   * consolidations, and teardown racing the second one's atomic rename is
   * the Windows ENOTEMPTY flake.
   */
  async function waitForDirectorSettled(app: RuntimeApplication): Promise<void> {
    await vi.waitFor(() => {
      // Test seam: the game holds the director privately; read its
      // single-flight settle state to know when background consolidation
      // is fully done.
      const gameWithDirector = app.game as unknown as {
        narrativeDirector: NarrativeDirectorService;
      };
      const director = gameWithDirector.narrativeDirector;
      const settleState = director as unknown as {
        consolidateRunning: boolean;
        pendingEvents: unknown[];
      };
      expect(settleState.consolidateRunning).toBe(false);
      expect(settleState.pendingEvents).toHaveLength(0);
    });
  }

  /** Write a minimal story-plan.yaml to dir and return its path. */
  async function writeStoryPlan(dir: string): Promise<string> {
    const planPath = path.join(dir, "story-plan.yaml");
    await writeFile(
      planPath,
      [
        "threads:",
        "  - id: terminal_origin",
        "    kind: mystery",
        "    summary: 研究所地下的终端来历成谜。",
        "    status: developing",
        "    importance: major",
        "    next_pressure: 故事推进需要这条线索持续展开。",
      ].join("\n"),
      "utf8",
    );
    return planPath;
  }

  it("assembles a NarrativeDirectorService instance", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-nd-"));
    const sessionDir = path.join(dir, "sessions");
    const storyPlanPath = await writeStoryPlan(dir);

    const config = makeTestConfig({
      narrative: {
        ...DEFAULT_NARRATIVE_CONFIG,
        consolidation: {
          ...DEFAULT_NARRATIVE_CONFIG.consolidation,
          batch_min_events: 1,
          min_checkpoint_gap_ms: 0,
        },
      },
      game: { sessions_dir: sessionDir },
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });

    // Two narration lines → two committed events → consolidation fires
    generatorState.opening = {
      events: [],
      groups: [
        { prelude: [], main: { type: "narration", text: "第一幕" } },
        { prelude: [], main: { type: "narration", text: "第二幕" } },
      ],
      state_patch: undefined,
      segmentEnd: { kind: "complete", nonce: "aaaa", reason: "ending" },
    };

    const app = await createRuntimeApplication({ config, sessionDir, storyPlanPath, sessionId: "test-session", gamesRoot: path.join(sessionDir, "games") });

    // NarrativeDirectorService is wired into the Game as a private field.
    expect((app.game as any).narrativeDirector).toBeInstanceOf(
      NarrativeDirectorService,
    );

    const controller = new MemoryController();
    controller.attach(app.game);
    await app.game.run();

    // Consolidation runs fire-and-forget; wait until the director's
    // background work has fully settled so teardown never races an
    // in-flight write (Windows ENOTEMPTY flake).
    await waitForDirectorSettled(app);

    // Verify the store wrote a narrative-state.json file — inside the
    // session directory, alongside the session store's events.jsonl
    // (audit P1-7: everything lives under sessions/<sessionId>/).
    await expect(
      access(path.join(sessionDir, "test-session", "narrative-state.json")),
    ).resolves.toBeUndefined();

    // narrative-ops.jsonl is only created when there are rejected
    // consolidation ops.  The mock consolidator returns only valid ops
    // (empty threadOps/setupOps + a well-formed episode), so nothing
    // is rejected and the file is never written.
    await expect(
      access(path.join(sessionDir, "test-session", "narrative-ops.jsonl")),
    ).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });

  it("writes narrative state after an interaction checkpoint (plan channel removed, M4.4)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-plan-"));
    const sessionDir = path.join(dir, "sessions");
    const storyPlanPath = await writeStoryPlan(dir);

    const config = makeTestConfig({
      narrative: {
        ...DEFAULT_NARRATIVE_CONFIG,
        consolidation: {
          ...DEFAULT_NARRATIVE_CONFIG.consolidation,
          batch_min_events: 1,
          min_checkpoint_gap_ms: 0,
        },
      },
      game: { sessions_dir: sessionDir },
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });

    // 开场：一段旁白 + 一个 choice 交互；选择后走 post-choice 续写结束。
    generatorState.opening = {
      events: [],
      groups: [
        { prelude: [], main: { type: "narration", text: "第一幕" } },
        {
          prelude: [],
          main: {
            type: "interaction",
            interaction: {
              prompt: "怎么做？",
              mode: "choice",
              optionTexts: ["选项A", "选项B"],
            },
          },
        },
      ],
      state_patch: undefined,
      segmentEnd: { kind: "complete", nonce: "aaaa", reason: "ending" },
    };
    generatorState.continuation = {
      events: [],
      groups: [{ prelude: [], main: { type: "narration", text: "结尾。" } }],
      state_patch: undefined,
      segmentEnd: { kind: "complete", nonce: "bbbb", reason: "ending" },
    };

    const app = await createRuntimeApplication({
      config,
      sessionDir,
      gamesRoot: path.join(sessionDir, "games"),
      storyPlanPath,
      sessionId: "test-session",
    });
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.select(
          output.interactionId,
          (output.interaction as { options: Array<{ id: string }> }).options[0]!.id,
        );
      },
    });
    controller.attach(app.game);
    await app.game.run();

    // checkpoint → consolidation（fire-and-forget）。等待 narrative-state
    // 落盘而不是固定 sleep，避免全量测试负载下的时序抖动。
    await vi.waitFor(async () => {
      await access(path.join(sessionDir, "test-session", "narrative-state.json"));
    });

    // M4.4：director-plan.json 通道已删除，narrative-state.json 仍落盘
    expect(existsSync(path.join(sessionDir, "test-session", "narrative-state.json"))).toBe(true);
    expect(existsSync(path.join(sessionDir, "test-session", "director-plan.json"))).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it("restart rebuilds the runtime in place with a fresh game", async () => {
    const config = makeTestConfig({
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });
    const sessionDir = await mkdtemp(path.join(tmpdir(), "galgame-rs-"));
    try {
      const first = await createRuntimeApplication({ config, sessionId: "sess-restart-1", sessionDir, gamesRoot: path.join(sessionDir, "games") });
      const oldGame = first.game;
      const oldSessionId = (oldGame as any).sessionId;
      const second = await first.restart();
      // restart() swaps the game in place and returns the same app object
      // so hosts keep a valid reference; the game itself is rebuilt with a
      // fresh session id (Task 10).
      expect(second).toBe(first);
      expect(second.game).not.toBe(oldGame);
      // C7a: the fresh SessionIdGenerator id is the core restart contract —
      // the new session must not reuse the old one.
      expect((second.game as any).sessionId).not.toBe(oldSessionId);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it("tolerates a nonexistent story plan path (empty plan, game runs)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-np-"));
    const sessionDir = path.join(dir, "sessions");
    const nonexistentPlan = path.join(dir, "does-not-exist.yaml");

    const config = makeTestConfig({
      narrative: {
        ...DEFAULT_NARRATIVE_CONFIG,
        consolidation: {
          ...DEFAULT_NARRATIVE_CONFIG.consolidation,
          batch_min_events: 1,
          min_checkpoint_gap_ms: 0,
        },
      },
      game: { sessions_dir: sessionDir },
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });

    // Same envelope as the narrative test: narration groups + segmentEnd
    // so game.run() completes.  The nonexistent plan yields an empty plan
    // (loadStoryPlan degrades gracefully), and config normalization
    // ensures getMemoryProjection never sees undefined sub-sections.
    generatorState.opening = {
      events: [],
      groups: [
        { prelude: [], main: { type: "narration", text: "第一幕" } },
        { prelude: [], main: { type: "narration", text: "第二幕" } },
      ],
      state_patch: undefined,
      segmentEnd: { kind: "complete", nonce: "cccc", reason: "ending" },
    };

    const app = await createRuntimeApplication({
      config,
      sessionDir,
      gamesRoot: path.join(sessionDir, "games"),
      storyPlanPath: nonexistentPlan,
      sessionId: "test-session",
    });
    expect((app.game as any).narrativeDirector).toBeDefined();

    // game.run() must resolve — proves the TypeError from undefined
    // brief/consolidation sub-sections is gone (config normalization fix).
    const controller = new MemoryController();
    controller.attach(app.game);
    await expect(app.game.run()).resolves.toBeUndefined();

    // Consolidation runs fire-and-forget; wait for full settle so teardown
    // never races an in-flight write (Windows ENOTEMPTY flake).
    await waitForDirectorSettled(app);
    await expect(
      access(path.join(sessionDir, "test-session", "narrative-state.json")),
    ).resolves.toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});
