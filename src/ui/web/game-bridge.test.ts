import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GameBridge } from "./game-bridge.js";
import { WebServer } from "./server.js";
import { WebUI } from "./web-ui.js";
import type { Game } from "../../game.js";
import type { StoryGenerator } from "../../llm.js";
import type { AppConfig } from "../../config.js";
import type { StoryContextEvent } from "../../schema.js";
import type { StoryState } from "../../story/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    api: {
      model: "test-model",
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
      branch_max_events: 4,
      branch_concurrency: 1,
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
      history_events: 20,
      max_events_per_segment: 5,
      sessions_dir: "sessions",
      show_line_ids: false,
    },
    text_buffer: {
      refill_threshold_lines: 3,
    },
    ...overrides,
  };
}

function makeMockGame(): Game {
  const mockState: StoryState = {
    scene: { id: "test", location: "room", purpose: "test" },
    canon: {},
    characters: {},
    open_threads: [],
    recent_summary: "test",
    player_profile: { recent_tendencies: [] },
  };

  return {
    run: vi.fn().mockResolvedValue(undefined),
    getAutocompleteContext: vi.fn().mockReturnValue({
      state: mockState,
      events: [] as StoryContextEvent[],
    }),
  } as unknown as Game;
}

function makeMockGenerator(): StoryGenerator {
  return {
    generateAutocomplete: vi.fn().mockResolvedValue(null),
  } as unknown as StoryGenerator;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GameBridge", () => {
  let config: AppConfig;
  let game: Game;
  let generator: StoryGenerator;

  beforeEach(() => {
    config = makeConfig();
    game = makeMockGame();
    generator = makeMockGenerator();
  });

  it("constructs without error", () => {
    const bridge = new GameBridge(config, generator, game);
    expect(bridge).toBeDefined();
  });

  it("replaces game UI with WebUI during construction", () => {
    const bridge = new GameBridge(config, generator, game);
    // The bridge replaces the game's ui property with a WebUI
    const gameUi = (game as unknown as Record<string, unknown>).ui;
    expect(gameUi).toBeInstanceOf(WebUI);
  });

  it("has getAutocompleteContext accessible from game", () => {
    const bridge = new GameBridge(config, generator, game);
    const ctx = game.getAutocompleteContext();
    expect(ctx).toBeDefined();
    expect(ctx.state).toBeDefined();
    expect(ctx.events).toBeDefined();
  });

  it("WebUI getCurrentInteraction returns null initially", () => {
    const bridge = new GameBridge(config, generator, game);
    const gameUi = (game as unknown as Record<string, unknown>).ui as WebUI;
    expect(gameUi.getCurrentInteraction()).toBeNull();
  });

  it("routeMessage on WebUI routes to internal handler", () => {
    const bridge = new GameBridge(config, generator, game);
    const gameUi = (game as unknown as Record<string, unknown>).ui as WebUI;

    // This should not throw — it routes an unknown message type
    expect(() => gameUi.routeMessage({ type: "advance" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// WebUI message routing
// ---------------------------------------------------------------------------

describe("WebUI", () => {
  let server: WebServer;

  beforeEach(() => {
    server = new WebServer();
  });

  it("constructs without error", () => {
    const ui = new WebUI(server);
    expect(ui).toBeDefined();
  });

  it("getCurrentInteraction returns null initially", () => {
    const ui = new WebUI(server);
    expect(ui.getCurrentInteraction()).toBeNull();
  });

  it("implements all GameUI methods", () => {
    const ui = new WebUI(server);
    expect(typeof ui.printSession).toBe("function");
    expect(typeof ui.renderNarration).toBe("function");
    expect(typeof ui.renderDialogue).toBe("function");
    expect(typeof ui.renderEnd).toBe("function");
    expect(typeof ui.choose).toBe("function");
    expect(typeof ui.inputEditor).toBe("function");
    expect(typeof ui.inputPreview).toBe("function");
    expect(typeof ui.renderHybridInteraction).toBe("function");
    expect(typeof ui.waitForTask).toBe("function");
  });
});
