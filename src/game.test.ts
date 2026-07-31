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
import { makeTestConfig } from "./test-helpers.js";
import type { StoryGenerator } from "./llm.js";
import type { MediaPrefetchScheduler } from "./media.js";
import type { GameUI } from "./ui.js";
import type { RuntimeStatus } from "./status.js";
import type { AppConfig } from "./config.js";
import type {
  ModelEvent,
  RuntimePlayableEvent,
  NarrationDraftEvent,
  EndEvent,
} from "./schema.js";
import type { GenerationEnvelope } from "./story/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockGenerator(): StoryGenerator {
  return {
    generateOpening: vi.fn(),
    generateBranchPrefetch: vi.fn(),
    generateInputResponse: vi.fn(),
    generateContinuation: vi.fn(),
    generateAutocomplete: vi.fn(),
  } as unknown as StoryGenerator;
}

function makeMockMedia(): MediaPrefetchScheduler {
  return {
    appendActive: vi.fn(),
    prefetchBranch: vi.fn(),
    activateBranch: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    markPresented: vi.fn(),
  } as unknown as MediaPrefetchScheduler;
}

function makeMockUI(): GameUI {
  return {
    printSession: vi.fn(),
    renderNarration: vi.fn().mockResolvedValue(undefined),
    renderDialogue: vi.fn().mockResolvedValue(undefined),
    renderEnd: vi.fn(),
    choose: vi.fn(),
    inputEditor: vi.fn(),
    inputPreview: vi.fn(),
    renderHybridInteraction: vi.fn(),
    waitForTask: vi.fn().mockImplementation((promise: Promise<unknown>) => promise),
  } as unknown as GameUI;
}

function makeMockStatus(): RuntimeStatus {
  return {
    setPhase: vi.fn(),
    setJob: vi.fn(),
    removeJob: vi.fn(),
    setBuffer: vi.fn(),
    setBranch: vi.fn(),
    clearBranches: vi.fn(),
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
  let ui: GameUI;
  let media: MediaPrefetchScheduler;

  beforeEach(() => {
    config = makeTestConfig();
    generator = makeMockGenerator();
    status = makeMockStatus();
    ui = makeMockUI();
    media = makeMockMedia();
  });

  it("should create a Game instance with all expected infrastructure", () => {
    const game = new Game(config, generator, status, ui, media);
    expect(game).toBeDefined();
    expect(game.getMetrics).toBeInstanceOf(Function);
    expect(game.getAutocompleteContext).toBeInstanceOf(Function);
  });

  it("should initialise with an empty events array", () => {
    const game = new Game(config, generator, status, ui, media);
    const ctx = game.getAutocompleteContext();
    expect(ctx.events).toEqual([]);
  });

  it("should initialise with the default StoryState", () => {
    const game = new Game(config, generator, status, ui, media);
    const ctx = game.getAutocompleteContext();
    expect(ctx.state).toEqual(createInitialState());
  });

  it("should auto-create a Metrics instance when none is provided", () => {
    const game = new Game(config, generator, status, ui, media);
    const snap = game.getMetrics();
    expect(snap).toBeDefined();
    expect(snap.llm.requests.opening).toBe(0);
  });

  it("should accept and use an external Metrics instance", () => {
    const metrics = new Metrics();
    metrics.recordBranchRequested(7);
    const game = new Game(config, generator, status, ui, media, metrics);
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
  let ui: GameUI;
  let media: MediaPrefetchScheduler;

  beforeEach(() => {
    config = makeTestConfig();
    generator = makeMockGenerator();
    status = makeMockStatus();
    ui = makeMockUI();
    media = makeMockMedia();
  });

  it("should produce a session ID with only safe filename characters", () => {
    // The createSessionId replaces : and . with -, so only alphanum, T, Z, and -
    const game = new Game(config, generator, status, ui, media);
    const sid = (game as any).sessionId as string;
    expect(sid).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  it("should not contain colons or dots", () => {
    const game = new Game(config, generator, status, ui, media);
    const sid = (game as any).sessionId as string;
    expect(sid).not.toContain(":");
    expect(sid).not.toContain(".");
  });

  it("should produce different IDs for different instances at different times", async () => {
    const game1 = new Game(config, generator, status, ui, media);
    await new Promise((r) => setTimeout(r, 2));
    const game2 = new Game(config, generator, status, ui, media);
    const sid1 = (game1 as any).sessionId as string;
    const sid2 = (game2 as any).sessionId as string;
    expect(sid1).not.toBe(sid2);
  });
});

// ---------------------------------------------------------------------------
// getAutocompleteContext
// ---------------------------------------------------------------------------

describe("getAutocompleteContext", () => {
  let config: AppConfig;
  let generator: StoryGenerator;
  let status: RuntimeStatus;
  let ui: GameUI;
  let media: MediaPrefetchScheduler;

  beforeEach(() => {
    config = makeTestConfig();
    generator = makeMockGenerator();
    status = makeMockStatus();
    ui = makeMockUI();
    media = makeMockMedia();
  });

  it("should return the current story state", () => {
    const game = new Game(config, generator, status, ui, media);
    const ctx = game.getAutocompleteContext();
    expect(ctx.state).toBeDefined();
    expect(ctx.state.scene.id).toBe("prologue");
  });

  it("should return a copy of the events array, not the internal reference", () => {
    const game = new Game(config, generator, status, ui, media);
    const ctx1 = game.getAutocompleteContext();
    const ctx2 = game.getAutocompleteContext();
    // They should be different array objects
    expect(ctx1.events).not.toBe(ctx2.events);
  });

  it("should reflect events after a player choice is recorded", () => {
    const game = new Game(config, generator, status, ui, media);
    const g = game as any;
    g.recordPlayerChoice({ id: "opt_1", text: "Go left" }, 1);

    const ctx = game.getAutocompleteContext();
    expect(ctx.events.length).toBe(1);
    expect(ctx.events[0]).toMatchObject({
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
      makeMockUI(),
      makeMockMedia(),
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
      makeMockUI(),
      makeMockMedia(),
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
      makeMockUI(),
      makeMockMedia(),
    );
  });

  it("should record a StoredPlayerChoiceEvent with correct structure", async () => {
    const g = game as any;
    await g.recordPlayerChoice({ id: "opt_1", text: "Go left" }, 3);

    const ctx = game.getAutocompleteContext();
    expect(ctx.events).toHaveLength(1);

    const event = ctx.events[0];
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
    const event = game.getAutocompleteContext().events[0] as any;
    const ts = event.timestamp as string;
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
      makeMockUI(),
      makeMockMedia(),
    );
  });

  it("should record a StoredPlayerInputEvent with correct structure", async () => {
    const g = game as any;
    await g.recordPlayerInput("int_42", "I open the door.", 2);

    const ctx = game.getAutocompleteContext();
    expect(ctx.events).toHaveLength(1);

    const event = ctx.events[0];
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

    const ctx = game.getAutocompleteContext();
    expect(ctx.events[0]).toMatchObject({
      type: "player_input",
      text: "",
    });
  });

  it("should handle long text", async () => {
    const g = game as any;
    const longText = "A".repeat(1000);
    await g.recordPlayerInput("int_1", longText, 1);

    const ctx = game.getAutocompleteContext();
    expect(ctx.events[0]).toMatchObject({
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
      makeMockUI(),
      makeMockMedia(),
    );
  });

  it("should start seq at 1 and increment monotonically across record calls", async () => {
    const g = game as any;

    // Initial seq should be 1 (private field)
    // Record two player choices, then a player input
    await g.recordPlayerChoice({ id: "a", text: "A" }, 1);
    await g.recordPlayerInput("int_1", "text", 1);
    await g.recordPlayerChoice({ id: "b", text: "B" }, 2);

    const events = game.getAutocompleteContext().events;
    const seqs = events.map((e: any) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("should assign seq independently of turn number", async () => {
    const g = game as any;
    await g.recordPlayerChoice({ id: "a", text: "A" }, 10);
    await g.recordPlayerChoice({ id: "b", text: "B" }, 5);

    const events = game.getAutocompleteContext().events;
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

    const events = game.getAutocompleteContext().events;
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
      makeMockUI(),
      makeMockMedia(),
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
    const ui = makeMockUI();
    const media = makeMockMedia();

    // Mock the generator to throw after init so run() doesn't loop forever
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("stop"),
    );

    const game = new Game(config, generator, status, ui, media);

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
    const ui = makeMockUI();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    // Return a minimal [narration, end] segment so run() completes
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("It begins."), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, ui, media);
    await game.run();

    // Verify the jsonl file exists and has content
    const { readFile } = await import("node:fs/promises");
    const store = (game as any).store;
    const content = await readFile(store.filePath, "utf8");
    expect(content).toContain('"type":"narration"');
    expect(content).toContain('"type":"end"');
  });

  it("preserves generated events and repairs the segment when the opening stream fails", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const ui = makeMockUI();
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

    const game = new Game(config, generator, status, ui, media);
    await expect(game.run()).resolves.toBeUndefined();

    expect(openingCalls).toBe(1);
    // 第一句旁白 + 修复段旁白；第二句对话；结局一次。
    expect(ui.renderNarration).toHaveBeenCalledTimes(2);
    expect(ui.renderDialogue).toHaveBeenCalledTimes(1);
    expect(ui.renderEnd).toHaveBeenCalledTimes(1);
  });

  it("throws when segment repairs are exhausted", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const ui = makeMockUI();
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

    const game = new Game(config, generator, status, ui, media);
    await expect(game.run()).rejects.toThrow(/剧情段连续失败/);
  });

  it("routes a repaired segment's choice into the normal branch flow", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const ui = makeMockUI();
    const media = makeMockMedia();
    (ui.choose as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "a", text: "选项A" });

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

    const game = new Game(config, generator, status, ui, media);
    await expect(game.run()).resolves.toBeUndefined();

    // 开场半句 + 修复段 + 分支 + 续写结尾 = 4 段旁白；结局 1 次。
    expect(ui.renderNarration).toHaveBeenCalledTimes(4);
    expect(ui.renderEnd).toHaveBeenCalledTimes(1);
    expect(ui.choose).toHaveBeenCalledTimes(1);
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
    const ui = makeMockUI();
    const media = makeMockMedia();

    // Editor: first confirm "你好", then (after preview cancel) "你好吗".
    const editor = ui.inputEditor as ReturnType<typeof vi.fn>;
    editor
      .mockResolvedValueOnce({ action: "confirm", text: "你好" })
      .mockResolvedValueOnce({ action: "confirm", text: "你好吗" });
    const preview = ui.inputPreview as ReturnType<typeof vi.fn>;
    preview
      .mockResolvedValueOnce({ action: "cancel" })
      .mockResolvedValueOnce({ action: "confirm" });

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

    const game = new Game(config, generator, status, ui, media);
    await expect(game.run()).resolves.toBeUndefined();

    // At this point only the committed response (and opening/continuation)
    // have rendered: 开场 + 回应 + 结尾 = 3.
    expect(ui.renderNarration).toHaveBeenCalledTimes(3);
    expect(ui.inputEditor).toHaveBeenCalledTimes(2);
    expect(ui.inputPreview).toHaveBeenCalledTimes(2);
    expect(generateInputResponse).toHaveBeenCalledTimes(2);

    // Now the stale response finally arrives — it must be discarded.
    resolveStale(envelope([narrationEvent("过期回应。")]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ui.renderNarration).toHaveBeenCalledTimes(3);
    expect(game.getMetrics().input.preview_count).toBe(2);
  });

  it("leaves no buffered/media residue when a completed response is cancelled", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const ui = makeMockUI();
    const media = makeMockMedia();

    const editor = ui.inputEditor as ReturnType<typeof vi.fn>;
    editor
      .mockResolvedValueOnce({ action: "confirm", text: "第一次" })
      .mockResolvedValueOnce({ action: "confirm", text: "第二次" });
    const preview = ui.inputPreview as ReturnType<typeof vi.fn>;
    preview
      .mockResolvedValueOnce({ action: "cancel" })
      .mockResolvedValueOnce({ action: "confirm" });

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

    const game = new Game(config, generator, status, ui, media);
    await expect(game.run()).resolves.toBeUndefined();

    // Only the second (committed) response may reach the media timeline;
    // the cancelled first response must never appear.
    const appendActive = media.appendActive as ReturnType<typeof vi.fn>;
    const appendedTexts = appendActive.mock.calls.flatMap((call) =>
      (call[0] as RuntimePlayableEvent[]).map((e) => e.text),
    );
    expect(appendedTexts).not.toContain("已完成的回应。");
    expect(appendedTexts).toContain("第二次回应。");

    const buffered = (game as any).buffered as Map<string, RuntimePlayableEvent>;
    // Every rendered line is consumed and removed; the cancelled response
    // must leave no residue behind.
    expect([...buffered.values()]).toEqual([]);
    // 开场 + 第二次回应 + 结尾 = 3 段旁白；第一次的回应从未渲染。
    expect(ui.renderNarration).toHaveBeenCalledTimes(3);
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
    const ui = makeMockUI();
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

    const game = new Game(config, generator, status, ui, media, metrics);
    await game.run();

    const snap = game.getMetrics();
    expect(snap.errors.state_patch_rejections).toBe(1);
  });

  it("should NOT record a rejection when the state patch is valid", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const ui = makeMockUI();
    const media = makeMockMedia();
    const metrics = new Metrics();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope(
        [narrationEvent("First."), endEvent("end_1", "The end.")],
        {}, // valid empty patch
      ),
    );

    const game = new Game(config, generator, status, ui, media, metrics);
    await game.run();

    const snap = game.getMetrics();
    expect(snap.errors.state_patch_rejections).toBe(0);
  });

  it("should continue running after a patch rejection (non-fatal)", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const ui = makeMockUI();
    const media = makeMockMedia();
    const metrics = new Metrics();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope(
        [narrationEvent("First."), endEvent("end_1", "The end.")],
        { open_threads: 123 as any }, // bad patch
      ),
    );

    const game = new Game(config, generator, status, ui, media, metrics);
    // Should not throw — patch rejection is non-fatal
    await expect(game.run()).resolves.toBeUndefined();

    expect(game.getMetrics().errors.state_patch_rejections).toBe(1);
    // Story state should remain the initial state since patch was rejected
    const ctx = game.getAutocompleteContext();
    expect(ctx.state.scene.id).toBe("prologue");
  });
});

// ---------------------------------------------------------------------------
// Metrics reflection (pass-through to shared Metrics)
// ---------------------------------------------------------------------------

describe("Metrics pass-through", () => {
  let config: AppConfig;
  let generator: StoryGenerator;
  let status: RuntimeStatus;
  let ui: GameUI;
  let media: MediaPrefetchScheduler;

  beforeEach(() => {
    config = makeTestConfig();
    generator = makeMockGenerator();
    status = makeMockStatus();
    ui = makeMockUI();
    media = makeMockMedia();
  });

  it("getMetrics snapshot should reflect mutations on the shared Metrics", () => {
    const metrics = new Metrics();
    const game = new Game(config, generator, status, ui, media, metrics);

    metrics.recordSchemaValidationFailure();
    metrics.recordSchemaValidationFailure();
    metrics.recordStatePatchRejection();

    const snap = game.getMetrics();
    expect(snap.errors.schema_validation_failures).toBe(2);
    expect(snap.errors.state_patch_rejections).toBe(1);
  });

  it("getMetrics returns a fresh snapshot each call", () => {
    const metrics = new Metrics();
    const game = new Game(config, generator, status, ui, media, metrics);

    const snap1 = game.getMetrics();
    metrics.recordBranchRequested(3);
    const snap2 = game.getMetrics();

    expect(snap1.prefetch.branches_requested).toBe(0);
    expect(snap2.prefetch.branches_requested).toBe(3);
  });

  it("should keep independent Games with separate Metrics isolated", () => {
    const m1 = new Metrics();
    const m2 = new Metrics();
    const game1 = new Game(config, generator, status, ui, media, m1);
    const game2 = new Game(config, generator, status, ui, media, m2);

    m1.recordBranchRequested(1);
    m2.recordBranchRequested(9);

    expect(game1.getMetrics().prefetch.branches_requested).toBe(1);
    expect(game2.getMetrics().prefetch.branches_requested).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Hybrid interaction cancel loop / narration-only branch handoff
// ---------------------------------------------------------------------------

describe("Hybrid cancel loop", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "galgame-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("re-enters the same interaction on cancel instead of recursing", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeTestConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const ui = makeMockUI();
    const media = makeMockMedia();

    const renderHybrid = ui.renderHybridInteraction as ReturnType<typeof vi.fn>;
    renderHybrid
      .mockResolvedValueOnce({ type: "cancel" })
      .mockResolvedValueOnce({ type: "choice", optionId: "a" });

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
        },
      ]),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("分支内容。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope([narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, ui, media);
    await expect(game.run()).resolves.toBeUndefined();

    // cancel → re-render → choice: two render calls, one branch flow.
    // (hybrid choices are picked inside renderHybridInteraction; ui.choose
    // is only used by plain choice events.)
    expect(renderHybrid).toHaveBeenCalledTimes(2);
    expect(ui.renderEnd).toHaveBeenCalledTimes(1);
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
    const ui = makeMockUI();
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
    (ui.choose as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      emitters.get("a")?.();
      return { id: "a", text: "选项A" };
    });

    const game = new Game(config, generator, status, ui, media);
    await expect(game.run()).resolves.toBeUndefined();

    // 开场 + 分支两句 + 续写 = 4 段旁白;结局一次。
    expect(ui.renderNarration).toHaveBeenCalledTimes(4);
    expect(ui.renderEnd).toHaveBeenCalledTimes(1);
  });
});
