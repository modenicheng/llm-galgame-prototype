import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutocompleteManager } from "./autocomplete-manager.js";
import type { AutocompleteConfig, AppConfig } from "../../config.js";
import type { StoryGenerator } from "../../llm.js";
import type { WebServer } from "./server.js";
import type { WebSocket as WsImpl } from "ws";
import type { StoryState, InteractionEvent, AutocompleteResult } from "../../story/types.js";
import type { StoryContextEvent } from "../../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AutocompleteConfig> = {}): AutocompleteConfig {
  return {
    enabled: true,
    minimum_characters: 4,
    debounce_ms: 50,
    max_suffix_characters: 20,
    confidence_threshold: 0.55,
    ...overrides,
  };
}

function makeInteraction(overrides: Partial<InteractionEvent> = {}): InteractionEvent {
  return {
    type: "interaction",
    interaction_id: "int-test-001",
    prompt: "What do you say?",
    mode: "input",
    input: {
      kind: "free_text",
      placeholder: "Type here...",
      max_length: 200,
    },
    ...overrides,
  };
}

function makeState(overrides: Partial<StoryState> = {}): StoryState {
  return {
    scene: { id: "test", location: "room", purpose: "test" },
    canon: {},
    characters: {},
    open_threads: [],
    recent_summary: "Nothing happened yet.",
    player_profile: { recent_tendencies: [] },
    ...overrides,
  };
}

function makeMockWs(): WsImpl {
  return {
    readyState: 1, // OPEN
    send: vi.fn(),
  } as unknown as WsImpl;
}

function makeMockServer(): WebServer {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    onMessage: vi.fn(),
  } as unknown as WebServer;
}

function makeMockGenerator(): StoryGenerator {
  return {
    generateAutocomplete: vi.fn(),
  } as unknown as StoryGenerator;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AutocompleteManager", () => {
  let manager: AutocompleteManager;
  let config: AutocompleteConfig;
  let server: WebServer;
  let generator: StoryGenerator;
  let state: StoryState;
  let history: StoryContextEvent[];
  let interaction: InteractionEvent;

  beforeEach(() => {
    config = makeConfig({ debounce_ms: 50 });
    server = makeMockServer();
    generator = makeMockGenerator();
    state = makeState();
    history = [];
    interaction = makeInteraction();
    manager = new AutocompleteManager(config, server, generator);
  });

  afterEach(() => {
    manager.dispose();
  });

  // ---- Debounce behavior ----

  it("does not fire autocomplete before debounce timeout", async () => {
    const ws = makeMockWs();

    manager.onInputChange(ws, "hello", "int-1", 1, state, history, interaction);

    // Immediately after — should not have called generateAutocomplete yet
    expect(generator.generateAutocomplete).not.toHaveBeenCalled();
  });

  it("fires autocomplete after debounce timeout", async () => {
    vi.useFakeTimers();
    const ws = makeMockWs();
    const mockResult: AutocompleteResult = {
      draft_id: "int-1",
      revision: 1,
      suffix: " world",
      intent: "greet",
      confidence: 0.9,
    };
    (generator.generateAutocomplete as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    manager.onInputChange(ws, "hello", "int-1", 1, state, history, interaction);

    // Advance time past debounce
    await vi.advanceTimersByTimeAsync(60);

    expect(generator.generateAutocomplete).toHaveBeenCalledTimes(1);
    expect(generator.generateAutocomplete).toHaveBeenCalledWith(
      state,
      history,
      interaction,
      "hello",
      expect.any(AbortSignal),
    );

    vi.useRealTimers();
  });

  it("debounces: only the last input triggers a request", async () => {
    vi.useFakeTimers();
    const ws = makeMockWs();

    manager.onInputChange(ws, "hel", "int-1", 1, state, history, interaction);
    manager.onInputChange(ws, "hell", "int-1", 2, state, history, interaction);
    manager.onInputChange(ws, "hello", "int-1", 3, state, history, interaction);

    await vi.advanceTimersByTimeAsync(60);

    // Only one call with the final text
    expect(generator.generateAutocomplete).toHaveBeenCalledTimes(1);
    expect(generator.generateAutocomplete).toHaveBeenCalledWith(
      state,
      history,
      interaction,
      "hello",
      expect.any(AbortSignal),
    );

    vi.useRealTimers();
  });

  // ---- Revision tracking ----

  it("ignores stale responses (revision superseded)", async () => {
    vi.useFakeTimers();
    const ws = makeMockWs();

    const mockResult1: AutocompleteResult = {
      draft_id: "int-1",
      revision: 1,
      suffix: " old",
      intent: "old",
      confidence: 0.8,
    };

    let resolveFirst: (v: AutocompleteResult | null) => void = () => {};
    (generator.generateAutocomplete as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<AutocompleteResult | null>((resolve) => { resolveFirst = resolve; }),
    );

    manager.onInputChange(ws, "hello", "int-1", 1, state, history, interaction);
    await vi.advanceTimersByTimeAsync(60);

    // Before the first request resolves, send a new input with higher revision
    manager.onInputChange(ws, "hello w", "int-1", 2, state, history, interaction);
    await vi.advanceTimersByTimeAsync(60);

    // Resolve the first (stale) request
    resolveFirst(mockResult1);

    // The stale result should NOT have been sent
    expect(server.send).not.toHaveBeenCalledWith(ws, expect.objectContaining({
      type: "autocomplete",
      result: expect.objectContaining({ suffix: " old" }),
    }));

    vi.useRealTimers();
  });

  it("sends result when revision is still current", async () => {
    // Use a config with very short debounce for real timers
    const fastConfig = makeConfig({ debounce_ms: 10 });
    const fastManager = new AutocompleteManager(fastConfig, server, generator);
    const ws = makeMockWs();
    const mockResult: AutocompleteResult = {
      draft_id: "int-1",
      revision: 1,
      suffix: " world",
      intent: "greet",
      confidence: 0.9,
    };
    (generator.generateAutocomplete as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    fastManager.onInputChange(ws, "hello", "int-1", 1, state, history, interaction);

    // Wait for debounce + promise resolution
    await new Promise((r) => setTimeout(r, 50));

    expect(server.send).toHaveBeenCalledWith(ws, {
      type: "autocomplete",
      result: {
        suffix: " world",
        intent: "greet",
        confidence: 0.9,
        revision: 1,
      },
    });

    fastManager.dispose();
  });

  // ---- Composition suppression ----

  it("does not fire autocomplete during IME composition", async () => {
    vi.useFakeTimers();
    const ws = makeMockWs();

    manager.setComposing(true);

    manager.onInputChange(ws, "hello", "int-1", 1, state, history, interaction);
    await vi.advanceTimersByTimeAsync(60);

    expect(generator.generateAutocomplete).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("resumes autocomplete after composition ends", async () => {
    vi.useFakeTimers();
    const ws = makeMockWs();

    manager.setComposing(true);
    manager.onInputChange(ws, "hello", "int-1", 1, state, history, interaction);
    await vi.advanceTimersByTimeAsync(60);
    expect(generator.generateAutocomplete).not.toHaveBeenCalled();

    manager.setComposing(false);
    manager.onInputChange(ws, "hello world", "int-1", 2, state, history, interaction);
    await vi.advanceTimersByTimeAsync(60);
    expect(generator.generateAutocomplete).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // ---- Empty / short input handling ----

  it("sends null for text shorter than minimum_characters", () => {
    const ws = makeMockWs();

    manager.onInputChange(ws, "ab", "int-1", 1, state, history, interaction);

    // Should immediately send null (no debounce needed for clearing)
    expect(server.send).toHaveBeenCalledWith(ws, { type: "autocomplete", result: null });
  });

  it("does not fire for empty string", () => {
    const ws = makeMockWs();

    manager.onInputChange(ws, "", "int-1", 1, state, history, interaction);

    expect(server.send).toHaveBeenCalledWith(ws, { type: "autocomplete", result: null });
  });

  // ---- Disposal ----

  it("dispose clears pending timers and aborts in-flight requests", () => {
    vi.useFakeTimers();
    const ws = makeMockWs();

    manager.onInputChange(ws, "hello", "int-1", 1, state, history, interaction);
    manager.dispose();

    // Advance time — no request should fire
    vi.advanceTimersByTime(60);
    expect(generator.generateAutocomplete).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
