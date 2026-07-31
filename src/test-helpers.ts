import type { AppConfig } from "./config.js";

/**
 * Shared test fixture for a fully-populated AppConfig.
 *
 * Every test file that needs a Game / StoryGenerator / GameBridge should
 * use this instead of inlining its own copy. Override individual sections
 * via `overrides` (shallow merge at the top level).
 */
export function makeTestConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    api: {
      model: "test-model",
      base_url: "https://api.test.example.com",
      api_key_env: "TEST_KEY",
      timeout_ms: 5000,
      token_limit_field: "max_completion_tokens",
    },
    generation: {
      temperature: 1.0,
      max_tokens: 500,
      repair_attempts: 0,
    },
    text_buffer: {
      refill_threshold_lines: 3,
    },
    prefetch: {
      branch_dialogue_lines: 2,
      branch_max_events: 4,
      branch_concurrency: 2,
    },
    autocomplete: {
      minimum_characters: 4,
      debounce_ms: 350,
      max_suffix_characters: 20,
      confidence_threshold: 0.55,
    },
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
      },
    },
    game: {
      history_events: 80,
      max_events_per_segment: 12,
      sessions_dir: "sessions",
      show_line_ids: true,
    },
    ...overrides,
  };
}
