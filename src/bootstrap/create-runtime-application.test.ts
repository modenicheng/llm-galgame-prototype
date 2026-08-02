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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeApplication } from "./create-runtime-application.js";
import { makeTestConfig, MemoryController } from "../test-helpers.js";
import type { ModelEvent } from "../schema.js";

// The TTS providers (Task B) and the performance compiler impl (Task H)
// land in parallel with this task. The composition test never exercises
// real synthesis, so stub them here to keep the test hermetic regardless
// of landing order. The factory must export the exact names
// create-runtime-application imports.
vi.mock("../adapters/tts/mock-streaming-tts-provider.js", () => ({
  MockStreamingTtsProvider: class {},
}));
vi.mock("../adapters/tts/dashscope-cosyvoice-provider.js", () => ({
  DashScopeCosyVoiceProvider: class {},
}));
vi.mock("../application/audio/performance-compiler.js", () => ({
  PerformanceCompilerImpl: class {
    compile() {
      return { rate: 1, pitch: 1, volume: 1, pauseBeforeMs: 0, pauseAfterMs: 0 };
    }
  },
}));

/** Mutable envelopes the mocked StoryGenerator returns (per test). */
const generatorState = vi.hoisted(() => ({
  opening: { events: [] as ModelEvent[], state_patch: undefined as unknown },
}));

vi.mock("../adapters/llm/openai-compatible-generator.js", () => ({
  StoryGenerator: class {
    generateOpening = vi.fn(async () => generatorState.opening);
    generateBranchPrefetch = vi.fn(async () => ({ events: [], state_patch: undefined }));
    generateInputResponse = vi.fn(async () => ({ events: [], state_patch: undefined }));
    generateContinuation = vi.fn(async () => ({ events: [], state_patch: undefined }));
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
        旁白: { name: "旁白", voice_profile: "narrator" },
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

  it("drives a session end-to-end with the MemoryController and the run loop exits", async () => {
    const config = makeTestConfig({
      characters: {
        suyao: { name: "苏遥", voice_profile: "suyao_main" },
        旁白: { name: "旁白", voice_profile: "narrator" },
      },
    });
    const sessionDir = await mkdtemp(path.join(tmpdir(), "galgame-session-"));
    generatorState.opening = {
      events: [
        { type: "narration", text: "第一幕" },
        { type: "end", ending_id: "e1", text: "终" },
      ],
      state_patch: undefined,
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
    expect(snap.ending?.ending_id).toBe("e1");
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
        旁白: { name: "旁白", voice_profile: "narrator" },
      },
    });
    const sessionDir = await mkdtemp(path.join(tmpdir(), "galgame-session-"));
    // Opening yields only an input interaction: no controller attached, so
    // run() parks inside handleInteractionInput awaiting preview_input.
    generatorState.opening = {
      events: [
        {
          type: "interaction",
          interaction_id: "int_1",
          prompt: "说什么？",
          mode: "input",
          input: { kind: "free_text", placeholder: "...", max_length: 200 },
          input_bridge: { events: [] },
        },
      ],
      state_patch: undefined,
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

    const runPromise = app.game.run().catch((error: unknown) => error);
    await opened;

    await app.shutdown();
    const result = await runPromise;
    // The run loop unwinds by throwing RuntimeShutdownError — the documented
    // shutdown contract (hosts treat it as a clean exit).
    expect(String(result)).toContain("运行时已收到关闭指令");

    await rm(sessionDir, { recursive: true, force: true });
  });
});
