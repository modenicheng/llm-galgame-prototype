/**
 * Tests for config loading and validation.
 */

import { describe, it, expect, afterAll } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { loadConfig, loadAuthorConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cleanupFiles: string[] = [];

function registerCleanup(filePath: string): void {
  cleanupFiles.push(filePath);
}

afterAll(async () => {
  for (const filePath of cleanupFiles) {
    try {
      await unlink(filePath);
    } catch {
      // best effort
    }
  }
});

async function writeTempYaml(name: string, content: string): Promise<string> {
  const filePath = path.join(tmpdir(), `galgame-test-${name}-${Date.now()}.yaml`);
  await writeFile(filePath, content, "utf8");
  registerCleanup(filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// loadConfig — defaults
// ---------------------------------------------------------------------------

describe("loadConfig defaults", () => {
  it("should load minimal config with all defaults applied", async () => {
    const filePath = await writeTempYaml(
      "minimal",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test-model",
        "  base_url: https://api.example.com",
        "generation:",
        "  temperature: 1.0",
        "prefetch:",
        "  branch_dialogue_lines: 3",
        "media:",
        "  audio:",
        "    enabled: false",
        "game:",
        "  history_events: 80",
      ].join("\n"),
    );

    const config = await loadConfig(filePath);

    expect(config.api.model).toBe("test-model");
    expect(config.api.base_url).toBe("https://api.example.com");
    expect(config.api.api_key_env).toBe("OPENAI_API_KEY"); // default
    expect(config.api.timeout_ms).toBe(60000); // default

    expect(config.generation.temperature).toBe(1.0); // explicit in yaml
    expect(config.generation.max_tokens).toBe(2200); // default
    expect(config.generation.repair_attempts).toBe(2); // default

    // Text buffer defaults (docs §74)
    expect(config.text_buffer.start_threshold_lines).toBe(2);
    expect(config.text_buffer.target_lines).toBe(6);
    expect(config.text_buffer.refill_threshold_lines).toBe(3);

    // Assets defaults (docs §57)
    expect(config.assets.catalog).toBe("assets/resources.yaml");

    // Prefetch defaults (branch_dialogue_lines explicit, rest defaults)
    expect(config.prefetch.branch_dialogue_lines).toBe(3); // explicit
    expect(config.prefetch.branch_concurrency).toBe(3); // default

    // Media defaults
    expect(config.media.audio.enabled).toBe(false);
    expect(config.media.audio.provider).toBe("disabled");
    expect(config.media.audio.active_target_lines).toBe(3);
    expect(config.media.audio.refill_threshold_lines).toBe(2);
    expect(config.media.audio.branch_prefetch_lines).toBe(2);
    expect(config.media.audio.batch_size).toBe(2);
    expect(config.media.audio.max_concurrency).toBe(2);
    expect(config.media.audio.mock_latency_ms).toBe(800);
    expect(config.media.audio.output_dir).toBe("assets/.tts-cache");

    // Game defaults
    expect(config.game.history_events).toBe(80);
    expect(config.game.sessions_dir).toBe("sessions");
    expect(config.game.show_line_ids).toBe(true);

    // Interaction policy defaults
    expect(config.interaction.allowed_modes).toEqual(["choice", "hybrid", "input"]);
    expect(config.interaction.default_mode).toBe("hybrid");
    expect(config.interaction.options.min_count).toBe(2);
    expect(config.interaction.options.max_count).toBe(5);
    expect(config.interaction.input.max_length).toBe(500);
    expect(config.interaction.input.max_consecutive_pure_input).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — all fields explicitly set
// ---------------------------------------------------------------------------

describe("loadConfig with all fields", () => {
  it("should parse a fully-populated config", async () => {
    const yamlContent = [
      "api:",
      "  provider: openai_compatible",
      "  model: gpt-4o",
      "  base_url: https://custom.api.example.com/v2",
      "  api_key_env: CUSTOM_API_KEY",
      "  timeout_ms: 30000",
      "  token_limit_field: max_tokens",
      "",
      "generation:",
      "  temperature: 1.2",
      "  max_tokens: 2000",
      "  repair_attempts: 3",
      "",
      "text_buffer:",
      "  start_threshold_lines: 1",
      "  target_lines: 8",
      "  refill_threshold_lines: 4",
      "",
      "assets:",
      "  catalog: custom/resources.yaml",
      "",
      "prefetch:",
      "  branch_dialogue_lines: 5",
      "  branch_concurrency: 4",
      "  input_bridge:",
      "    enabled: false",
      "    min_events: 2",
      "    max_events: 2",
      "    only_narration: true",
      "",
      "input:",
      "  kind: dialogue",
      "  require_preview_confirmation: false",
      "  show_generation_status: true",
      "",
      "debug:",
      "  runtime_status: true",
      "",
      "media:",
      "  audio:",
      "    enabled: true",
      "    provider: mock",
      "    active_target_lines: 5",
      "    refill_threshold_lines: 3",
      "    branch_prefetch_lines: 3",
      "    batch_size: 4",
      "    max_concurrency: 3",
      "    mock_latency_ms: 1200",
      "    output_dir: custom/assets",
      "",
      "game:",
      "  history_events: 100",
      "  sessions_dir: my_sessions",
      "  show_line_ids: false",
      "",
      "interaction:",
      "  allowed_modes:",
      "    - choice",
      "    - input",
      "  default_mode: input",
      "  options:",
      "    min_count: 3",
      "    max_count: 4",
      "  input:",
      "    max_length: 800",
      "    max_consecutive_pure_input: 2",
    ].join("\n");

    const filePath = await writeTempYaml("full", yamlContent);
    const config = await loadConfig(filePath);

    // API
    expect(config.api.model).toBe("gpt-4o");
    expect(config.api.api_key_env).toBe("CUSTOM_API_KEY");
    expect(config.api.timeout_ms).toBe(30000);
    expect(config.api.token_limit_field).toBe("max_tokens");

    // Generation
    expect(config.generation.temperature).toBe(1.2);
    expect(config.generation.max_tokens).toBe(2000);
    expect(config.generation.repair_attempts).toBe(3);

    // Text buffer
    expect(config.text_buffer.start_threshold_lines).toBe(1);
    expect(config.text_buffer.target_lines).toBe(8);
    expect(config.text_buffer.refill_threshold_lines).toBe(4);

    // Assets
    expect(config.assets.catalog).toBe("custom/resources.yaml");

    // Prefetch
    expect(config.prefetch.branch_dialogue_lines).toBe(5);
    expect(config.prefetch.branch_concurrency).toBe(4);
    expect(config.prefetch.input_bridge.enabled).toBe(false);
    expect(config.prefetch.input_bridge.min_events).toBe(2);
    expect(config.prefetch.input_bridge.max_events).toBe(2);
    expect(config.prefetch.input_bridge.only_narration).toBe(true);

    // Input presentation
    expect(config.input.kind).toBe("dialogue");
    expect(config.input.require_preview_confirmation).toBe(false);
    expect(config.input.show_generation_status).toBe(true);

    // Debug
    expect(config.debug.runtime_status).toBe(true);

    // Media
    expect(config.media.audio.enabled).toBe(true);
    expect(config.media.audio.provider).toBe("mock");
    expect(config.media.audio.active_target_lines).toBe(5);
    expect(config.media.audio.refill_threshold_lines).toBe(3);
    expect(config.media.audio.branch_prefetch_lines).toBe(3);
    expect(config.media.audio.batch_size).toBe(4);
    expect(config.media.audio.max_concurrency).toBe(3);
    expect(config.media.audio.mock_latency_ms).toBe(1200);
    expect(config.media.audio.output_dir).toBe("custom/assets");

    // Game
    expect(config.game.history_events).toBe(100);
    expect(config.game.sessions_dir).toBe("my_sessions");
    expect(config.game.show_line_ids).toBe(false);

    // Interaction policy
    expect(config.interaction.allowed_modes).toEqual(["choice", "input"]);
    expect(config.interaction.default_mode).toBe("input");
    expect(config.interaction.options.min_count).toBe(3);
    expect(config.interaction.options.max_count).toBe(4);
    expect(config.interaction.input.max_length).toBe(800);
    expect(config.interaction.input.max_consecutive_pure_input).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — narrative section
// ---------------------------------------------------------------------------

describe("loadConfig narrative section", () => {
  it("should apply narrative defaults when the section is absent", async () => {
    const filePath = await writeTempYaml(
      "narrative-defaults",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test-model",
        "  base_url: https://api.example.com",
        "generation:",
        "  temperature: 1.0",
        "prefetch:",
        "  branch_dialogue_lines: 3",
        "media:",
        "  audio:",
        "    enabled: false",
        "game:",
        "  history_events: 80",
      ].join("\n"),
    );

    const config = await loadConfig(filePath);

    expect(config.narrative.mode).toBe("longform");
    expect(config.narrative.threads).toEqual({ max_major_active: 2, max_minor_active: 3 });
    expect(config.narrative.setups).toEqual({ max_active: 6 });
    expect(config.narrative.consolidation).toEqual({
      batch_min_events: 4,
      max_events_per_call: 80,
      min_checkpoint_gap_ms: 5000,
    });
    expect(config.narrative.brief).toEqual({
      max_relevant_episodes: 6,
    });
    expect(config.narrative.story_plan_path).toBe("story-plan.yaml");
  });

  it("should parse explicit narrative values overriding defaults", async () => {
    const filePath = await writeTempYaml(
      "narrative-overrides",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test-model",
        "  base_url: https://api.example.com",
        "generation:",
        "  temperature: 1.0",
        "prefetch:",
        "  branch_dialogue_lines: 3",
        "media:",
        "  audio:",
        "    enabled: false",
        "game:",
        "  history_events: 80",
        "",
        "narrative:",
        "  mode: event",
        "  threads:",
        "    max_major_active: 5",
        "    max_minor_active: 8",
        "  setups:",
        "    max_active: 10",
        "  consolidation:",
        "    batch_min_events: 6",
        "    max_events_per_call: 120",
        "    min_checkpoint_gap_ms: 10000",
        "  brief:",
        "    max_relevant_episodes: 3",
        "  story_plan_path: custom/story-plan.yaml",
      ].join("\n"),
    );

    const config = await loadConfig(filePath);

    expect(config.narrative.mode).toBe("event");
    expect(config.narrative.threads).toEqual({ max_major_active: 5, max_minor_active: 8 });
    expect(config.narrative.setups).toEqual({ max_active: 10 });
    expect(config.narrative.consolidation).toEqual({
      batch_min_events: 6,
      max_events_per_call: 120,
      min_checkpoint_gap_ms: 10000,
    });
    expect(config.narrative.brief).toEqual({
      max_relevant_episodes: 3,
    });
    expect(config.narrative.story_plan_path).toBe("custom/story-plan.yaml");
  });

  it("should apply narrative plan defaults when the section is absent", async () => {
    const filePath = await writeTempYaml(
      "narrative-plan-defaults",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test-model",
        "  base_url: https://api.example.com",
        "  api_key_env: TEST_KEY",
        "generation:",
        "  temperature: 1.0",
        "prefetch:",
        "  branch_dialogue_lines: 3",
        "media:",
        "  audio:",
        "    enabled: false",
        "game:",
        "  history_events: 80",
      ].join("\n"),
    );

    const config = await loadConfig(filePath);

    expect(config.narrative.plan).toEqual({
      horizon_checkpoints: 3,
      replan_ahead_checkpoints: 1,
    });
  });

  it("should parse explicit narrative plan values overriding defaults", async () => {
    const filePath = await writeTempYaml(
      "narrative-plan-overrides",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test-model",
        "  base_url: https://api.example.com",
        "  api_key_env: TEST_KEY",
        "generation:",
        "  temperature: 1.0",
        "prefetch:",
        "  branch_dialogue_lines: 3",
        "media:",
        "  audio:",
        "    enabled: false",
        "game:",
        "  history_events: 80",
        "narrative:",
        "  plan:",
        "    horizon_checkpoints: 5",
        "    replan_ahead_checkpoints: 2",
      ].join("\n"),
    );

    const config = await loadConfig(filePath);

    expect(config.narrative.plan).toEqual({
      horizon_checkpoints: 5,
      replan_ahead_checkpoints: 2,
    });
  });

  it("should reject an unsupported narrative mode", async () => {
    const filePath = await writeTempYaml(
      "bad-narrative-mode",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test-model",
        "  base_url: https://api.example.com",
        "generation:",
        "  temperature: 1.0",
        "prefetch:",
        "  branch_dialogue_lines: 3",
        "media:",
        "  audio:",
        "    enabled: false",
        "game:",
        "  history_events: 80",
        "",
        "narrative:",
        "  mode: other",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadAuthorConfig — defaults when file missing
// ---------------------------------------------------------------------------

describe("loadAuthorConfig defaults when file missing", () => {
  it("should return sensible defaults when author.yaml does not exist", async () => {
    const nonExistentPath = path.join(tmpdir(), `galgame-test-nonexistent-${Date.now()}.yaml`);
    // Do NOT create the file — we want the ENOENT path.

    const config = await loadAuthorConfig(nonExistentPath);

    expect(config.control.world.mode).toBe("preferred");
    expect(config.control.characters.mode).toBe("preferred");
    expect(config.control.plot.mode).toBe("free");
    expect(config.control.endings.mode).toBe("free");
    expect(config.control.style.mode).toBe("locked");

    expect(config.rules.locked).toEqual([]);
    expect(config.rules.preferred).toEqual([]);
    expect(config.rules.seeds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadAuthorConfig — parsing when file present
// ---------------------------------------------------------------------------

describe("loadAuthorConfig parsing when file present", () => {
  it("should parse a fully populated author.yaml", async () => {
    const yamlContent = [
      "control:",
      "  world:",
      "    mode: locked",
      "  characters:",
      "    mode: preferred",
      "  plot:",
      "    mode: free",
      "  endings:",
      "    mode: free",
      "  style:",
      "    mode: locked",
      "",
      "rules:",
      "  locked:",
      '    - "故事中不存在超自然力量"',
      '    - "不要直接描述玩家未选择的心理活动"',
      "  preferred:",
      '    - "整体气质克制"',
      '    - "避免长篇世界观解释"',
      "  seeds:",
      '    - "故事从一台被遗忘的旧终端开始"',
    ].join("\n");

    const filePath = await writeTempYaml("author-full", yamlContent);
    const config = await loadAuthorConfig(filePath);

    expect(config.control.world.mode).toBe("locked");
    expect(config.control.characters.mode).toBe("preferred");
    expect(config.control.plot.mode).toBe("free");
    expect(config.control.endings.mode).toBe("free");
    expect(config.control.style.mode).toBe("locked");

    expect(config.rules.locked).toEqual([
      "故事中不存在超自然力量",
      "不要直接描述玩家未选择的心理活动",
    ]);
    expect(config.rules.preferred).toEqual([
      "整体气质克制",
      "避免长篇世界观解释",
    ]);
    expect(config.rules.seeds).toEqual([
      "故事从一台被遗忘的旧终端开始",
    ]);
  });

  it("should parse partial author.yaml applying defaults for missing fields", async () => {
    const yamlContent = [
      "control:",
      "  world:",
      "    mode: free",
      "",
      "rules:",
      "  seeds:",
      '    - "玩家在一个废弃的空间站醒来"',
    ].join("\n");

    const filePath = await writeTempYaml("author-partial", yamlContent);
    const config = await loadAuthorConfig(filePath);

    // Explicit values override
    expect(config.control.world.mode).toBe("free");

    // Missing control sections fall back to defaults
    expect(config.control.characters.mode).toBe("preferred");
    expect(config.control.plot.mode).toBe("free");
    expect(config.control.endings.mode).toBe("free");
    expect(config.control.style.mode).toBe("locked");

    // Missing rule arrays default to empty
    expect(config.rules.locked).toEqual([]);
    expect(config.rules.preferred).toEqual([]);
    expect(config.rules.seeds).toEqual(["玩家在一个废弃的空间站醒来"]);
  });
});

// ---------------------------------------------------------------------------
// loadAuthorConfig — validation errors
// ---------------------------------------------------------------------------

describe("loadAuthorConfig validation errors", () => {
  it("should reject an invalid control mode", async () => {
    const yamlContent = [
      "control:",
      "  world:",
      "    mode: invalid_mode",
    ].join("\n");

    const filePath = await writeTempYaml("author-bad-mode", yamlContent);
    await expect(loadAuthorConfig(filePath)).rejects.toThrow();
  });

  it("should apply all defaults for an empty YAML file", async () => {
    const filePath = await writeTempYaml("author-empty", "");
    const config = await loadAuthorConfig(filePath);

    expect(config.control.world.mode).toBe("preferred");
    expect(config.control.characters.mode).toBe("preferred");
    expect(config.control.plot.mode).toBe("free");
    expect(config.control.endings.mode).toBe("free");
    expect(config.control.style.mode).toBe("locked");
    expect(config.rules.locked).toEqual([]);
    expect(config.rules.preferred).toEqual([]);
    expect(config.rules.seeds).toEqual([]);
  });

  it("should load the real project author.yaml", async () => {
    const config = await loadAuthorConfig("prompts/author.yaml");

    expect(config.control.world.mode).toBe("preferred");
    expect(config.control.characters.mode).toBe("preferred");
    expect(config.control.plot.mode).toBe("free");
    expect(config.control.endings.mode).toBe("free");
    expect(config.control.style.mode).toBe("locked");
    expect(config.rules.locked).toContain("故事中不存在超自然力量");
    expect(config.rules.locked).toContain("不要直接描述玩家未选择的心理活动");
    expect(config.rules.preferred).toContain("整体气质克制");
    expect(config.rules.preferred).toContain("避免长篇世界观解释");
    expect(config.rules.seeds).toContain("故事从一台被遗忘的旧终端开始");
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("loadConfig validation errors", () => {
  it("should reject missing model", async () => {
    const filePath = await writeTempYaml(
      "missing-model",
      [
        "api:",
        "  provider: openai_compatible",
        "  base_url: https://api.example.com",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject invalid base_url", async () => {
    const filePath = await writeTempYaml(
      "bad-url",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: not-a-url",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject refill_threshold_lines >= active_target_lines", async () => {
    const filePath = await writeTempYaml(
      "bad-audio-threshold",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "media:",
        "  audio:",
        "    active_target_lines: 3",
        "    refill_threshold_lines: 5",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject audio enabled with disabled provider", async () => {
    const filePath = await writeTempYaml(
      "bad-audio-provider",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "media:",
        "  audio:",
        "    enabled: true",
        "    provider: disabled",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject temperature out of range", async () => {
    const filePath = await writeTempYaml(
      "bad-temperature",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "generation:",
        "  temperature: 3.0",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject text_buffer.refill_threshold_lines >= target_lines", async () => {
    const filePath = await writeTempYaml(
      "bad-text-buffer-threshold",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "text_buffer:",
        "  target_lines: 3",
        "  refill_threshold_lines: 5",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject input_bridge min_events > max_events", async () => {
    const filePath = await writeTempYaml(
      "bad-bridge-range",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "prefetch:",
        "  input_bridge:",
        "    min_events: 2",
        "    max_events: 1",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject an unsupported input kind", async () => {
    const filePath = await writeTempYaml(
      "bad-input-kind",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "input:",
        "  kind: voice",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject empty interaction.allowed_modes", async () => {
    const filePath = await writeTempYaml(
      "bad-interaction-allowed-modes",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "interaction:",
        "  allowed_modes: []",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject default_mode not in allowed_modes", async () => {
    const filePath = await writeTempYaml(
      "bad-interaction-default-mode",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "interaction:",
        "  allowed_modes:",
        "    - choice",
        "  default_mode: input",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject interaction options min_count < 2", async () => {
    const filePath = await writeTempYaml(
      "bad-interaction-min-count",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "interaction:",
        "  options:",
        "    min_count: 1",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject interaction options max_count > 5", async () => {
    const filePath = await writeTempYaml(
      "bad-interaction-max-count",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "interaction:",
        "  options:",
        "    max_count: 6",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject interaction options min_count > max_count", async () => {
    const filePath = await writeTempYaml(
      "bad-interaction-option-range",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "interaction:",
        "  options:",
        "    min_count: 5",
        "    max_count: 3",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject interaction input.max_length out of range", async () => {
    const filePath = await writeTempYaml(
      "bad-interaction-max-length",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "interaction:",
        "  input:",
        "    max_length: 0",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });

  it("should reject negative max_consecutive_pure_input", async () => {
    const filePath = await writeTempYaml(
      "bad-interaction-consecutive-input",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "interaction:",
        "  input:",
        "    max_consecutive_pure_input: -1",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });
});
