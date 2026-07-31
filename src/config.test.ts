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
    expect(config.generation.max_tokens).toBe(1400); // default
    expect(config.generation.repair_attempts).toBe(2); // default

    // Prefetch defaults (branch_dialogue_lines explicit, rest defaults)
    expect(config.prefetch.branch_dialogue_lines).toBe(3); // explicit
    expect(config.prefetch.branch_max_events).toBe(8); // default
    expect(config.prefetch.branch_concurrency).toBe(3); // default

    // Autocomplete defaults
    expect(config.autocomplete.minimum_characters).toBe(4);
    expect(config.autocomplete.debounce_ms).toBe(350);
    expect(config.autocomplete.max_suffix_characters).toBe(20);
    expect(config.autocomplete.confidence_threshold).toBe(0.55);

    // Media defaults
    expect(config.media.audio.enabled).toBe(false);
    expect(config.media.audio.provider).toBe("disabled");
    expect(config.media.audio.active_target_lines).toBe(3);
    expect(config.media.audio.refill_threshold_lines).toBe(2);
    expect(config.media.audio.branch_prefetch_lines).toBe(2);
    expect(config.media.audio.batch_size).toBe(2);
    expect(config.media.audio.max_concurrency).toBe(2);
    expect(config.media.audio.mock_latency_ms).toBe(800);
    expect(config.media.audio.output_dir).toBe("assets/audio");

    // Game defaults
    expect(config.game.history_events).toBe(80);
    expect(config.game.max_events_per_segment).toBe(12);
    expect(config.game.sessions_dir).toBe("sessions");
    expect(config.game.show_line_ids).toBe(true);

    // Text buffer defaults
    expect(config.text_buffer.refill_threshold_lines).toBe(3);
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
      "  start_threshold_lines: 3",
      "  target_lines: 8",
      "  refill_threshold_lines: 4",
      "",
      "prefetch:",
      "  branch_dialogue_lines: 5",
      "  branch_max_events: 15",
      "  branch_concurrency: 4",
      "  choice:",
      "    enabled: false",
      "    max_branches: 5",
      "    dialogue_lines: 4",
      "    max_events: 12",
      "    concurrency: 2",
      "",
      "autocomplete:",
      "  enabled: false",
      "  minimum_characters: 6",
      "  debounce_ms: 500",
      "  max_suffix_characters: 40",
      "  confidence_threshold: 0.75",
      "",
      "speculative_input:",
      "  enabled: false",
      "  stable_for_ms: 1000",
      "  minimum_confidence: 0.85",
      "  max_branches: 2",
      "  text_lines: 3",
      "  audio_lines: 1",
      "",
      "media:",
      "  audio:",
      "    enabled: true",
      "    provider: mock",
      "    active_target_lines: 5",
      "    refill_threshold_lines: 3",
      "    branch_prefetch_lines: 3",
      "    choice_prefetch_lines: 4",
      "    input_preview_lines: 2",
      "    batch_size: 4",
      "    max_concurrency: 3",
      "    mock_latency_ms: 1200",
      "    output_dir: custom/assets",
      "",
      "game:",
      "  history_events: 100",
      "  max_events_per_segment: 20",
      "  sessions_dir: my_sessions",
      "  show_line_ids: false",
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

    // Prefetch
    expect(config.prefetch.branch_dialogue_lines).toBe(5);
    expect(config.prefetch.branch_max_events).toBe(15);
    expect(config.prefetch.branch_concurrency).toBe(4);

    // Autocomplete
    expect(config.autocomplete.minimum_characters).toBe(6);
    expect(config.autocomplete.debounce_ms).toBe(500);
    expect(config.autocomplete.max_suffix_characters).toBe(40);
    expect(config.autocomplete.confidence_threshold).toBe(0.75);

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
    expect(config.game.max_events_per_segment).toBe(20);
    expect(config.game.sessions_dir).toBe("my_sessions");
    expect(config.game.show_line_ids).toBe(false);

    // Text buffer
    expect(config.text_buffer.refill_threshold_lines).toBe(4);
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

  it("should reject branch_max_events < branch_dialogue_lines", async () => {
    const filePath = await writeTempYaml(
      "bad-prefetch",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "prefetch:",
        "  branch_dialogue_lines: 10",
        "  branch_max_events: 3",
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

  it("should reject invalid autocomplete confidence_threshold", async () => {
    const filePath = await writeTempYaml(
      "bad-autocomplete-confidence",
      [
        "api:",
        "  provider: openai_compatible",
        "  model: test",
        "  base_url: https://api.example.com",
        "",
        "autocomplete:",
        "  confidence_threshold: 1.5",
      ].join("\n"),
    );

    await expect(loadConfig(filePath)).rejects.toThrow();
  });
});
