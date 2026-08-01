import type { AppConfig } from "./config.js";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Shared test fixture for a fully-populated AppConfig.
 *
 * Every test file that needs a Game / StoryGenerator / GameUI should
 * use this instead of inlining its own copy. Override individual sections
 * via `overrides` (deep partial, e.g. `{ game: { sessions_dir } }`).
 */
export function makeTestConfig(overrides?: DeepPartial<AppConfig>): AppConfig {
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
    prefetch: {
      branch_dialogue_lines: 2,
      branch_concurrency: 2,
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
      sessions_dir: "sessions",
      show_line_ids: true,
    },
    ...overrides,
  } as AppConfig;
}
