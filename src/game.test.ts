/**
 * Tests for Game class core logic: construction, state management,
 * event materialization, sequence numbering, buffered tracking,
 * and metrics wiring in error paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Game } from "./game.js";
import { Metrics } from "./runtime/metrics.js";
import { createInitialState } from "./story/state.js";
import {
  makeTestConfig,
  makeTestPorts,
  MemoryController,
} from "./test-helpers.js";
import { NodeJsonlSessionStore } from "./adapters/storage/node-jsonl-session-store.js";
import { SessionIdGenerator } from "./adapters/platform/session-id-generator.js";
import type { StoryGenerator } from "./adapters/llm/openai-compatible-generator.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import type { RuntimeStatus } from "./status.js";
import type { AppConfig } from "./config.js";
import type {
  ModelEvent,
  RuntimePlayableEvent,
  NarrationDraftEvent,
  EndEvent,
  StoredEvent,
  StoryContextEvent,
  ChoiceEvent,
  InteractionEvent,
} from "./schema.js";
import type { RuntimeCommand } from "./core/runtime/runtime-command.js";
import type { GenerationEnvelope } from "./story/types.js";
import type { InteractionOpenedOutput } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockGenerator(): StoryGenerator {
  return {
    generateOpening: vi.fn(),
    generateBranchPrefetch: vi.fn(),
    generateInputResponse: vi.fn(),
    generateContinuation: vi.fn(),
  } as unknown as StoryGenerator;
}

function makeMockMedia(): MediaPlannerPort {
  return {
    registerActive: vi.fn(),
    registerCandidate: vi.fn(),
    activateCandidate: vi.fn(),
    discardCandidate: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    markPresented: vi.fn(),
  } as unknown as MediaPlannerPort;
}

function makeMockStatus(): RuntimeStatus {
  return {
    setPhase: vi.fn(),
    setJob: vi.fn(),
    removeJob: vi.fn(),
    setBuffer: vi.fn(),
    setBranch: vi.fn(),
    clearBranches: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => undefined),
    snapshot: vi.fn().mockReturnValue({ branches: {} }),
  } as unknown as RuntimeStatus;
}

/** Build a minimal GenerationEnvelope for the mock generator. */
function envelope(
  events: ModelEvent[],
  state_patch: GenerationEnvelope["state_patch"] = {},
): GenerationEnvelope {
  return { events, state_patch };
}

function narrationEvent(text = "Some narration."): NarrationDraftEvent {
  return { type: "narration", text };
}

function endEvent(endingId = "end_1", text = "The end."): EndEvent {
  return { type: "end", ending_id: endingId, text };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("Game construction", () => {
  let config: AppConfig;
  let generator: StoryGenerator;
  let status: RuntimeStatus;
  let media: MediaPlannerPort;

  beforeEach(() => {
    config = makeTestConfig();
    generator = makeMockGenerator();
    status = makeMockStatus();
    media = makeMockMedia();
  });

  it("should create a Game instance with all expected infrastructure", () => {
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    expect(game).toBeDefined();
    expect(game.getMetrics).toBeInstanceOf(Function);
  });

  it("should initialise with an empty events array", () => {
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const events = (game as any).events;
    expect(events).toEqual([]);
  });

  it("should initialise with the default StoryState", () => {
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const state = (game as any).storyState;
    expect(state).toEqual(createInitialState());
  });

  it("should auto-create a Metrics instance when none is provided", () => {
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const snap = game.getMetrics();
    expect(snap).toBeDefined();
    expect(snap.llm.requests.opening).toBe(0);
  });

  it("should accept and use an external Metrics instance", () => {
    const metrics = new Metrics();
    metrics.recordBranchRequested(7);
    const game = new Game(config, generator, status, media, metrics, makeTestPorts());
    expect(game.getMetrics().prefetch.branches_requested).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Session ID format
// ---------------------------------------------------------------------------

describe("Session ID", () => {
  let config: AppConfig;
  let generator: StoryGenerator;
  let status: RuntimeStatus;
  let media: MediaPlannerPort;

  beforeEach(() => {
    config = makeTestConfig();
    generator = makeMockGenerator();
    status = makeMockStatus();
    media = makeMockMedia();
  });

  it("should produce a session ID with only safe filename characters", () => {
    // The SessionIdGenerator replaces : and . with -, so only alphanum, T, Z, and -
    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ ids: new SessionIdGenerator() }));
    const sid = (game as any).sessionId as string;
    expect(sid).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  it("should not contain colons or dots", () => {
    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ ids: new SessionIdGenerator() }));
    const sid = (game as any).sessionId as string;
    expect(sid).not.toContain(":");
    expect(sid).not.toContain(".");
  });

  it("should produce different IDs for different instances at different times", async () => {
    const game1 = new Game(config, generator, status, media, undefined, makeTestPorts({ ids: new SessionIdGenerator() }));
    await new Promise((r) => setTimeout(r, 2));
    const game2 = new Game(config, generator, status, media, undefined, makeTestPorts({ ids: new SessionIdGenerator() }));
    const sid1 = (game1 as any).sessionId as string;
    const sid2 = (game2 as any).sessionId as string;
    expect(sid1).not.toBe(sid2);
  });
});

// ---------------------------------------------------------------------------
// Internal state access (events / story state)
// ---------------------------------------------------------------------------

describe("internal state access", () => {
  let config: AppConfig;
  let generator: StoryGenerator;
  let status: RuntimeStatus;
  let media: MediaPlannerPort;

  beforeEach(() => {
    config = makeTestConfig();
    generator = makeMockGenerator();
    status = makeMockStatus();
    media = makeMockMedia();
  });

  it("should expose the current story state", () => {
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const state = (game as any).storyState;
    expect(state).toBeDefined();
    expect(state.scene.id).toBe("prologue");
  });

  it("should reflect events after a player choice is recorded", () => {
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const g = game as any;
    g.recordPlayerChoice({ id: "opt_1", text: "Go left" }, 1);

    const events = g.events;
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: "player_choice",
      choice_id: "opt_1",
      text: "Go left",
      turn: 1,
      source: "player",
    });
  });
});

// ---------------------------------------------------------------------------
// Event materialization (materializeEvents)
// ---------------------------------------------------------------------------

describe("materializeEvents", () => {
  let game: Game;

  beforeEach(() => {
    game = new Game(
      makeTestConfig(),
      makeMockGenerator(),
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
  });

  it("should assign line_id to playable events (narration, dialogue)", () => {
    const drafts: ModelEvent[] = [
      { type: "narration", text: "It was a dark night." },
      {
        type: "dialogue",
        speaker: "Hero",
        text: "Hello!",
        portrait: null,
      },
    ];
    const g = game as any;
    const result = g.materializeEvents(drafts) as RuntimePlayableEvent[];

    expect(result).toHaveLength(2);
    for (const event of result) {
      expect(event).toHaveProperty("line_id");
      expect(typeof event.line_id).toBe("string");
      expect(event.line_id).toMatch(/^line_/);
    }
  });

  it("should NOT assign line_id to non-playable events (choice, end, interaction)", () => {
    const drafts: ModelEvent[] = [
      { type: "narration", text: "Narration." },
      {
        type: "choice",
        prompt: "Choose:",
        options: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
      },
      { type: "end", ending_id: "end_1", text: "The end." },
      {
        type: "interaction",
        interaction_id: "int_1",
        prompt: "What do you say?",
        mode: "input",
        input: { kind: "free_text", placeholder: "Type...", max_length: 100 },
        input_bridge: {
          events: [{ type: "narration", text: "她等待着你的回答。" }],
        },
      },
    ];
    const g = game as any;
    const result = g.materializeEvents(drafts);

    // First event is narration -> should have line_id
    expect(result[0]).toHaveProperty("line_id");

    // choice, end, interaction should NOT have line_id
    expect(result[1]).not.toHaveProperty("line_id");
    expect(result[2]).not.toHaveProperty("line_id");
    expect(result[3]).not.toHaveProperty("line_id");
  });

  it("should produce unique line_ids on each call", () => {
    const drafts: ModelEvent[] = [
      { type: "narration", text: "First." },
      { type: "narration", text: "Second." },
    ];
    const g = game as any;
    const result1 = g.materializeEvents(drafts) as RuntimePlayableEvent[];
    const result2 = g.materializeEvents(drafts) as RuntimePlayableEvent[];

    const allIds = [...result1, ...result2].map((e) => e.line_id);
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Line ID uniqueness and format
// ---------------------------------------------------------------------------

describe("Line ID generation", () => {
  let game: Game;

  beforeEach(() => {
    game = new Game(
      makeTestConfig(),
      makeMockGenerator(),
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
  });

  it("should produce monotonically incrementing line_id suffixes", () => {
    const g = game as any;
    const draft: ModelEvent[] = [{ type: "narration", text: "X" }];

    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const [event] = g.materializeEvents(draft) as RuntimePlayableEvent[];
      expect(event).toBeDefined();
      if (!event) throw new Error("materializeEvents 返回空结果");
      ids.push(event.line_id);
    }

    // Extract sequence numbers
    const seqs = ids.map((id) => {
      const match = /line_.+_(\d{6})$/.exec(id);
      return match ? parseInt(match[1]!, 10) : -1;
    });

    expect(seqs.every((s) => s > 0)).toBe(true);
    // Must be strictly increasing
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1]!;
      const curr = seqs[i]!;
      expect(curr).toBeGreaterThan(prev);
    }
  });

  it("should embed the session ID in the line_id", () => {
    const g = game as any;
    const sid = g.sessionId as string;
    const [event] = g.materializeEvents([
      { type: "narration", text: "X" },
    ]) as RuntimePlayableEvent[];
    expect(event).toBeDefined();
    if (!event) throw new Error("materializeEvents 返回空结果");
    expect(event.line_id).toContain(sid);
  });
});

// ---------------------------------------------------------------------------
// Player choice recording (recordPlayerChoice)
// ---------------------------------------------------------------------------

describe("recordPlayerChoice", () => {
  let game: Game;
  let gen: StoryGenerator;

  beforeEach(() => {
    gen = makeMockGenerator();
    game = new Game(
      makeTestConfig(),
      gen,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
  });

  it("should record a StoredPlayerChoiceEvent with correct structure", async () => {
    const g = game as any;
    await g.recordPlayerChoice({ id: "opt_1", text: "Go left" }, 3);

    const events = g.events;
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event).toMatchObject({
      type: "player_choice",
      choice_id: "opt_1",
      text: "Go left",
      source: "player",
      turn: 3,
    });
    expect(event).toHaveProperty("seq");
    expect(event).toHaveProperty("timestamp");
    expect(typeof (event as any).seq).toBe("number");
    expect(typeof (event as any).timestamp).toBe("string");
  });

  it("should emit a valid ISO timestamp", async () => {
    const g = game as any;
    await g.recordPlayerChoice({ id: "opt_1", text: "Go left" }, 1);
    const events = (game as any).events as any[];
    const ts = events[0].timestamp as string;
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).toISOString()).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// Player input recording (recordPlayerInput)
// ---------------------------------------------------------------------------

describe("recordPlayerInput", () => {
  let game: Game;

  beforeEach(() => {
    game = new Game(
      makeTestConfig(),
      makeMockGenerator(),
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
  });

  it("should record a StoredPlayerInputEvent with correct structure", async () => {
    const g = game as any;
    await g.recordPlayerInput("int_42", "I open the door.", 2);

    const events = g.events;
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event).toMatchObject({
      type: "player_input",
      interaction_id: "int_42",
      text: "I open the door.",
      source: "player",
      turn: 2,
    });
  });

  it("should handle empty text", async () => {
    const g = game as any;
    await g.recordPlayerInput("int_1", "", 1);

    const events = g.events;
    expect(events[0]).toMatchObject({
      type: "player_input",
      text: "",
    });
  });

  it("should handle long text", async () => {
    const g = game as any;
    const longText = "A".repeat(1000);
    await g.recordPlayerInput("int_1", longText, 1);

    const events = g.events;
    expect(events[0]).toMatchObject({
      text: longText,
    });
  });
});

// ---------------------------------------------------------------------------
// Sequence numbering (seq)
// ---------------------------------------------------------------------------

describe("Sequence numbering", () => {
  let game: Game;

  beforeEach(() => {
    game = new Game(
      makeTestConfig(),
      makeMockGenerator(),
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
  });

  it("should start seq at 1 and increment monotonically across record calls", async () => {
    const g = game as any;

    // Initial seq should be 1 (private field)
    // Record two player choices, then a player input
    await g.recordPlayerChoice({ id: "a", text: "A" }, 1);
    await g.recordPlayerInput("int_1", "text", 1);
    await g.recordPlayerChoice({ id: "b", text: "B" }, 2);

    const events = (game as any).events;
    const seqs = events.map((e: any) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("should assign seq independently of turn number", async () => {
    const g = game as any;
    await g.recordPlayerChoice({ id: "a", text: "A" }, 10);
    await g.recordPlayerChoice({ id: "b", text: "B" }, 5);

    const events = (game as any).events;
    const seqs = events.map((e: any) => e.seq);
    expect(seqs).toEqual([1, 2]);
  });

  it("should maintain seq across mixed record types", async () => {
    const g = game as any;
    // Simulate recordModelEvent manually
    const modelEvent = {
      type: "narration" as const,
      text: "Hello",
      line_id: "line_test_000001",
    };
    await g.recordModelEvent(modelEvent, 1);
    await g.recordPlayerChoice({ id: "c", text: "C" }, 1);
    await g.recordModelEvent({ ...modelEvent, line_id: "line_test_000002" }, 2);

    const events = (game as any).events;
    const seqs = events.map((e: any) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Buffered event tracking (registerBuffered)
// ---------------------------------------------------------------------------

describe("registerBuffered", () => {
  let game: Game;
  let status: RuntimeStatus;

  beforeEach(() => {
    status = makeMockStatus();
    game = new Game(
      makeTestConfig(),
      makeMockGenerator(),
      status,
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
  });

  it("should call status.setBuffer with correct event counts", () => {
    const g = game as any;
    const events: RuntimePlayableEvent[] = [
      { type: "narration", text: "A", line_id: "line_001" },
      { type: "dialogue", speaker: "X", text: "Hi", line_id: "line_002" },
      { type: "dialogue", speaker: "Y", text: "Hello", line_id: "line_003" },
      { type: "narration", text: "B", line_id: "line_004" },
    ];
    g.registerBuffered(events);
    expect(status.setBuffer).toHaveBeenCalledWith(4, 2);
  });

  it("should update buffer after adding more events via successive calls", () => {
    const g = game as any;
    g.registerBuffered([
      { type: "dialogue", speaker: "A", text: "One", line_id: "l1" },
    ]);
    expect(status.setBuffer).toHaveBeenLastCalledWith(1, 1);

    g.registerBuffered([
      { type: "narration", text: "Two", line_id: "l2" },
    ]);
    // Buffer should now contain both events
    expect(status.setBuffer).toHaveBeenLastCalledWith(2, 1);
  });

  it("should report zero when buffer is empty (before any registration)", () => {
    // A fresh game has no buffered events yet; updateBufferStatus is
    // called in constructor indirectly? No — registerBuffered triggers it.
    // Just verify calling setBuffer manually doesn't error.
    const g = game as any;
    g.updateBufferStatus();
    expect(status.setBuffer).toHaveBeenCalledWith(0, 0);
  });
});

// ---------------------------------------------------------------------------
// JSONL store initialization
// ---------------------------------------------------------------------------

describe("JSONL store initialization", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "galgame-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should create the sessions directory during run()", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const generator = makeMockGenerator();
    const status = makeMockStatus();
    const media = makeMockMedia();

    // Mock the generator to throw after init so run() doesn't loop forever
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("stop"),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    new MemoryController().attach(game);

    try {
      await game.run();
    } catch {
      // Expected — generator throws after initialization
    }

    // store.initialize() calls mkdir, so sessions dir should exist
    const { stat } = await import("node:fs/promises");
    const dirStat = await stat(sessionsDir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("should create a .jsonl file and write events to it during a successful run", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    // Return a minimal [narration, end] segment so run() completes
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("It begins."), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    new MemoryController().attach(game);
    await game.run();

    // Verify the jsonl file exists and has content
    const { readFile } = await import("node:fs/promises");
    const store = (game as any).store;
    const content = await readFile(store.location, "utf8");
    expect(content).toContain('"type":"narration"');
    expect(content).toContain('"type":"end"');
  });

  it("preserves generated events and repairs the segment when the opening stream fails", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    let openingCalls = 0;
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      async (_turn, _state, _signal, options) => {
        openingCalls += 1;
        if (openingCalls === 1) {
          // Stream two events, then fail mid-stream before any terminal event.
          options!.onEvent!({ type: "narration", text: "第一句。" });
          options!.onEvent!({ type: "dialogue", speaker: "小樱", text: "第二句。" });
          throw new Error("网络中断");
        }
        throw new Error("unexpected second opening call");
      },
    );
    // The repair path must use a continuation request seeded with the
    // preserved prefix.
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      async (_turn, _state, history, prefetchedEvents) => {
        expect(prefetchedEvents).toHaveLength(2);
        expect(history).toContainEqual(
          expect.objectContaining({ type: "dialogue", speaker: "小樱" }),
        );
        return envelope([narrationEvent("修复后的开场。"), endEvent("end_1", "Fin.")]);
      },
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    const controller = new MemoryController();
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(openingCalls).toBe(1);
    // 第一句旁白 + 修复段旁白；第二句对话；结局一次。
    expect(controller.countPlayback("narration")).toBe(2);
    expect(controller.countPlayback("dialogue")).toBe(1);
    expect(controller.ended()).toBe(true);
  });

  it("throws when segment repairs are exhausted", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    // Both the opening and the repair continuation fail after publishing
    // one event; the budget of one repair must be exhausted.
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t, _s, _sig, options) => {
        options!.onEvent!({ type: "narration", text: "半句。" });
        throw new Error("open 失败");
      },
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t, _s, _h, _p, _sig, options) => {
        options!.onEvent!({ type: "narration", text: "修复段半句。" });
        throw new Error("修复失败");
      },
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    new MemoryController().attach(game);
    await expect(game.run()).rejects.toThrow(/剧情段连续失败/);
  });

  it("routes a repaired segment's choice into the normal branch flow", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    let openingCalls = 0;
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t, _s, _sig, options) => {
        openingCalls += 1;
        if (openingCalls === 1) {
          options!.onEvent!({ type: "narration", text: "开场半句。" });
          throw new Error("网络中断");
        }
        throw new Error("unexpected second opening call");
      },
    );
    // Repair continuation ends in a choice; the branch flow must take over.
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () =>
        envelope([
          narrationEvent("修复段内容。"),
          {
            type: "choice",
            prompt: "怎么选？",
            options: [
              { id: "a", text: "选项A" },
              { id: "b", text: "选项B" },
            ],
          },
        ]),
      )
      .mockImplementationOnce(async () =>
        envelope([narrationEvent("续写结尾。"), endEvent("end_1", "Fin.")]),
      );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.select(output.interactionId, "a");
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // 开场半句 + 修复段 + 分支 + 续写结尾 = 4 段旁白；结局 1 次。
    expect(controller.countPlayback("narration")).toBe(4);
    expect(controller.ended()).toBe(true);
    expect(controller.count("interaction_opened")).toBe(1);
  });

  it("does not crash when the continuation segment fails while the preview is still playing", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    // Gate the second playback_ready so the run loop is blocked in preview
    // playback while the background continuation segment fails — the exact
    // window that used to produce an unhandled rejection and crash the
    // process.
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    let playbackCount = 0;
    const controller = new MemoryController({
      onPlaybackReady: async () => {
        playbackCount += 1;
        if (playbackCount === 2) await previewGate;
        controller.dispatch({ type: "advance" });
      },
      onInteractionOpened: (output) => {
        controller.select(output.interactionId, "a");
      },
    });

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([
        narrationEvent("开场。"),
        {
          type: "choice",
          prompt: "怎么选？",
          options: [
            { id: "a", text: "选项A" },
            { id: "b", text: "选项B" },
          ],
        },
      ]),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );
    // Continuation #1: publish one line, then fail mid-stream while the
    // run loop is still presenting the selected branch's preview.
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        async (_t, _s, _h, _p, _sig, options) => {
          options!.onEvent!({ type: "narration", text: "续写半句。" });
          throw new Error("续写网络中断");
        },
      )
      // Repair continuation completes the story.
      .mockImplementationOnce(async () =>
        envelope([narrationEvent("修复续写。"), endEvent("end_1", "Fin.")]),
      );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    controller.attach(game);
    const runPromise = game.run();

    // Let the run loop reach the gated preview line, then give the
    // continuation segment's rejection time to propagate.
    await vi.waitFor(() => {
      expect(playbackCount).toBe(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releasePreview();

    // Without the factory-level catch on segment.done this run would die of
    // an unhandled rejection; with it, the repair path takes over and the
    // game finishes normally.
    await expect(runPromise).resolves.toBeUndefined();
    // 开场 + 分支内容 + 续写半句 + 修复续写 = 4 段旁白；结局 1 次。
    expect(controller.countPlayback("narration")).toBe(4);
    expect(controller.ended()).toBe(true);
    expect(controller.count("interaction_opened")).toBe(1);
    expect(generator.generateContinuation).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Input preview cancellation
// ---------------------------------------------------------------------------

describe("Input preview cancellation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "galgame-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("aborts the stale NPC response when the preview is cancelled; its events never render", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "int_1",
          prompt: "说什么？",
          mode: "input",
          input: { kind: "free_text", placeholder: "...", max_length: 200 },
          input_bridge: {
            events: [{ type: "narration", text: "她静静地看着你。" }],
          },
        },
      ]),
    );

    // First (stale) response: a pending promise resolved only after run()
    // completes. Second response: resolves normally.
    let resolveStale!: (value: unknown) => void;
    const staleResponse = new Promise((resolve) => {
      resolveStale = resolve;
    });
    const generateInputResponse = generator.generateInputResponse as ReturnType<typeof vi.fn>;
    generateInputResponse
      .mockImplementationOnce(() => staleResponse)
      .mockResolvedValueOnce(envelope([narrationEvent("回应。")]));
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    // Editor round 1: submit "你好", preview cancels. Round 2: submit
    // "你好吗", preview confirms.
    let previewIndex = 0;
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.submitInput(
          output.interactionId,
          previewIndex === 0 ? "你好" : "你好吗",
        );
      },
      onInputPreviewOpened: (output) => {
        if (previewIndex === 0) controller.cancel(output.previewId);
        else controller.confirm(output.previewId);
        previewIndex += 1;
      },
    });

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // At this point only the committed response (and opening/continuation)
    // have rendered: 开场 + bridge + 回应 + 结尾 = 4 段旁白，外加玩家的台词。
    expect(controller.countPlayback("narration")).toBe(4);
    expect(controller.count("interaction_opened")).toBe(2);
    expect(controller.count("input_preview_opened")).toBe(2);
    expect(controller.count("input_preview_canceled")).toBe(1);
    expect(controller.count("input_committed")).toBe(1);
    expect(generateInputResponse).toHaveBeenCalledTimes(2);

    // Now the stale response finally arrives — it must be discarded.
    resolveStale(envelope([narrationEvent("过期回应。")]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controller.countPlayback("narration")).toBe(4);
    expect(game.getMetrics().input.preview_count).toBe(2);
  });

  it("leaves no buffered/media residue when a completed response is cancelled", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "int_1",
          prompt: "说什么？",
          mode: "input",
          input: { kind: "free_text", placeholder: "...", max_length: 200 },
          input_bridge: {
            events: [{ type: "narration", text: "她静静地看着你。" }],
          },
        },
      ]),
    );
    const generateInputResponse = generator.generateInputResponse as ReturnType<typeof vi.fn>;
    // First response resolves immediately (completed BEFORE the cancel);
    // second resolves normally.
    generateInputResponse
      .mockResolvedValueOnce(envelope([narrationEvent("已完成的回应。")]))
      .mockResolvedValueOnce(envelope([narrationEvent("第二次回应。")]));
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    let previewIndex = 0;
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.submitInput(
          output.interactionId,
          previewIndex === 0 ? "第一次" : "第二次",
        );
      },
      onInputPreviewOpened: (output) => {
        if (previewIndex === 0) controller.cancel(output.previewId);
        else controller.confirm(output.previewId);
        previewIndex += 1;
      },
    });

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // Only the second (committed) response may reach the media timeline;
    // the cancelled first response must never appear.
    const registerActive = media.registerActive as ReturnType<typeof vi.fn>;
    const appendedTexts = registerActive.mock.calls.flatMap((call) =>
      (call[0] as RuntimePlayableEvent[]).map((e) => e.text),
    );
    expect(appendedTexts).not.toContain("已完成的回应。");
    expect(appendedTexts).toContain("第二次回应。");

    const buffered = (game as any).buffered as Map<string, RuntimePlayableEvent>;
    // Every rendered line is consumed and removed; the cancelled response
    // must leave no residue behind.
    expect([...buffered.values()]).toEqual([]);
    // 开场 + bridge + 第二次回应 + 结尾 = 4 段旁白；第一次的回应从未渲染。
    expect(controller.countPlayback("narration")).toBe(4);
    // 玩家的台词以 player_dialogue 播放，不进入媒体时间线。
    const playerLines = controller.playbackEvents().filter(
      (output) => output.event.type === "player_dialogue",
    );
    expect(playerLines.map((output) => output.event.text)).toEqual(["第二次"]);
  });
});

// ---------------------------------------------------------------------------
// Input bridge semantics
// ---------------------------------------------------------------------------

describe("Input bridge semantics", () => {
  it("assigns stable line_ids to bridge events when the input interaction arrives", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "int_1",
          prompt: "说什么？",
          mode: "input",
          input: { kind: "free_text", placeholder: "...", max_length: 200 },
          input_bridge: {
            events: [
              { type: "narration", text: "风穿过走廊。" },
              { type: "narration", text: "她抬起了头。" },
            ],
          },
        },
      ]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // The bridge is consumed at confirm and played after the player's line:
    // player_dialogue → bridge ×2 → response. It never enters the formal log.
    const g = game as any;
    expect(g.bridgeBuffer.peek("int_1")).toBeNull();
    const played = controller.playbackEvents().map((output) => output.event);
    expect(played[0]!.text).toBe("开场。");
    expect(played[1]!.type).toBe("player_dialogue");
    expect(played.slice(2, 4).map((e) => e.text)).toEqual(["风穿过走廊。", "她抬起了头。"]);
    const bridgeIds = played.slice(2, 4).map((e) => e.line_id);
    expect(bridgeIds[0]).toMatch(/^line_.+_\d{6}$/);
    expect(bridgeIds[0]).not.toBe(bridgeIds[1]);
    // line_ids never repeat across the whole playback.
    const allIds = played.map((e) => e.line_id);
    expect(new Set(allIds).size).toBe(allIds.length);
    // Bridge narration never appears as a stored event.
    const storedTexts = (g.events as StoredEvent[]).map((e) =>
      (e as { text?: string }).text,
    );
    expect(storedTexts).not.toContain("风穿过走廊。");
    expect(storedTexts).not.toContain("她抬起了头。");
  });

  it("discards the bridge when a hybrid preset option is chosen", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "int_1",
          prompt: "怎么做？",
          mode: "hybrid",
          options: [
            { id: "a", text: "选项A" },
            { id: "b", text: "选项B" },
          ],
          input: { kind: "free_text", placeholder: "...", max_length: 200 },
          input_bridge: {
            events: [{ type: "narration", text: "她等着你的决定。" }],
          },
        },
      ]),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.select(output.interactionId, "a"),
    });

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect((game as any).bridgeBuffer.peek("int_1")).toBeNull();
  });

  it("keeps the bridge when hybrid free text is submitted", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "int_1",
          prompt: "怎么做？",
          mode: "hybrid",
          options: [
            { id: "a", text: "选项A" },
            { id: "b", text: "选项B" },
          ],
          input: { kind: "free_text", placeholder: "...", max_length: 200 },
          input_bridge: {
            events: [{ type: "narration", text: "她等着你的决定。" }],
          },
        },
      ]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.submitInput(output.interactionId, "随便说点什么"),
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // The bridge is consumed at confirm and played between the player's line
    // and the NPC response.
    expect((game as any).bridgeBuffer.peek("int_1")).toBeNull();
    const played = controller.playbackEvents().map((output) => output.event);
    expect(played[1]!.type).toBe("player_dialogue");
    expect(played[2]!.text).toBe("她等着你的决定。");
    expect(played[3]!.text).toBe("回应。");
  });
});

// ---------------------------------------------------------------------------
// Input response streaming (Phase E: stream → promote / cancel / repair)
// ---------------------------------------------------------------------------

/** Wire generateInputResponse to a manually controlled streaming provider. */
function makeManualInputResponse(
  generator: StoryGenerator,
  run: (
    signal: AbortSignal,
    onEvent: (draft: ModelEvent) => void,
  ) => Promise<GenerationEnvelope>,
): void {
  (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(
    async (_t, _s, _h, _interaction, _text, signal, options) => {
      return run(signal, (draft) => options?.onEvent?.(draft));
    },
  );
}

function inputInteractionFixture(bridgeText = "她等着你开口。") {
  return {
    type: "interaction" as const,
    interaction_id: "int_1",
    prompt: "说什么？",
    mode: "input" as const,
    input: { kind: "free_text" as const, placeholder: "...", max_length: 200 },
    input_bridge: {
      events: [{ type: "narration" as const, text: bridgeText }],
    },
  };
}

describe("Input response streaming", () => {
  it("stages streamed lines during preview without touching the formal state", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    let emitLine!: (draft: ModelEvent) => void;
    let completeResponse!: () => void;
    makeManualInputResponse(generator, async (_signal, onEvent) => {
      return new Promise((resolve) => {
        emitLine = onEvent;
        completeResponse = () => resolve(envelope([], {}));
      });
    });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const g = game as any;
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => {
        // Two lines arrive during the preview: they must stay staged.
        emitLine({ type: "narration", text: "第一行。" });
        emitLine({ type: "narration", text: "第二行。" });
        const storedTexts = (g.events as StoredEvent[]).map((e) =>
          (e as { text?: string }).text,
        );
        expect(storedTexts).not.toContain("第一行。");
        expect(g.buffered.size).toBe(0);
        completeResponse();
        controller.confirm(output.previewId);
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const played = controller.playbackEvents().map((output) => output.event);
    expect(played.map((e) => e.text)).toEqual([
      "开场。",
      "你好",
      "她等着你开口。",
      "第一行。",
      "第二行。",
      "结尾。",
    ]);
  });

  it("promotes a confirmed stream: late lines play without a second request", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    let emitLine!: (draft: ModelEvent) => void;
    let completeResponse!: () => void;
    makeManualInputResponse(generator, async (_signal, onEvent) => {
      return new Promise((resolve) => {
        emitLine = onEvent;
        completeResponse = () => resolve(envelope([], {}));
      });
    });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => {
        // One line is present at confirm; the second arrives only after the
        // committed prefix (player → bridge → first line) has been presented,
        // so the drain must wait for it: a genuine underrun.
        emitLine({ type: "narration", text: "第一行。" });
        controller.confirm(output.previewId);
      },
      onPlaybackReady: (event) => {
        if (event.type === "narration" && event.text === "第一行。") {
          setTimeout(() => {
            emitLine({ type: "narration", text: "第二行。" });
            completeResponse();
          }, 20);
        }
        controller.dispatch({ type: "advance" });
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // Confirm never issues a second LLM request.
    expect(generator.generateInputResponse).toHaveBeenCalledTimes(1);
    // The bridge ran out before the second line arrived: one underrun.
    expect(game.getMetrics().input.response_underrun_count).toBe(1);
    const played = controller.playbackEvents().map((output) => output.event);
    expect(played.map((e) => e.text)).toEqual([
      "开场。",
      "你好",
      "她等着你开口。",
      "第一行。",
      "第二行。",
      "结尾。",
    ]);
    // line_ids never repeat.
    const allIds = played.map((e) => e.line_id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("discards late stream events after cancel", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    let emitLine!: (draft: ModelEvent) => void;
    let completeResponse!: () => void;
    // First call: manually controlled pending stream. Second call: normal.
    (generator.generateInputResponse as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (_t, _s, _h, _i, _text, _signal, options) => {
        return new Promise((resolve) => {
          emitLine = (draft) => options?.onEvent?.(draft);
          completeResponse = () => resolve(envelope([], {}));
        });
      })
      .mockResolvedValueOnce(envelope([narrationEvent("回应。")]));
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    let previewIndex = 0;
    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.submitInput(output.interactionId, previewIndex === 0 ? "第一次" : "第二次"),
      onInputPreviewOpened: (output) => {
        if (previewIndex === 0) {
          controller.cancel(output.previewId);
          // The stale stream emits AFTER the cancel — must be dropped.
          emitLine({ type: "narration", text: "迟到事件。" });
          completeResponse();
        } else {
          controller.confirm(output.previewId);
        }
        previewIndex += 1;
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const played = controller.playbackEvents().map((output) => output.event);
    expect(played.map((e) => e.text)).not.toContain("迟到事件。");
    const storedTexts = ((game as any).events as StoredEvent[]).map((e) =>
      (e as { text?: string }).text,
    );
    expect(storedTexts).not.toContain("迟到事件。");
  });

  it("reuses the bridge across preview cancels", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    let previewIndex = 0;
    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.submitInput(output.interactionId, previewIndex === 0 ? "第一次" : "第二次"),
      onInputPreviewOpened: (output) => {
        if (previewIndex === 0) controller.cancel(output.previewId);
        else controller.confirm(output.previewId);
        previewIndex += 1;
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const played = controller.playbackEvents().map((output) => output.event);
    // The bridge plays exactly once, on the committed attempt, after the
    // player's line and before the response.
    const bridgePlays = played.filter((e) => e.text === "她等着你开口。");
    expect(bridgePlays).toHaveLength(1);
    expect(played[2]!.text).toBe("她等着你开口。");
    expect(played[3]!.text).toBe("回应。");
  });

  it("commits the state patch only after confirm and request completion", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    let resolveResponse!: (env: GenerationEnvelope) => void;
    makeManualInputResponse(generator, async () => {
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => {
        controller.confirm(output.previewId);
        // The patch only arrives AFTER the confirm.
        resolveResponse(
          envelope([narrationEvent("回应。")], { recent_summary: "玩家说了你好" }),
        );
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect((game as any).storyState.recent_summary).toBe("玩家说了你好");
  });

  it("does not commit the patch while the request finishes during preview", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    makeManualInputResponse(generator, async () =>
      envelope([narrationEvent("回应。")], { recent_summary: "未确认的摘要" }),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: async (output) => {
        // Let the request finish while the preview is still open.
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect((game as any).storyState.recent_summary).toBe("The story has just begun.");
        controller.confirm(output.previewId);
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // After confirm + completion the patch commits.
    expect((game as any).storyState.recent_summary).toBe("未确认的摘要");
  });

  it("keeps the arrived prefix when a confirmed stream fails", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    makeManualInputResponse(generator, async (_signal, onEvent) => {
      onEvent({ type: "narration", text: "半句回应。" });
      throw new Error("流中断");
    });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t, _s, _h, prefetchedEvents: StoryContextEvent[]) => {
        // The continuation repair receives the committed prefix: player line
        // + bridge + the arrived response line.
        expect(
          prefetchedEvents.some(
            (e) => (e as { text?: string }).text === "半句回应。",
          ),
        ).toBe(true);
        expect(
          prefetchedEvents.some(
            (e) =>
              e.type === "player_dialogue" &&
              (e as { text?: string }).text === "你好",
          ),
        ).toBe(true);
        expect(
          prefetchedEvents.some(
            (e) => (e as { text?: string }).text === "她等着你开口。",
          ),
        ).toBe(true);
        return envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]);
      },
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const played = controller.playbackEvents().map((output) => output.event);
    expect(played.map((e) => e.text)).toEqual([
      "开场。",
      "你好",
      "她等着你开口。",
      "半句回应。",
      "结尾。",
    ]);
  });

  it("retries once when the response stream fails without events", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        throw new Error("首轮失败");
      })
      .mockResolvedValueOnce(envelope([narrationEvent("修复回应。")]));
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(generator.generateInputResponse).toHaveBeenCalledTimes(2);
    const played = controller.playbackEvents().map((output) => output.event);
    expect(played.map((e) => e.text)).toEqual([
      "开场。",
      "你好",
      "她等着你开口。",
      "修复回应。",
      "结尾。",
    ]);
  });

  it("continues without a fake NPC response when the repair also fails", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new Error("总是失败");
      },
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // One original attempt + one repair; nothing fabricated is played.
    expect(generator.generateInputResponse).toHaveBeenCalledTimes(2);
    const played = controller.playbackEvents().map((output) => output.event);
    expect(played.map((e) => e.text)).toEqual([
      "开场。",
      "你好",
      "她等着你开口。",
      "结尾。",
    ]);
  });

  it("records cancel, stale-drop, promotion and timing metrics", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    let emitStale!: (draft: ModelEvent) => void;
    let completeStale!: () => void;
    let emitLive!: (draft: ModelEvent) => void;
    let completeLive!: () => void;
    (generator.generateInputResponse as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (_t, _s, _h, _i, _text, _signal, options) => {
        return new Promise((resolve) => {
          emitStale = (draft) => options?.onEvent?.(draft);
          completeStale = () => resolve(envelope([], {}));
        });
      })
      .mockImplementationOnce(async (_t, _s, _h, _i, _text, _signal, options) => {
        return new Promise((resolve) => {
          emitLive = (draft) => options?.onEvent?.(draft);
          completeLive = () => resolve(envelope([], {}));
        });
      });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    let previewIndex = 0;
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        if (previewIndex === 0) {
          controller.submitInput(output.interactionId, "第一次");
        } else {
          // The cancelled stream is fully torn down by now (the runtime
          // re-opened the interaction after the cancel); its late event must
          // be dropped as stale.
          emitStale({ type: "narration", text: "迟到。" });
          completeStale();
          controller.submitInput(output.interactionId, "第二次");
        }
      },
      onInputPreviewOpened: (output) => {
        if (previewIndex === 0) {
          controller.cancel(output.previewId);
        } else {
          controller.confirm(output.previewId);
          setTimeout(() => {
            emitLive({ type: "narration", text: "回应。" });
            completeLive();
          }, 5);
        }
        previewIndex += 1;
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const input = game.getMetrics().input;
    expect(input.response_canceled_count).toBe(1);
    expect(input.stale_input_event_dropped_count).toBe(1);
    expect(input.response_promoted_live_count).toBe(1);
    expect(input.confirm_to_first_response_line_ms).toHaveLength(1);
    expect(input.confirm_to_first_response_line_ms[0]).toBeGreaterThan(0);
    expect(input.bridge_cover_duration_ms).toHaveLength(1);
  });

  it("commits immediately when preview confirmation is disabled", async () => {
    const config = makeTestConfig({ input: { require_preview_confirmation: false } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // The preview is implicit: opened + committed without any confirm command.
    expect(controller.count("input_preview_opened")).toBe(1);
    expect(controller.count("input_committed")).toBe(1);
    const played = controller.playbackEvents().map((output) => output.event);
    expect(played.map((e) => e.text)).toEqual([
      "开场。",
      "你好",
      "她等着你开口。",
      "回应。",
      "结尾。",
    ]);
  });
});

// ---------------------------------------------------------------------------
// State patch rejection recording
// ---------------------------------------------------------------------------

describe("State patch rejection", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "galgame-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should record a state patch rejection when applyPatch throws", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();
    const metrics = new Metrics();

    const generator = makeMockGenerator();
    // Return an envelope where state_patch.open_threads is a number,
    // which will cause applyPatch to throw (not iterable)
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope(
        [narrationEvent("First."), endEvent("end_1", "The end.")],
        { open_threads: 123 as any },
      ),
    );

    const game = new Game(config, generator, status, media, metrics, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    new MemoryController().attach(game);
    await game.run();

    const snap = game.getMetrics();
    expect(snap.errors.state_patch_rejections).toBe(1);
  });

  it("should NOT record a rejection when the state patch is valid", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();
    const metrics = new Metrics();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope(
        [narrationEvent("First."), endEvent("end_1", "The end.")],
        {}, // valid empty patch
      ),
    );

    const game = new Game(config, generator, status, media, metrics, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    new MemoryController().attach(game);
    await game.run();

    const snap = game.getMetrics();
    expect(snap.errors.state_patch_rejections).toBe(0);
  });

  it("should continue running after a patch rejection (non-fatal)", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();
    const metrics = new Metrics();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope(
        [narrationEvent("First."), endEvent("end_1", "The end.")],
        { open_threads: 123 as any }, // bad patch
      ),
    );

    const game = new Game(config, generator, status, media, metrics, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    new MemoryController().attach(game);
    // Should not throw — patch rejection is non-fatal
    await expect(game.run()).resolves.toBeUndefined();

    expect(game.getMetrics().errors.state_patch_rejections).toBe(1);
    // Story state should remain the initial state since patch was rejected
    const state = (game as any).storyState;
    expect(state.scene.id).toBe("prologue");
  });
});

// ---------------------------------------------------------------------------
// Metrics reflection (pass-through to shared Metrics)
// ---------------------------------------------------------------------------

describe("Metrics pass-through", () => {
  let config: AppConfig;
  let generator: StoryGenerator;
  let status: RuntimeStatus;
  let media: MediaPlannerPort;

  beforeEach(() => {
    config = makeTestConfig();
    generator = makeMockGenerator();
    status = makeMockStatus();
    media = makeMockMedia();
  });

  it("getMetrics snapshot should reflect mutations on the shared Metrics", () => {
    const metrics = new Metrics();
    const game = new Game(config, generator, status, media, metrics, makeTestPorts());

    metrics.recordSchemaValidationFailure();
    metrics.recordSchemaValidationFailure();
    metrics.recordStatePatchRejection();

    const snap = game.getMetrics();
    expect(snap.errors.schema_validation_failures).toBe(2);
    expect(snap.errors.state_patch_rejections).toBe(1);
  });

  it("getMetrics returns a fresh snapshot each call", () => {
    const metrics = new Metrics();
    const game = new Game(config, generator, status, media, metrics, makeTestPorts());

    const snap1 = game.getMetrics();
    metrics.recordBranchRequested(3);
    const snap2 = game.getMetrics();

    expect(snap1.prefetch.branches_requested).toBe(0);
    expect(snap2.prefetch.branches_requested).toBe(3);
  });

  it("should keep independent Games with separate Metrics isolated", () => {
    const m1 = new Metrics();
    const m2 = new Metrics();
    const game1 = new Game(config, generator, status, media, m1, makeTestPorts());
    const game2 = new Game(config, generator, status, media, m2, makeTestPorts());

    m1.recordBranchRequested(1);
    m2.recordBranchRequested(9);

    expect(game1.getMetrics().prefetch.branches_requested).toBe(1);
    expect(game2.getMetrics().prefetch.branches_requested).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Hybrid interaction cancel loop / narration-only branch handoff
// ---------------------------------------------------------------------------

describe("Hybrid interaction commands", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "galgame-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("selects a preset option from a hybrid interaction via commands", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "int_1",
          prompt: "怎么做？",
          mode: "hybrid",
          options: [
            { id: "a", text: "选项A" },
            { id: "b", text: "选项B" },
          ],
          input: { kind: "free_text", placeholder: "...", max_length: 200 },
          input_bridge: {
            events: [{ type: "narration", text: "她等着你的决定。" }],
          },
        },
      ]),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    // The runtime opens the interaction once and waits for a command; a
    // client-side cancel loop (re-prompting) never touches the runtime.
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.select(output.interactionId, "a");
      },
    });

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // 开场 + 分支内容 + 结尾 = 3 段旁白；结局一次。
    expect(controller.count("interaction_opened")).toBe(1);
    expect(controller.countPlayback("narration")).toBe(3);
    expect(controller.ended()).toBe(true);
  });
});

describe("Narration-only branch handoff", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "galgame-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("hands a narration-only branch over to the continuation once playable lines reach the threshold", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    // The selected branch stays "generating" at selection time: it has
    // emitted one line; the second line arrives right after the choice.
    // Both options get their own emitter (each prefetch entry appends to
    // its own event list), keyed by option id.
    const emitters = new Map<string, () => void>();
    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([
        narrationEvent("开场。"),
        {
          type: "choice",
          prompt: "走哪边？",
          options: [
            { id: "a", text: "选项A" },
            { id: "b", text: "选项B" },
          ],
        },
      ]),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t, _s, _h, _choice, option, _signal, options) => {
        options!.onEvent!({ type: "narration", text: `分支${option.id}第一句。` });
        await new Promise<void>((resolve) => {
          emitters.set(option.id, () => {
            options!.onEvent!({ type: "narration", text: `分支${option.id}第二句。` });
            resolve();
          });
        });
        return [];
      },
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("续写。"), endEvent("end_1", "Fin.")]),
    );

    // Emit the second line right when the player picks an option: the live
    // selection observes it and hands off once playable lines hit the
    // threshold (branch_dialogue_lines = 2).
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        emitters.get("a")?.();
        controller.select(output.interactionId, "a");
      },
    });

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // 开场 + 分支两句 + 续写 = 4 段旁白;结局一次。
    expect(controller.countPlayback("narration")).toBe(4);
    expect(controller.ended()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Interaction policy enforcement (§8.5 / §13.1 / §13.2, Commit 4)
// ---------------------------------------------------------------------------

describe("Interaction policy enforcement", () => {
  /** Interaction config that forbids free-text input entirely. */
  function noInputConfig(): AppConfig {
    return makeTestConfig({
      interaction: {
        allowed_modes: ["choice", "hybrid"],
        default_mode: "choice",
        options: { min_count: 2, max_count: 5 },
        input: { max_length: 500, max_consecutive_pure_input: 1 },
        legacy_choice: { allow_runtime_compatibility: true, allow_model_output: false },
      },
    });
  }

  function inputInteraction(interactionId: string): InteractionEvent {
    return {
      type: "interaction",
      interaction_id: interactionId,
      prompt: "说什么？",
      mode: "input",
      input: { kind: "free_text", placeholder: "...", max_length: 200 },
      input_bridge: {
        events: [{ type: "narration", text: "她静静地看着你。" }],
      },
    };
  }

  function choiceInteraction(interactionId: string): InteractionEvent {
    return {
      type: "interaction",
      interaction_id: interactionId,
      prompt: "怎么选？",
      mode: "choice",
      options: [
        { id: "a", text: "选项A" },
        { id: "b", text: "选项B" },
      ],
    };
  }

  function hybridInteraction(interactionId: string): InteractionEvent {
    return {
      type: "interaction",
      interaction_id: interactionId,
      prompt: "怎么做？",
      mode: "hybrid",
      options: [
        { id: "a", text: "选项A" },
        { id: "b", text: "选项B" },
      ],
      input: { kind: "free_text", placeholder: "...", max_length: 200 },
      input_bridge: {
        events: [{ type: "narration", text: "她等着你的决定。" }],
      },
    };
  }

  function legacyChoiceEvent(): ChoiceEvent {
    return {
      type: "choice",
      prompt: "怎么选？",
      options: [
        { id: "a", text: "选项A" },
        { id: "b", text: "选项B" },
      ],
    };
  }

  it("rejects an illegal interaction mode before buffering and repairs with a legal terminal", async () => {
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    // Opening streams a narration, then an ILLEGAL input interaction.
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t, _s, _sig, options) => {
        options!.onEvent!({ type: "narration", text: "开场。" });
        options!.onEvent!(inputInteraction("int_illegal"));
        return envelope([]);
      },
    );
    // Repair continuation emits a LEGAL choice interaction; the post-choice
    // continuation ends the story.
    let repairReason: string | undefined;
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (_t, _s, _h, _p, _sig, options) => {
        // The Game-level repair passes the concrete policy reason so the
        // model sees WHY its previous output was rejected.
        repairReason = options?.repairReason;
        return envelope([narrationEvent("修复段。"), choiceInteraction("int_legal")]);
      })
      .mockImplementationOnce(async () =>
        envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
      );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );

    const diagnostics: Array<{ scope: string; message: string }> = [];
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.select(output.interactionId, "a");
      },
    });
    const game = new Game(
      noInputConfig(),
      generator,
      status,
      media,
      undefined,
      makeTestPorts({
        diagnostics: {
          info: (scope, message) => diagnostics.push({ scope, message }),
          warn: () => undefined,
        },
      }),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // The illegal interaction was never formally opened; only the repaired
    // (legal) terminal opened. Interaction-mode choices are emitted under
    // the runtime id `choice_${turn}`.
    const opened = controller.outputs.filter(
      (output): output is InteractionOpenedOutput =>
        output.type === "interaction_opened",
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]!.interactionId).toBe("choice_1");
    expect(
      opened.some(
        (output) =>
          "interaction_id" in output.interaction &&
          output.interaction.interaction_id === "int_illegal",
      ),
    ).toBe(false);

    // Its bridge was never materialized; the only branch prefetches come
    // from the legal terminal's BranchManager (one per option).
    expect((game as any).bridgeBuffer.peek("int_illegal")).toBeNull();
    // Exactly one BranchManager prefetch per option of the LEGAL terminal —
    // had the illegal terminal leaked into the branch flow, the count would
    // exceed the 2 options of the repaired choice.
    expect(generator.generateBranchPrefetch).toHaveBeenCalledTimes(2);

    // The repair loop ran and reported the concrete policy reason.
    expect(generator.generateContinuation).toHaveBeenCalledTimes(2);
    expect(
      diagnostics.some((d) => d.message.includes("InteractionPolicy 拒绝")),
    ).toBe(true);
    // The repair continuation carried the concrete policy reason to the
    // provider (embedded in the user prompt by the generator).
    expect(repairReason).toContain("InteractionPolicy 拒绝");

    // Only the new terminal is accepted; the story completes normally.
    expect(controller.ended()).toBe(true);
  });

  it("repairs an illegal terminal even when it is the first (only) event", async () => {
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    // The opening publishes ONLY the illegal interaction — no playable prefix.
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t, _s, _sig, options) => {
        options!.onEvent!(inputInteraction("int_illegal"));
        return envelope([]);
      },
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () =>
        envelope([narrationEvent("修复段。"), choiceInteraction("int_legal")]),
      )
      .mockImplementationOnce(async () =>
        envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
      );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.select(output.interactionId, "a");
      },
    });
    const game = new Game(
      noInputConfig(),
      generator,
      status,
      media,
      undefined,
      makeTestPorts(),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(controller.count("interaction_opened")).toBe(1);
    expect(generator.generateContinuation).toHaveBeenCalledTimes(2);
    expect(controller.ended()).toBe(true);
  });
  it("rejects a second consecutive pure input at the Game level", async () => {
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteraction("int_1")]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    // Continuation #1 tries to open ANOTHER pure input → 2 consecutive →
    // rejected. Repair #1 emits a choice (non-input), then the post-choice
    // continuation ends the story.
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () =>
        envelope([narrationEvent("续写。"), inputInteraction("int_2")]),
      )
      .mockImplementationOnce(async () =>
        envelope([narrationEvent("修复段。"), choiceInteraction("int_3")]),
      )
      .mockImplementationOnce(async () =>
        envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
      );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        if (output.interactionId === "int_1") {
          controller.submitInput("int_1", "你好");
        } else {
          controller.select(output.interactionId, "a");
        }
      },
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(
      makeTestConfig(),
      generator,
      status,
      media,
      undefined,
      makeTestPorts(),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // int_1 (input) and the repaired choice (emitted as `choice_2`) opened;
    // int_2 was rejected before it could open.
    const openedIds = controller.outputs
      .filter((output) => output.type === "interaction_opened")
      .map((output) => (output as InteractionOpenedOutput).interactionId);
    expect(openedIds).toEqual(["int_1", "choice_2"]);
  });

  it("accepts a pure input after a hybrid interaction (streak reset)", async () => {
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), hybridInteraction("int_1")]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    // The continuation opens a pure input AFTER a hybrid: the streak was
    // broken, so it must be accepted.
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () =>
        envelope([narrationEvent("续写。"), inputInteraction("int_2")]),
      )
      .mockImplementationOnce(async () =>
        envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
      );

    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.submitInput(output.interactionId, "随便说点什么");
      },
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(
      makeTestConfig(),
      generator,
      status,
      media,
      undefined,
      makeTestPorts(),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const openedIds = controller.outputs
      .filter((output) => output.type === "interaction_opened")
      .map((output) => (output as InteractionOpenedOutput).interactionId);
    expect(openedIds).toEqual(["int_1", "int_2"]);
    expect(controller.ended()).toBe(true);
  });

  it("creates no BranchManager for pure input terminals (§13.2)", () => {
    const generator = makeMockGenerator();
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );
    const game = new Game(
      makeTestConfig(),
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
    const g = game as any;

    expect(g.createBranchManagerForTerminal(inputInteraction("int_1"), 1, [])).toBeNull();
    expect(g.createBranchManagerForTerminal(hybridInteraction("int_2"), 1, [])).not.toBeNull();
    expect(g.createBranchManagerForTerminal(choiceInteraction("int_3"), 1, [])).not.toBeNull();
    expect(g.createBranchManagerForTerminal(legacyChoiceEvent(), 1, [])).not.toBeNull();
  });

  it("creates a BranchManager for legacy choice only when runtime compatibility is enabled", () => {
    const generator = makeMockGenerator();
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );
    const withCompat = new Game(
      makeTestConfig(),
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
    const withoutCompat = new Game(
      makeTestConfig({
        interaction: {
          allowed_modes: ["choice", "hybrid", "input"],
          default_mode: "choice",
          options: { min_count: 2, max_count: 5 },
          input: { max_length: 500, max_consecutive_pure_input: 1 },
          legacy_choice: { allow_runtime_compatibility: false, allow_model_output: false },
        },
      }),
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );

    expect((withCompat as any).createBranchManagerForTerminal(legacyChoiceEvent(), 1, [])).not.toBeNull();
    expect((withoutCompat as any).createBranchManagerForTerminal(legacyChoiceEvent(), 1, [])).toBeNull();
  });

  it("never prefetches branches during a pure input run", async () => {
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteraction("int_1")]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.submitInput(output.interactionId, "你好");
      },
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(
      makeTestConfig(),
      generator,
      status,
      media,
      undefined,
      makeTestPorts(),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(generator.generateBranchPrefetch).not.toHaveBeenCalled();
    expect(controller.ended()).toBe(true);
  });
  it("caps the recent interaction-mode history at 8, dropping the oldest (§8.4)", () => {
    const game = new Game(
      makeTestConfig(),
      makeMockGenerator(),
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
    const g = game as any;
    const pushed = [
      "input", "hybrid", "choice",
      "input", "hybrid", "choice",
      "input", "hybrid", "choice",
    ];
    for (const mode of pushed) g.recordInteractionMode(mode);
    // 9 pushes → cap 8: the oldest (first pushed) is dropped; the remaining
    // modes keep their order, newest last.
    expect(g.recentInteractionModes).toHaveLength(8);
    expect(g.recentInteractionModes).toEqual(pushed.slice(1));
  });
});

// ---------------------------------------------------------------------------
// Interaction resolution publication (§9.3)
// ---------------------------------------------------------------------------

describe("Interaction resolution publication", () => {
  it("emits interaction_resolved(choice) once a choice option exists, before adopting the branch", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([
        narrationEvent("开场。"),
        {
          type: "choice",
          prompt: "怎么选？",
          options: [
            { id: "a", text: "选项A" },
            { id: "b", text: "选项B" },
          ],
        },
      ]),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.select(output.interactionId, "a"),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const resolved = controller.outputs.filter(
      (output) => output.type === "interaction_resolved",
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual({
      type: "interaction_resolved",
      interactionId: "choice_1",
      resolution: "choice",
    });
    // Published between opening the form and playing the adopted branch.
    const order = controller.outputs.map((output) => output.type);
    expect(order.indexOf("interaction_opened")).toBeLessThan(
      order.indexOf("interaction_resolved"),
    );
    expect(order.indexOf("interaction_resolved")).toBeLessThan(
      order.lastIndexOf("playback_ready"),
    );
  });

  it("emits no interaction_resolved and errors on an unknown choice option", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([
        narrationEvent("开场。"),
        {
          type: "choice",
          prompt: "怎么选？",
          options: [
            { id: "a", text: "选项A" },
            { id: "b", text: "选项B" },
          ],
        },
      ]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.select(output.interactionId, "zzz"),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).rejects.toThrow(/未找到选项/);
    expect(
      controller.outputs.filter((output) => output.type === "interaction_resolved"),
    ).toHaveLength(0);
  });

  it("emits interaction_resolved(choice) for a hybrid preset option and discards the bridge", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "int_1",
          prompt: "怎么做？",
          mode: "hybrid",
          options: [
            { id: "a", text: "选项A" },
            { id: "b", text: "选项B" },
          ],
          input: { kind: "free_text", placeholder: "...", max_length: 200 },
          input_bridge: {
            events: [{ type: "narration", text: "她等着你的决定。" }],
          },
        },
      ]),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.select(output.interactionId, "a"),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(
      controller.outputs.filter((output) => output.type === "interaction_resolved"),
    ).toEqual([
      {
        type: "interaction_resolved",
        interactionId: "int_1",
        resolution: "choice",
      },
    ]);
    // The preset choice discards the bridge; its narration never plays.
    const played = controller.playbackEvents().map((output) => output.event.text);
    expect(played).not.toContain("她等着你的决定。");
  });

  it("emits interaction_resolved(input) on confirm, before input_committed", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();
    const order = controller.outputs.map((output) => output.type);
    expect(order.indexOf("input_preview_opened")).toBeLessThan(
      order.indexOf("interaction_resolved"),
    );
    expect(order.indexOf("interaction_resolved")).toBeLessThan(
      order.indexOf("input_committed"),
    );
  });

  it("emits no interaction_resolved on Esc; the interaction stays valid and can reopen", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    let previews = 0;
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => {
        previews += 1;
        // Esc on the first preview; the reopened interaction proceeds to
        // confirm on the second preview.
        if (previews === 1) controller.cancel(output.previewId);
        else controller.confirm(output.previewId);
      },
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // The first preview was cancelled (no resolved emitted), then the
    // reopened interaction was auto-confirmed by the default handler.
    expect(controller.count("input_preview_canceled")).toBe(1);
    expect(controller.count("interaction_opened")).toBe(2);
    expect(
      controller.outputs.filter((output) => output.type === "interaction_resolved"),
    ).toHaveLength(1);
  });

  it("auto-confirm: first Enter resolves the interaction when confirmation is disabled", async () => {
    const config = makeTestConfig({ input: { require_preview_confirmation: false } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const resolved = controller.outputs.filter(
      (output) => output.type === "interaction_resolved",
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual({
      type: "interaction_resolved",
      interactionId: "int_1",
      resolution: "input",
    });
    expect(controller.count("input_committed")).toBe(1);
  });
});
// ---------------------------------------------------------------------------
// Interaction command scoping (§10.2 / §14.5): stale & double-submit commands
// ---------------------------------------------------------------------------

function choiceFixture(
  options = [
    { id: "a", text: "选项A" },
    { id: "b", text: "选项B" },
  ],
) {
  return { type: "choice" as const, prompt: "怎么选？", options };
}

function hybridFixture(interactionId = "int_1", bridgeText = "她等着你的决定。") {
  return {
    type: "interaction" as const,
    interaction_id: interactionId,
    prompt: "怎么做？",
    mode: "hybrid" as const,
    options: [
      { id: "a", text: "选项A" },
      { id: "b", text: "选项B" },
    ],
    input: { kind: "free_text" as const, placeholder: "...", max_length: 200 },
    input_bridge: { events: [{ type: "narration" as const, text: bridgeText }] },
  };
}

/**
 * Test-only window into Game internals used by the scoping assertions.
 * Private fields are erased at runtime, so the shape is structural — the
 * unchecked cast documents exactly which internals the tests rely on.
 */
interface GameScopingInternals {
  events: StoredEvent[];
  deferredCommands: RuntimeCommand[];
  activeInteractionId: string | null;
  activePreviewId: string | null;
}

describe("Interaction command scoping (stale / double-submit)", () => {
  it("choice flow: resolves once, records player_choice once, cancels unselected branches, plays the selected branch", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockResolvedValue(
      envelope([narrationEvent("开场。"), choiceFixture()]),
    );
    vi.mocked(generator.generateBranchPrefetch).mockImplementation(
      async (_turn, _state, _context, _choice, option: { id: string }) =>
        envelope([narrationEvent(option.id === "a" ? "分支A。" : "分支B。")]),
    );
    vi.mocked(generator.generateContinuation).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.select(output.interactionId, "a"),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const g = game as unknown as GameScopingInternals;
    expect(
      controller.outputs.filter((o) => o.type === "interaction_resolved"),
    ).toEqual([{ type: "interaction_resolved", interactionId: "choice_1", resolution: "choice" }]);
    const playerChoices = g.events.filter((e) => e.type === "player_choice");
    expect(playerChoices).toHaveLength(1);
    expect(playerChoices[0]!).toMatchObject({ choice_id: "a" });
    // Only the selected branch plays; the unselected branch is canceled.
    const played = controller.playbackEvents().map((o) => o.event.text);
    expect(played).toContain("分支A。");
    expect(played).not.toContain("分支B。");
    // No stale interaction commands linger and the scope is fully released.
    expect(g.deferredCommands).toHaveLength(0);
    expect(g.activeInteractionId).toBeNull();
  });

  it("input flow: preview → response generation started → confirm → resolved(input) → committed → player line → bridge → NPC response", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    vi.mocked(generator.generateInputResponse).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    vi.mocked(generator.generateContinuation).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const g = game as unknown as GameScopingInternals;
    // The NPC response generation started exactly once (no second request).
    expect(generator.generateInputResponse).toHaveBeenCalledTimes(1);
    expect(
      controller.outputs.filter((o) => o.type === "interaction_resolved"),
    ).toEqual([{ type: "interaction_resolved", interactionId: "int_1", resolution: "input" }]);
    expect(controller.count("input_preview_opened")).toBe(1);
    expect(controller.count("input_committed")).toBe(1);
    const played = controller.playbackEvents().map((o) => o.event);
    // 开场。 → player line → bridge → NPC response.
    expect(played[1]!.type).toBe("player_dialogue");
    expect(played[2]!.text).toBe("她等着你开口。");
    expect(played[3]!.text).toBe("回应。");
    const playerInputs = g.events.filter((e) => e.type === "player_input");
    expect(playerInputs).toHaveLength(1);
    expect(playerInputs[0]!).toMatchObject({ text: "你好" });
    expect(g.deferredCommands).toHaveLength(0);
    expect(g.activeInteractionId).toBeNull();
    expect(g.activePreviewId).toBeNull();
  });

  it("race: select_choice then preview_input in the same tick — only the first wins, the second is dropped, deferredCommands stays empty", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockResolvedValue(
      envelope([narrationEvent("开场。"), hybridFixture()]),
    );
    vi.mocked(generator.generateBranchPrefetch).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );
    vi.mocked(generator.generateInputResponse).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    vi.mocked(generator.generateContinuation).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    // Both entrances submit in the same tick, the option click first.
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.select(output.interactionId, "a");
        controller.submitInput(output.interactionId, "竞态输入");
      },
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const g = game as unknown as GameScopingInternals;
    expect(
      controller.outputs.filter((o) => o.type === "interaction_resolved"),
    ).toEqual([{ type: "interaction_resolved", interactionId: "int_1", resolution: "choice" }]);
    const playerBehaviors = g.events.filter(
      (e) => e.type === "player_choice" || e.type === "player_input",
    );
    expect(playerBehaviors).toHaveLength(1);
    expect(playerBehaviors[0]!.type).toBe("player_choice");
    // The input path never runs: no response request, no bridge, no response.
    expect(generator.generateInputResponse).not.toHaveBeenCalled();
    const played = controller.playbackEvents().map((o) => o.event.text);
    expect(played).not.toContain("她等着你的决定。");
    expect(played).not.toContain("回应。");
    expect(g.deferredCommands).toHaveLength(0);
  });

  it("race: preview_input then select_choice in the same tick — only the first wins, the second is dropped, deferredCommands stays empty", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockResolvedValue(
      envelope([narrationEvent("开场。"), hybridFixture()]),
    );
    vi.mocked(generator.generateBranchPrefetch).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );
    vi.mocked(generator.generateInputResponse).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    vi.mocked(generator.generateContinuation).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    // Both entrances submit in the same tick, the input first.
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.submitInput(output.interactionId, "竞态输入");
        controller.select(output.interactionId, "a");
      },
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const g = game as unknown as GameScopingInternals;
    expect(
      controller.outputs.filter((o) => o.type === "interaction_resolved"),
    ).toEqual([{ type: "interaction_resolved", interactionId: "int_1", resolution: "input" }]);
    const playerBehaviors = g.events.filter(
      (e) => e.type === "player_choice" || e.type === "player_input",
    );
    expect(playerBehaviors).toHaveLength(1);
    expect(playerBehaviors[0]!.type).toBe("player_input");
    expect(controller.count("input_committed")).toBe(1);
    // The choice path never runs: no branch events play.
    const played = controller.playbackEvents().map((o) => o.event.text);
    expect(played).toContain("回应。");
    expect(played).not.toContain("分支内容。");
    expect(g.deferredCommands).toHaveLength(0);
  });

  it("repeated submit: the same option clicked twice records once, adopts one branch, starts no second continuation", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockResolvedValue(
      envelope([narrationEvent("开场。"), choiceFixture()]),
    );
    vi.mocked(generator.generateBranchPrefetch).mockImplementation(
      async (_turn, _state, _context, _choice, option: { id: string }) =>
        envelope([narrationEvent(option.id === "a" ? "分支A。" : "分支B。")]),
    );
    vi.mocked(generator.generateContinuation).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.select(output.interactionId, "a");
        controller.select(output.interactionId, "a");
      },
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const g = game as unknown as GameScopingInternals;
    const playerChoices = g.events.filter((e) => e.type === "player_choice");
    expect(playerChoices).toHaveLength(1);
    expect(
      controller.outputs.filter((o) => o.type === "interaction_resolved"),
    ).toHaveLength(1);
    const played = controller.playbackEvents().map((o) => o.event.text);
    expect(played).toContain("分支A。");
    expect(played).not.toContain("分支B。");
    // Exactly one continuation was started, not a second one.
    expect(generator.generateContinuation).toHaveBeenCalledTimes(1);
    expect(g.deferredCommands).toHaveLength(0);
  });

  it("stale preview: a late confirm for the cancelled preview is dropped; the new preview stays valid", async () => {
    const config = makeTestConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockResolvedValue(
      envelope([narrationEvent("开场。"), inputInteractionFixture()]),
    );
    vi.mocked(generator.generateInputResponse).mockResolvedValue(
      envelope([narrationEvent("回应。")]),
    );
    vi.mocked(generator.generateContinuation).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    let cancelledPreviewId: string | null = null;
    let committedPreviewId: string | null = null;
    let previewCount = 0;
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => {
        previewCount += 1;
        if (previewCount === 1) {
          cancelledPreviewId = output.previewId;
          controller.cancel(output.previewId);
        } else {
          committedPreviewId = output.previewId;
          // A late confirm for the cancelled preview A, then confirm B.
          controller.confirm(cancelledPreviewId!);
          controller.confirm(output.previewId);
        }
      },
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const g = game as unknown as GameScopingInternals;
    expect(controller.count("input_preview_opened")).toBe(2);
    expect(controller.count("input_preview_canceled")).toBe(1);
    // Only preview B was committed; the late confirm A was dropped.
    expect(controller.count("input_committed")).toBe(1);
    expect(
      controller.outputs.find((o) => o.type === "input_committed"),
    ).toMatchObject({ previewId: committedPreviewId });
    expect(
      controller.outputs.filter((o) => o.type === "interaction_resolved"),
    ).toEqual([{ type: "interaction_resolved", interactionId: "int_1", resolution: "input" }]);
    expect(g.deferredCommands).toHaveLength(0);
    expect(g.activePreviewId).toBeNull();
    expect(g.activeInteractionId).toBeNull();
  });
});
