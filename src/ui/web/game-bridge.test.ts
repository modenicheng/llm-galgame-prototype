import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GameBridge } from "./game-bridge.js";
import { WebServer } from "./server.js";
import { WebUI } from "./web-ui.js";
import { makeTestConfig } from "../../test-helpers.js";
import type { Game } from "../../game.js";
import type { StoryGenerator } from "../../llm.js";
import type { AppConfig } from "../../config.js";
import type { StoryContextEvent } from "../../schema.js";
import type { StoryState } from "../../story/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    config = makeTestConfig();
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
