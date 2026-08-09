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
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeApplication } from "./create-runtime-application.js";
import { makeTestConfig, MemoryController } from "../test-helpers.js";
import { NarrativeDirectorService } from "../application/narrative/narrative-director-service.js";
import { DEFAULT_NARRATIVE_CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import type { GeneratedEvent } from "../story/types.js";

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
vi.mock("../application/audio/performance-compiler.js", () => ({
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
}));
/** Constructor opts captured from the mocked DashScope provider. */
const dashscopeProviderState = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
}));

vi.mock("../adapters/llm/openai-compatible-generator.js", () => ({
  StoryGenerator: class {
    generateOpening = vi.fn(async () => generatorState.opening);
    generateBranchPrefetch = vi.fn(async () => ({ events: [], state_patch: undefined }));
    generateInputResponse = vi.fn(async () => ({ events: [], state_patch: undefined }));
    generateContinuation = vi.fn(async () => ({ events: [], state_patch: undefined }));
    generateInputBridge = vi.fn(async () => ({ events: [], state_patch: undefined }));
  },
}));

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
          "    enabled: false",
          "    provider: disabled",
          "    synthesis:",
          "      # Explicit: the legacy flat provider field is not the V2",
          "      # switch — synthesis.provider is. Audio stays off here.",
          "      provider: disabled",
          "      max_concurrency: 2",
          "      model_profile: cosyvoice_v3_flash",
          "      api_key_env: UNUSED_KEY",
          "      format: pcm_s16le",
          "      sample_rate: 22050",
          "game:",
          "  history_events: 80",
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
      expect(app.config.media.audio.provider).toBe("disabled");
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
        enabled: false,
        provider: "disabled",
        active_target_lines: 3,
        refill_threshold_lines: 2,
        branch_prefetch_lines: 2,
        batch_size: 2,
        max_concurrency: 2,
        mock_latency_ms: 800,
        output_dir: "assets/audio",
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

    const app = await createRuntimeApplication({ config, sessionDir });
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

    const app = await createRuntimeApplication({ config, sessionDir });

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

  // -------------------------------------------------------------------
  // Narrative director assembly tests (Task 11)
  // -------------------------------------------------------------------

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

  it("assembles a NarrativeDirectorService instance for longform mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-nd-"));
    const sessionDir = path.join(dir, "sessions");
    const storyPlanPath = await writeStoryPlan(dir);

    const config = makeTestConfig({
      narrative: {
        ...DEFAULT_NARRATIVE_CONFIG,
        mode: "longform" as const,
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

    const app = await createRuntimeApplication({ config, sessionDir, storyPlanPath });

    // NarrativeDirectorService is wired into the Game as a private field.
    expect((app.game as any).narrativeDirector).toBeInstanceOf(
      NarrativeDirectorService,
    );

    const controller = new MemoryController();
    controller.attach(app.game);
    await app.game.run();

    // Consolidation runs fire-and-forget; yield the microtask queue so the
    // schedule completes and writes state files.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify the store wrote a narrative-state.json file.
    // The narrative-memory store writes directly into the sessions
    // base directory (same dir as events.jsonl).
    await expect(
      access(path.join(sessionDir, "narrative-state.json")),
    ).resolves.toBeUndefined();

    // narrative-ops.jsonl is only created when there are rejected
    // consolidation ops.  The mock consolidator returns only valid ops
    // (empty threadOps/setupOps + a well-formed episode), so nothing
    // is rejected and the file is never written.
    await expect(
      access(path.join(sessionDir, "narrative-ops.jsonl")),
    ).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });

  it("does not assemble a narrative director for event mode", async () => {
    const config = makeTestConfig({
      narrative: { mode: "event" },
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });
    const sessionDir = await mkdtemp(path.join(tmpdir(), "galgame-ev-"));
    generatorState.opening = {
      events: [],
      groups: [
        { prelude: [], main: { type: "narration", text: "第一幕" } },
      ],
      state_patch: undefined,
      segmentEnd: { kind: "complete", nonce: "bbbb", reason: "ending" },
    };
    try {
      const app = await createRuntimeApplication({ config, sessionDir });
      expect((app.game as any).narrativeDirector).toBeUndefined();
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
        mode: "longform" as const,
        consolidation: {
          ...DEFAULT_NARRATIVE_CONFIG.consolidation,
          batch_min_events: 1,
          min_checkpoint_gap_ms: 0,
        },
      },
      game: { sessions_dir: sessionDir },
      characters: { suyao: { name: "苏遥", voice_profile: "suyao_main" } },
    });

    // Same envelope as the longform test: narration groups + segmentEnd
    // so game.run() completes.  The nonexistent plan yields an empty plan
    // (loadStoryPlan degrades gracefully), and config normalization
    // ensures getBrief never sees undefined sub-sections.
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
      storyPlanPath: nonexistentPlan,
    });
    expect((app.game as any).narrativeDirector).toBeDefined();

    // game.run() must resolve — proves the TypeError from undefined
    // brief/consolidation sub-sections is gone (config normalization fix).
    const controller = new MemoryController();
    controller.attach(app.game);
    await expect(app.game.run()).resolves.toBeUndefined();

    // Consolidation runs fire-and-forget; yield the microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      access(path.join(sessionDir, "narrative-state.json")),
    ).resolves.toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});
