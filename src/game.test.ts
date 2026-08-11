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
import type { StoryGeneratorPort } from "./core/ports/story-generator-port.js";
import { createGenerationHandle } from "./core/ports/story-generator-port.js";
import type {
  GenerationHandle,
  OpeningRequest,
  ContinuationRequest,
  BranchPrefetchRequest,
  InputResponseRequest,
} from "./core/ports/story-generator-port.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import type { RuntimeStatus } from "./status.js";
import type { AppConfig } from "./config.js";
import type {
  RuntimePlayableEvent,
  NarrationDraftEvent,
  EndEvent,
  StoredEvent,
  StoryContextEvent,
  InteractionEvent,
} from "./schema.js";
import type { RuntimeCommand } from "./core/runtime/runtime-command.js";
import type { GenerationEnvelope } from "./story/types.js";
import type { EventGroupDraft } from "./core/protocol/gal-dsl/types.js";
import type { RuntimeOutput } from "./core/runtime/runtime-output.js";
import type { InteractionOpenedOutput } from "./test-helpers.js";
import type { NarrativeDirectorPort } from "./core/ports/narrative-director-port.js";
import type {
  NarrativeBrief,
  NarrativeBriefRequest,
} from "./core/narrative/narrative-brief.js";
import type { GamePorts } from "./game.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Game core tests exercise repair / policy / command-scoping contracts; the
 * §73–§76 low-water scheduler is out of scope here, so it is disabled via
 * config: start_threshold 1 → no first-line hold; refill_threshold -1 →
 * the invariant `ahead > threshold` always holds, so no refill ever starts.
 * game-dsl.test.ts covers the scheduler with real thresholds.
 */
function makeGameConfig(overrides?: Parameters<typeof makeTestConfig>[0]): AppConfig {
  return makeTestConfig({
    text_buffer: { start_threshold_lines: 1, target_lines: 6, refill_threshold_lines: -1 },
    ...overrides,
  });
}

function makeMockGenerator(): StoryGeneratorPort {
  return {
    generateOpening: vi.fn(),
    // Default: an empty branch (candidates resolve with no events). Hybrid
    // free-text tests never set this; the prefetch group still starts.
    generateBranchPrefetch: vi.fn(() =>
      createGenerationHandle("branch", async () => ({ events: [], state_patch: {}, groups: [] })),
    ),
    generateInputResponse: vi.fn(),
    generateContinuation: vi.fn(),
    // Default bridge: one narration line (docs §34). Tests that expect a
    // different bridge text override this per-test.
    generateInputBridge: vi.fn(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    ),
  } as unknown as StoryGeneratorPort;
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

type EnvelopeDraft =
  | { type: "narration"; text: string }
  | { type: "dialogue"; speaker: string; text: string }
  | { type: "choice"; prompt: string; options: Array<{ id: string; text: string }> }
  | InteractionEvent
  | EndEvent;

/** Convert one draft event into a DSL EventGroupDraft (end → sentinel). */
function groupFromEvent(draft: EnvelopeDraft): EventGroupDraft {
  if (draft.type === "narration") {
    return { prelude: [], main: { type: "narration", text: draft.text } };
  }
  if (draft.type === "dialogue") {
    return {
      prelude: [],
      main: {
        type: "dialogue",
        speaker: draft.speaker,
        text: draft.text,
        visual: { hasVisual: false, resetVisual: false },
        name: { hasName: false, resetName: false },
      },
    };
  }
  if (draft.type === "choice") {
    return {
      prelude: [],
      main: {
        type: "interaction",
        interaction: {
          prompt: draft.prompt,
          mode: "choice",
          optionTexts: draft.options.map((o) => o.text),
        },
      },
    };
  }
  if (draft.type !== "interaction") {
    throw new Error("end 事件不是组：请用段结束哨兵表达结局。");
  }
  const interaction: InteractionEvent = draft;
  const draftInteraction: {
    prompt: string;
    mode: InteractionEvent["mode"];
    optionTexts: string[];
    inputPlaceholder?: string;
  } = {
    prompt: interaction.prompt,
    mode: interaction.mode,
    optionTexts:
      interaction.mode === "input"
        ? []
        : interaction.options.map((o) => o.text),
  };
  if (interaction.mode !== "choice") {
    draftInteraction.inputPlaceholder = interaction.input.placeholder;
  }
  return {
    prelude: [],
    main: { type: "interaction", interaction: draftInteraction },
  };
}

/**
 * Build a minimal GenerationEnvelope for the mock generator. DSL protocol:
 * the envelope carries committed groups plus the segment-end status; draft
 * events are converted into DSL groups, a trailing `end` event maps to the
 * `@end ... ending` sentinel.
 */
function envelope(
  drafts: EnvelopeDraft[],
  state_patch: GenerationEnvelope["state_patch"] = {},
): GenerationEnvelope {
  let reason: "buffer" | "interaction" | "ending" = "buffer";
  const groups: EventGroupDraft[] = [];
  for (const draft of drafts) {
    if (draft.type === "end") {
      reason = "ending";
      continue;
    }
    if (draft.type === "interaction") reason = "interaction";
    groups.push(groupFromEvent(draft));
  }
  return {
    events: [],
    state_patch,
    groups,
    segmentEnd: { kind: "complete", nonce: "0000", reason },
  };
}

/**
 * Port-shaped mock handle: the drafts stream through `onGroup` (so they
 * arrive on `handle.events` exactly like the real generator's DSL stream)
 * and the envelope carries the segment-end status. `end` drafts map to the
 * `@end ... ending` sentinel in the envelope, never to a group.
 */
function handleFromDrafts(
  id: string,
  drafts: EnvelopeDraft[],
  state_patch: GenerationEnvelope["state_patch"] = {},
): GenerationHandle {
  return createGenerationHandle(id, async (_signal, onGroup) => {
    for (const draft of drafts) {
      if (draft.type === "end") continue;
      onGroup(groupFromEvent(draft));
    }
    return envelope(drafts, state_patch);
  });
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
  let generator: StoryGeneratorPort;
  let status: RuntimeStatus;
  let media: MediaPlannerPort;

  beforeEach(() => {
    config = makeGameConfig();
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
  let generator: StoryGeneratorPort;
  let status: RuntimeStatus;
  let media: MediaPlannerPort;

  beforeEach(() => {
    config = makeGameConfig();
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
  let generator: StoryGeneratorPort;
  let status: RuntimeStatus;
  let media: MediaPlannerPort;

  beforeEach(() => {
    config = makeGameConfig();
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
// Line ID uniqueness and format
// ---------------------------------------------------------------------------

describe("Line ID generation", () => {
  let game: Game;

  beforeEach(() => {
    game = new Game(
      makeGameConfig(),
      makeMockGenerator(),
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
  });

  it("should produce monotonically incrementing line_id suffixes", () => {
    const g = game as any;

    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const lineId = g.nextLineId() as string;
      expect(lineId).toBeDefined();
      ids.push(lineId);
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
    const lineId = g.nextLineId() as string;
    expect(lineId).toContain(sid);
  });
});

// ---------------------------------------------------------------------------
// Player choice recording (recordPlayerChoice)
// ---------------------------------------------------------------------------

describe("recordPlayerChoice", () => {
  let game: Game;
  let gen: StoryGeneratorPort;

  beforeEach(() => {
    gen = makeMockGenerator();
    game = new Game(
      makeGameConfig(),
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
      makeGameConfig(),
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
    await g.recordPlayerInput("interaction_1", "", 1);

    const events = g.events;
    expect(events[0]).toMatchObject({
      type: "player_input",
      text: "",
    });
  });

  it("should handle long text", async () => {
    const g = game as any;
    const longText = "A".repeat(1000);
    await g.recordPlayerInput("interaction_1", longText, 1);

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
      makeGameConfig(),
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
    await g.recordPlayerInput("interaction_1", "text", 1);
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
      makeGameConfig(),
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
    const config = makeGameConfig({ game: { sessions_dir: sessionsDir } });
    const generator = makeMockGenerator();
    const status = makeMockStatus();
    const media = makeMockMedia();

    // Mock the generator to throw after init so run() doesn't loop forever
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        createGenerationHandle("opening", async () => {
          throw new Error("stop");
        }),
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
    const config = makeGameConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    // Return a minimal [narration, end] segment so run() completes
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("It begins."), endEvent("end_1", "Fin.")]),
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
    const config = makeGameConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    let openingCalls = 0;
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) => {
        openingCalls += 1;
        if (openingCalls === 1) {
          // Stream two events, then fail mid-stream before any terminal event.
          return createGenerationHandle("opening", async (_signal, onGroup) => {
            onGroup(groupFromEvent({ type: "narration", text: "第一句。" }));
            onGroup(groupFromEvent({ type: "dialogue", speaker: "小樱", text: "第二句。" }));
            throw new Error("网络中断");
          });
        }
        throw new Error("unexpected second opening call");
      },
    );
    // The repair path must use a continuation request seeded with the
    // preserved prefix.
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) => {
        expect(request.prefetchedEvents).toHaveLength(2);
        expect(request.history).toContainEqual(
          expect.objectContaining({ type: "dialogue", speaker: "小樱" }),
        );
        return handleFromDrafts("continuation", [narrationEvent("修复后的开场。"), endEvent("end_1", "Fin.")]);
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

  it("keeps repairing after the budget is exhausted (no fatal on truncated tail)", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeGameConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    // The opening fails after publishing one event; the repair budget is 1.
    // Repairs #1 and #2 also fail after publishing a line each (budget
    // exhausted along the way) — the run must NOT terminate: it keeps
    // continuing along the last successful line until repair #3 succeeds.
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        createGenerationHandle("opening", async (_signal, onGroup) => {
          onGroup(groupFromEvent({ type: "narration", text: "半句。" }));
          throw new Error("open 失败");
        }),
    );
    let repairs = 0;
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) => {
        repairs += 1;
        // Failures publish a line via onEvent then throw (like a truncated
        // stream); the successful repair returns a full envelope instead.
        if (repairs < 3) {
          return createGenerationHandle("continuation", async (_signal, onGroup) => {
            onGroup(groupFromEvent({ type: "narration", text: `修复段半句${repairs}。` }));
            throw new Error("修复失败");
          });
        }
        return handleFromDrafts("continuation", [
          narrationEvent(`修复段收尾${repairs}。`),
          endEvent("end_1", "Fin."),
        ]);
      },
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    const controller = new MemoryController();
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // Two failed repairs were consumed beyond the budget, then the third
    // succeeded and the game reached its ending instead of crashing.
    expect(repairs).toBe(3);
    expect(controller.ended()).toBe(true);
  });

  it("routes a repaired segment's choice into the normal branch flow", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeGameConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    let openingCalls = 0;
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) => {
        openingCalls += 1;
        if (openingCalls === 1) {
          return createGenerationHandle("opening", async (_signal, onGroup) => {
            onGroup(groupFromEvent({ type: "narration", text: "开场半句。" }));
            throw new Error("网络中断");
          });
        }
        throw new Error("unexpected second opening call");
      },
    );
    // Repair continuation ends in a choice; the branch flow must take over.
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() =>
        handleFromDrafts("continuation", [
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
      .mockImplementationOnce(() =>
        handleFromDrafts("continuation", [narrationEvent("续写结尾。"), endEvent("end_1", "Fin.")]),
      );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[0]!;
        controller.select(output.interactionId, first.id);
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
    const config = makeGameConfig({ game: { sessions_dir: sessionsDir } });
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
        const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[0]!;
        controller.select(output.interactionId, first.id);
      },
    });

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
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
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );
    // Continuation #1: publish one line, then fail mid-stream while the
    // run loop is still presenting the selected branch's preview.
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() =>
        createGenerationHandle("continuation", async (_signal, onGroup) => {
          onGroup(groupFromEvent({ type: "narration", text: "续写半句。" }));
          throw new Error("续写网络中断");
        }),
      )
      // Repair continuation completes the story.
      .mockImplementationOnce(() =>
        handleFromDrafts("continuation", [narrationEvent("修复续写。"), endEvent("end_1", "Fin.")]),
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
    const config = makeGameConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "interaction_1",
          prompt: "说什么？",
          mode: "input",
          input: { kind: "free_text", placeholder: "...", max_length: 200 },
        },
      ]),
    );

    // First (stale) response: a pending handle resolved only after run()
    // completes. Second response: resolves normally.
    let resolveStale!: (value: unknown) => void;
    const staleDone = new Promise<GenerationEnvelope>((resolve) => {
      resolveStale = (value: unknown) => resolve(value as GenerationEnvelope);
    });
    const generateInputResponse = generator.generateInputResponse as ReturnType<typeof vi.fn>;
    generateInputResponse
      .mockImplementationOnce(() =>
        createGenerationHandle("input", async () => staleDone),
      )
      .mockImplementationOnce(() =>
        handleFromDrafts("input", [narrationEvent("回应。")]),
      );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
    const config = makeGameConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "interaction_1",
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
      .mockImplementationOnce(() =>
        handleFromDrafts("input", [narrationEvent("已完成的回应。")]),
      )
      .mockImplementationOnce(() =>
        handleFromDrafts("input", [narrationEvent("第二次回应。")]),
      );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "interaction_1",
          prompt: "说什么？",
          mode: "input",
          input: { kind: "free_text", placeholder: "...", max_length: 200 },
        },
      ]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [
        narrationEvent("风穿过走廊。"),
        narrationEvent("她抬起了头。"),
      ]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
    expect(g.bridgeBuffer.peek("interaction_1")).toBeNull();
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "interaction_1",
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
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.select(
          output.interactionId,
          (output.interaction as { options?: Array<{ id: string }> }).options![0]!.id,
        ),
    });

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect((game as any).bridgeBuffer.peek("interaction_1")).toBeNull();
  });

  it("keeps the bridge when hybrid free text is submitted", async () => {
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "interaction_1",
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
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你的决定。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
    expect((game as any).bridgeBuffer.peek("interaction_1")).toBeNull();
    const played = controller.playbackEvents().map((output) => output.event);
    expect(played[1]!.type).toBe("player_dialogue");
    expect(played[2]!.text).toBe("她等着你的决定。");
    expect(played[3]!.text).toBe("回应。");
  });

  it("hybrid free text discards the prefetched option candidates; bridge and NPC response play", async () => {
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "interaction_1",
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
    // Both option candidates are prefetched and become ready…
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("候选分支内容。")]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你的决定。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.submitInput(output.interactionId, "随便说点什么"),
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // The candidates were prefetched (one per option) but the input path
    // discards them: their content never plays, the resolution is "input",
    // and the input response generation runs exactly once.
    expect(generator.generateBranchPrefetch).toHaveBeenCalledTimes(2);
    expect(game.getMetrics().prefetch.branches_requested).toBe(2);
    expect(generator.generateInputResponse).toHaveBeenCalledTimes(1);
    expect(
      controller.outputs.filter(
        (o): o is Extract<RuntimeOutput, { type: "interaction_resolved" }> =>
          o.type === "interaction_resolved",
      ),
    ).toEqual([{ type: "interaction_resolved", interactionId: "interaction_1", resolution: "input" }]);
    const played = controller.playbackEvents().map((output) => output.event);
    const texts = played.map((e) => e.text);
    expect(texts).not.toContain("候选分支内容。");
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
  generator: StoryGeneratorPort,
  run: (
    signal: AbortSignal,
    onGroup: (draft: EventGroupDraft) => void,
  ) => Promise<GenerationEnvelope>,
): void {
  (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(
    (request: InputResponseRequest) =>
      createGenerationHandle("input", (signal, onGroup) => run(signal, onGroup)),
  );
}

function inputInteractionFixture() {
  return {
    type: "interaction" as const,
    interaction_id: "interaction_1",
    prompt: "说什么？",
    mode: "input" as const,
    input: { kind: "free_text" as const, placeholder: "...", max_length: 200 },
  };
}

describe("Input response streaming", () => {
  it("stages streamed lines during preview without touching the formal state", async () => {
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    let emitGroup!: (draft: EventGroupDraft) => void;
    let completeResponse!: () => void;
    makeManualInputResponse(generator, async (_signal, onGroup) => {
      return new Promise((resolve) => {
        emitGroup = onGroup;
        completeResponse = () => resolve(envelope([], {}));
      });
    });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const g = game as any;
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => {
        // Two lines arrive during the preview: they must stay staged.
        emitGroup(groupFromEvent({ type: "narration", text: "第一行。" }));
        emitGroup(groupFromEvent({ type: "narration", text: "第二行。" }));
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    let emitGroup!: (draft: EventGroupDraft) => void;
    let completeResponse!: () => void;
    makeManualInputResponse(generator, async (_signal, onGroup) => {
      return new Promise((resolve) => {
        emitGroup = onGroup;
        completeResponse = () => resolve(envelope([], {}));
      });
    });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => {
        // One line is present at confirm; the second arrives only after the
        // committed prefix (player → bridge → first line) has been presented,
        // so the drain must wait for it: a genuine underrun.
        emitGroup(groupFromEvent({ type: "narration", text: "第一行。" }));
        controller.confirm(output.previewId);
      },
      onPlaybackReady: (event) => {
        if (event.type === "narration" && event.text === "第一行。") {
          setTimeout(() => {
            emitGroup(groupFromEvent({ type: "narration", text: "第二行。" }));
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    let emitGroup!: (draft: EventGroupDraft) => void;
    let completeResponse!: () => void;
    // First call: manually controlled pending stream. Second call: normal.
    (generator.generateInputResponse as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() =>
        createGenerationHandle("input", async (_signal, onGroup) => {
          return new Promise<GenerationEnvelope>((resolve) => {
            emitGroup = onGroup;
            completeResponse = () => resolve(envelope([], {}));
          });
        }),
      )
      .mockImplementationOnce(() =>
        handleFromDrafts("input", [narrationEvent("回应。")]),
      );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
          emitGroup(groupFromEvent({ type: "narration", text: "迟到事件。" }));
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

  it("never commits a state patch from a stale stream after cancel", async () => {
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    let emitGroup!: (draft: EventGroupDraft) => void;
    let completeStale!: (value: GenerationEnvelope) => void;
    // First call: manually controlled pending stream that outlives the
    // cancel. Second call: normal response for the re-opened interaction.
    (generator.generateInputResponse as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() =>
        createGenerationHandle("input", async (_signal, onGroup) => {
          return new Promise<GenerationEnvelope>((resolve) => {
            emitGroup = onGroup;
            completeStale = (value) => resolve(value);
          });
        }),
      )
      .mockImplementationOnce(() =>
        handleFromDrafts("input", [narrationEvent("回应。")]),
      );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    let previewIndex = 0;
    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.submitInput(output.interactionId, previewIndex === 0 ? "第一次" : "第二次"),
      onInputPreviewOpened: (output) => {
        if (previewIndex === 0) {
          // A line arrives while the preview is open; the player then cancels.
          emitGroup(groupFromEvent({ type: "narration", text: "暂存行。" }));
          controller.cancel(output.previewId);
        } else {
          // The cancel is now processed. The OLD stream's later events must
          // be dropped and its state patch must never reach the story state
          // (§17.14 / §17.15).
          emitGroup(groupFromEvent({ type: "narration", text: "迟到事件。" }));
          completeStale(
            envelope([], {
              open_threads: [
                {
                  id: "stale_thread",
                  summary: "来自取消流的线程",
                  status: "new",
                  last_touched_turn: 0,
                },
              ],
            }),
          );
          controller.confirm(output.previewId);
        }
        previewIndex += 1;
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // Neither the staged line nor the late event rendered; the stale patch
    // never applied and the late event was dropped at the abort boundary.
    const played = controller.playbackEvents().map((output) => output.event);
    const texts = played.map((e) => e.text);
    expect(texts).not.toContain("暂存行。");
    expect(texts).not.toContain("迟到事件。");
    const storyState = (game as any).storyState as { open_threads: Array<{ id: string }> };
    expect(storyState.open_threads.map((t) => t.id)).not.toContain("stale_thread");
    expect(game.getMetrics().input.stale_input_event_dropped_count).toBe(1);
  });

  it("reuses the bridge across preview cancels", async () => {
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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

  it("ignores envelope state_patch; storyState reconciles from committed events", async () => {
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    let resolveResponse!: (env: GenerationEnvelope) => void;
    makeManualInputResponse(generator, async () => {
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => {
        controller.confirm(output.previewId);
        // The envelope arrives AFTER the confirm, but its state_patch is
        // legacy protocol (§96): never applied. Only committed events
        // project StoryState.
        resolveResponse(
          envelope([narrationEvent("回应。")], { recent_summary: "玩家说了你好" }),
        );
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect((game as any).storyState.recent_summary).toBe("结尾。");
  });

  it("never applies envelope patches; state reflects committed events only", async () => {
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    makeManualInputResponse(generator, async () =>
      envelope([narrationEvent("回应。")], { recent_summary: "未确认的摘要" }),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: async (output) => {
        // Let the request finish while the preview is still open: its
        // envelope patch is never applied — only committed events project.
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect((game as any).storyState.recent_summary).toBe("开场。");
        controller.confirm(output.previewId);
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // The unconfirmed envelope's patch is discarded forever; the summary
    // comes from the last committed line.
    expect((game as any).storyState.recent_summary).toBe("结尾。");
  });

  it("keeps the arrived prefix when a confirmed stream fails", async () => {
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    makeManualInputResponse(generator, async (_signal, onGroup) => {
      onGroup(groupFromEvent({ type: "narration", text: "半句回应。" }));
      throw new Error("流中断");
    });
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) => {
        // The continuation repair receives the committed prefix: player line
        // + bridge + the arrived response line.
        expect(
          request.prefetchedEvents.some(
            (e) => (e as { text?: string }).text === "半句回应。",
          ),
        ).toBe(true);
        expect(
          request.prefetchedEvents.some(
            (e) =>
              e.type === "player_dialogue" &&
              (e as { text?: string }).text === "你好",
          ),
        ).toBe(true);
        expect(
          request.prefetchedEvents.some(
            (e) => (e as { text?: string }).text === "她等着你开口。",
          ),
        ).toBe(true);
        return handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]);
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() =>
        createGenerationHandle("input", async () => {
          throw new Error("首轮失败");
        }),
      )
      .mockImplementationOnce(() =>
        handleFromDrafts("input", [narrationEvent("修复回应。")]),
      );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        createGenerationHandle("input", async () => {
          throw new Error("总是失败");
        }),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    let emitStale!: (draft: EventGroupDraft) => void;
    let completeStale!: () => void;
    let emitLive!: (draft: EventGroupDraft) => void;
    let completeLive!: () => void;
    (generator.generateInputResponse as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() =>
        createGenerationHandle("input", async (_signal, onGroup) => {
          return new Promise<GenerationEnvelope>((resolve) => {
            emitStale = onGroup;
            completeStale = () => resolve(envelope([], {}));
          });
        }),
      )
      .mockImplementationOnce(() =>
        createGenerationHandle("input", async (_signal, onGroup) => {
          return new Promise<GenerationEnvelope>((resolve) => {
            emitLive = onGroup;
            completeLive = () => resolve(envelope([], {}));
          });
        }),
      );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
          emitStale(groupFromEvent({ type: "narration", text: "迟到。" }));
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
            emitLive(groupFromEvent({ type: "narration", text: "回应。" }));
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
    const config = makeGameConfig({ input: { require_preview_confirmation: false } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
// StoryState reconciliation from committed events (§81)
// ---------------------------------------------------------------------------

describe("StoryState reconciliation", () => {
  it("reconciles storyState from committed events (after a microtask)", async () => {
    const config = makeTestConfig();
    const generator = makeMockGenerator();
    const status = makeMockStatus();
    const media = makeMockMedia();
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    await (game as any).record({
      type: "narration",
      text: "走进地下室。",
      stage: [{ type: "background", assetId: "basement" }],
      seq: 1,
      turn: 1,
      timestamp: "2026-08-11T00:00:00.000Z",
      source: "model",
    });
    // reconcile runs on a microtask after record(); a macrotask yields past
    // the whole microtask queue, so this is deterministic, not a duration guess.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect((game as any).storyState.scene.location).toBe("basement");
    expect(Object.keys((game as any).storyState.characters)).toEqual([]);
    await (game as any).record({
      type: "dialogue",
      characterId: "suyao",
      speaker: "苏遥",
      text: "你不该来这里。",
      seq: 2,
      turn: 1,
      timestamp: "2026-08-11T00:00:00.000Z",
      source: "model",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(Object.keys((game as any).storyState.characters)).toEqual(["suyao"]);
  });
});

// ---------------------------------------------------------------------------
// Metrics reflection (pass-through to shared Metrics)
// ---------------------------------------------------------------------------

describe("Metrics pass-through", () => {
  let config: AppConfig;
  let generator: StoryGeneratorPort;
  let status: RuntimeStatus;
  let media: MediaPlannerPort;

  beforeEach(() => {
    config = makeGameConfig();
    generator = makeMockGenerator();
    status = makeMockStatus();
    media = makeMockMedia();
  });

  it("getMetrics snapshot should reflect mutations on the shared Metrics", () => {
    const metrics = new Metrics();
    const game = new Game(config, generator, status, media, metrics, makeTestPorts());

    metrics.recordSchemaValidationFailure();
    metrics.recordSchemaValidationFailure();

    const snap = game.getMetrics();
    expect(snap.errors.schema_validation_failures).toBe(2);
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
    const config = makeGameConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "interaction_1",
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
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    // The runtime opens the interaction once and waits for a command; a
    // client-side cancel loop (re-prompting) never touches the runtime.
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[0]!;
        controller.select(output.interactionId, first.id);
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

  it("after a preview cancel the hybrid re-arms BOTH paths and re-prefetches: a later select_choice is accepted and its branch plays", async () => {
    const sessionsDir = path.join(tempDir, "sessions");
    const config = makeGameConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        hybridFixture(),
      ]),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    // First open: submit free text; the preview is then cancelled. The
    // re-opened hybrid (second interaction_opened) must accept a
    // select_choice again — the option path must not be dead (§11.7).
    let previews = 0;
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        if (controller.count("interaction_opened") === 1) {
          controller.submitInput(output.interactionId, "先试试输入");
        } else {
          controller.select(
            output.interactionId,
            (output.interaction as { options?: Array<{ id: string }> }).options![0]!.id,
          );
        }
      },
      onInputPreviewOpened: (output) => {
        previews += 1;
        controller.cancel(output.previewId);
      },
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts({ store: new NodeJsonlSessionStore(sessionsDir) }));
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // Cancel → interaction re-opened (second open) → option accepted.
    expect(controller.count("interaction_opened")).toBe(2);
    expect(controller.count("input_preview_canceled")).toBe(1);
    // Both branches were prefetched once initially and re-prefetched after
    // the cancel (one call per option per prefetch round).
    expect(generator.generateBranchPrefetch).toHaveBeenCalledTimes(4);
    expect(generator.generateInputResponse).toHaveBeenCalledTimes(1);
    // Exactly one resolution — the option path — and the selected branch
    // plays; the cancelled input response never renders.
    expect(
      controller.outputs.filter(
        (o): o is Extract<RuntimeOutput, { type: "interaction_resolved" }> =>
          o.type === "interaction_resolved",
      ),
    ).toEqual([{ type: "interaction_resolved", interactionId: "interaction_1", resolution: "choice" }]);
    const played = controller.playbackEvents().map((output) => output.event.text);
    expect(played).toContain("分支内容。");
    expect(played).not.toContain("回应。");
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
    const config = makeGameConfig({ game: { sessions_dir: sessionsDir } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    // The selected branch stays "generating" at selection time: it has
    // emitted one line; the second line arrives right after the choice.
    // Both options get their own emitter (each prefetch entry appends to
    // its own event list), keyed by option id.
    const emitters = new Map<string, () => void>();
    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
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
      (request: BranchPrefetchRequest) =>
        createGenerationHandle(`branch:${request.option.id}`, async (_signal, onGroup) => {
          onGroup(groupFromEvent({ type: "narration", text: `分支${request.option.id}第一句。` }));
          await new Promise<void>((resolve) => {
            emitters.set(request.option.id, () => {
              onGroup(groupFromEvent({ type: "narration", text: `分支${request.option.id}第二句。` }));
              resolve();
            });
          });
          return [] as unknown as GenerationEnvelope;
        }),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("续写。"), endEvent("end_1", "Fin.")]),
    );

    // Emit the second line right when the player picks an option: the live
    // selection observes it and hands off once playable lines hit the
    // threshold (branch_dialogue_lines = 2).
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        const first = (output.interaction as { options?: Array<{ id: string }> }).options![0]!;
        emitters.get(first.id)?.();
        controller.select(output.interactionId, first.id);
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
    return makeGameConfig({
      interaction: {
        allowed_modes: ["choice", "hybrid"],
        default_mode: "choice",
        options: { min_count: 2, max_count: 5 },
        input: { max_length: 500, max_consecutive_pure_input: 1 },
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
    };
  }

  it("rejects an illegal interaction mode before buffering and repairs with a legal terminal", async () => {
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    // Opening streams a narration, then an ILLEGAL input interaction.
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        createGenerationHandle("opening", async (_signal, onGroup) => {
          onGroup(groupFromEvent({ type: "narration", text: "开场。" }));
          onGroup(groupFromEvent(inputInteraction("int_illegal")));
          return envelope([]);
        }),
    );
    // Repair continuation emits a LEGAL choice interaction; the post-choice
    // continuation ends the story.
    let repairReason: string | undefined;
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce((request: ContinuationRequest) => {
        // The Game-level repair passes the concrete policy reason so the
        // model sees WHY its previous output was rejected.
        repairReason = request.repairReason;
        return handleFromDrafts("continuation", [narrationEvent("修复段。"), choiceInteraction("int_legal")]);
      })
      .mockImplementationOnce(() =>
        handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
      );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );

    const diagnostics: Array<{ scope: string; message: string }> = [];
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[0]!;
        controller.select(output.interactionId, first.id);
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
    // (legal) terminal opened. Choice-mode interactions are addressed under
    // their own interaction_id (docs §30).
    const opened = controller.outputs.filter(
      (output): output is InteractionOpenedOutput =>
        output.type === "interaction_opened",
    );
    expect(opened).toHaveLength(1);
    // The repaired (legal) terminal is a choice — the illegal input never
    // opened. Both were emitted in the same turn, so the runtime ids
    // collide; the mode distinguishes them.
    // choice terminals are emitted as synthetic choice events (no mode).
    expect(opened[0]!.interaction.type).toBe("choice");
    expect(
      opened.some((output) => (output.interaction as { mode?: string }).mode === "input"),
    ).toBe(false);

    // Its bridge was never materialized; the only branch prefetches come
    // from the legal terminal's BranchManager (one per option).
    expect((game as any).bridgeBuffer.peek("interaction_1")).toBeNull();
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
      (request: OpeningRequest) =>
        createGenerationHandle("opening", async (_signal, onGroup) => {
          onGroup(groupFromEvent(inputInteraction("int_illegal")));
          return envelope([]);
        }),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() =>
        handleFromDrafts("continuation", [narrationEvent("修复段。"), choiceInteraction("int_legal")]),
      )
      .mockImplementationOnce(() =>
        handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
      );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[0]!;
        controller.select(output.interactionId, first.id);
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
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteraction("interaction_1")]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    );
    // Continuation #1 tries to open ANOTHER pure input → 2 consecutive →
    // rejected. Repair #1 emits a choice (non-input), then the post-choice
    // continuation ends the story.
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() =>
        handleFromDrafts("continuation", [narrationEvent("续写。"), inputInteraction("interaction_2")]),
      )
      .mockImplementationOnce(() =>
        handleFromDrafts("continuation", [narrationEvent("修复段。"), choiceInteraction("int_3")]),
      )
      .mockImplementationOnce(() =>
        handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
      );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        if (output.interactionId === "interaction_1") {
          controller.submitInput("interaction_1", "你好");
        } else {
          controller.select(
            output.interactionId,
            (output.interaction as { options?: Array<{ id: string }> }).options![0]!.id,
          );
        }
      },
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(
      makeGameConfig(),
      generator,
      status,
      media,
      undefined,
      makeTestPorts(),
    );
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // int_1 (input) and the repaired choice (emitted as int_3) opened;
    // int_2 was rejected before it could open. Choice-mode interactions
    // are addressed under their own interaction_id (docs §30).
    const openedIds = controller.outputs
      .filter((output) => output.type === "interaction_opened")
      .map((output) => (output as InteractionOpenedOutput).interactionId);
    expect(openedIds).toEqual(["interaction_1", "interaction_2"]);
  });

  it("accepts a pure input after a hybrid interaction (streak reset)", async () => {
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), hybridInteraction("interaction_1")]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    );
    // The continuation opens a pure input AFTER a hybrid: the streak was
    // broken, so it must be accepted.
    (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() =>
        handleFromDrafts("continuation", [narrationEvent("续写。"), inputInteraction("interaction_2")]),
      )
      .mockImplementationOnce(() =>
        handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
      );

    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.submitInput(output.interactionId, "随便说点什么");
      },
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(
      makeGameConfig(),
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
    expect(openedIds).toEqual(["interaction_1", "interaction_2"]);
    expect(controller.ended()).toBe(true);
  });

  it("creates no BranchManager for pure input terminals (§13.2)", () => {
    const generator = makeMockGenerator();
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );
    const game = new Game(
      makeGameConfig(),
      generator,
      makeMockStatus(),
      makeMockMedia(),
      undefined,
      makeTestPorts(),
    );
    const g = game as any;

    expect(g.createBranchManagerForTerminal(inputInteraction("interaction_1"), 1, [])).toBeNull();
    expect(g.createBranchManagerForTerminal(hybridInteraction("interaction_2"), 1, [])).not.toBeNull();
    expect(g.createBranchManagerForTerminal(choiceInteraction("int_3"), 1, [])).not.toBeNull();
  });

  it("never prefetches branches during a pure input run", async () => {
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteraction("interaction_1")]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.submitInput(output.interactionId, "你好");
      },
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(
      makeGameConfig(),
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
      makeGameConfig(),
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
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
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.select(
          output.interactionId,
          (output.interaction as { options?: Array<{ id: string }> }).options![0]!.id,
        ),
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
      interactionId: "interaction_1",
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        {
          type: "interaction",
          interaction_id: "interaction_1",
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
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.select(
          output.interactionId,
          (output.interaction as { options?: Array<{ id: string }> }).options![0]!.id,
        ),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(
      controller.outputs.filter((output) => output.type === "interaction_resolved"),
    ).toEqual([
      {
        type: "interaction_resolved",
        interactionId: "interaction_1",
        resolution: "choice",
      },
    ]);
    // The preset choice discards the bridge; its narration never plays.
    const played = controller.playbackEvents().map((output) => output.event.text);
    expect(played).not.toContain("她等着你的决定。");
    // The option path never touches the input pipeline: no response request.
    expect(generator.generateInputResponse).not.toHaveBeenCalled();
  });

  it("emits interaction_resolved(input) on confirm, before input_committed", async () => {
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
    const config = makeGameConfig({ input: { require_preview_confirmation: false } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
      interactionId: "interaction_1",
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

function hybridFixture(interactionId = "interaction_1", bridgeText = "她等着你的决定。") {
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), choiceFixture()]),
    );
    vi.mocked(generator.generateBranchPrefetch).mockImplementation(
      (request: BranchPrefetchRequest) =>
        handleFromDrafts("branch", [
          narrationEvent(request.option.id.endsWith("_opt_0") ? "分支A。" : "分支B。"),
        ]),
    );
    vi.mocked(generator.generateContinuation).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) =>
        controller.select(
          output.interactionId,
          (output.interaction as { options?: Array<{ id: string }> }).options![0]!.id,
        ),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const g = game as unknown as GameScopingInternals;
    expect(
      controller.outputs.filter((o) => o.type === "interaction_resolved"),
    ).toEqual([{ type: "interaction_resolved", interactionId: "interaction_1", resolution: "choice" }]);
    const playerChoices = g.events.filter((e) => e.type === "player_choice");
    expect(playerChoices).toHaveLength(1);
    expect(playerChoices[0]!).toMatchObject({ choice_id: "interaction_1_opt_0" });
    // Only the selected branch plays; the unselected branch is canceled.
    const played = controller.playbackEvents().map((o) => o.event.text);
    expect(played).toContain("分支A。");
    expect(played).not.toContain("分支B。");
    // No stale interaction commands linger and the scope is fully released.
    expect(g.deferredCommands).toHaveLength(0);
    expect(g.activeInteractionId).toBeNull();
  });

  it("input flow: preview → response generation started → confirm → resolved(input) → committed → player line → bridge → NPC response", async () => {
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    vi.mocked(generator.generateInputResponse).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    vi.mocked(generator.generateContinuation).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
    ).toEqual([{ type: "interaction_resolved", interactionId: "interaction_1", resolution: "input" }]);
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), hybridFixture()]),
    );
    vi.mocked(generator.generateBranchPrefetch).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );
    vi.mocked(generator.generateInputResponse).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    vi.mocked(generator.generateContinuation).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    // Both entrances submit in the same tick, the option click first.
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.select(
          output.interactionId,
          (output.interaction as { options?: Array<{ id: string }> }).options![0]!.id,
        );
        controller.submitInput(output.interactionId, "竞态输入");
      },
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const g = game as unknown as GameScopingInternals;
    expect(
      controller.outputs.filter((o) => o.type === "interaction_resolved"),
    ).toEqual([{ type: "interaction_resolved", interactionId: "interaction_1", resolution: "choice" }]);
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), hybridFixture()]),
    );
    vi.mocked(generator.generateBranchPrefetch).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );
    vi.mocked(generator.generateInputResponse).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    vi.mocked(generator.generateContinuation).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    // Both entrances submit in the same tick, the input first.
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.submitInput(output.interactionId, "竞态输入");
        controller.select(
        output.interactionId,
        (output.interaction as { options?: Array<{ id: string }> }).options![0]!.id,
      );
      },
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    const g = game as unknown as GameScopingInternals;
    expect(
      controller.outputs.filter((o) => o.type === "interaction_resolved"),
    ).toEqual([{ type: "interaction_resolved", interactionId: "interaction_1", resolution: "input" }]);
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), choiceFixture()]),
    );
    vi.mocked(generator.generateBranchPrefetch).mockImplementation(
      (request: BranchPrefetchRequest) =>
        handleFromDrafts("branch", [
          narrationEvent(request.option.id.endsWith("_opt_0") ? "分支A。" : "分支B。"),
        ]),
    );
    vi.mocked(generator.generateContinuation).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.select(
        output.interactionId,
        (output.interaction as { options?: Array<{ id: string }> }).options![0]!.id,
      );
        controller.select(
        output.interactionId,
        (output.interaction as { options?: Array<{ id: string }> }).options![0]!.id,
      );
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
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    vi.mocked(generator.generateOpening).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    vi.mocked(generator.generateInputResponse).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    vi.mocked(generator.generateContinuation).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
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
    ).toEqual([{ type: "interaction_resolved", interactionId: "interaction_1", resolution: "input" }]);
    expect(g.deferredCommands).toHaveLength(0);
    expect(g.activePreviewId).toBeNull();
    expect(g.activeInteractionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NarrativeDirector integration
// ---------------------------------------------------------------------------

type DirectorCall =
  | { type: "observeCommitted"; events: readonly StoredEvent[] }
  | { type: "checkpoint"; reason: string }
  | { type: "getBrief"; request: NarrativeBriefRequest };

function makeDirectorFake(
  briefOverrides?: Partial<NarrativeBrief>,
): NarrativeDirectorPort & { calls: DirectorCall[] } {
  const calls: DirectorCall[] = [];
  const baseBrief: NarrativeBrief = {
    revision: 0,
    consolidatedThroughEventSeq: 0,
    currentEventSeq: 0,
    checkpointCount: 0,
    location: "",
    characters: [],
    activeThreads: [],
    setupDirectives: [],
    relevantEpisodes: [],
    anchors: [],
    revealLocks: [],
    ...briefOverrides,
  };
  return {
    calls,
    getBrief(request: NarrativeBriefRequest): NarrativeBrief {
      calls.push({ type: "getBrief", request });
      return {
        ...baseBrief,
        currentEventSeq: request.eventSeq,
        location: request.location,
        characters: request.characters,
      };
    },
    observeCommitted(events: readonly StoredEvent[]): void {
      calls.push({ type: "observeCommitted", events: [...events] });
    },
    checkpoint(reason: string): void {
      calls.push({ type: "checkpoint", reason });
    },
  };
}

function makePortsWithDirector(
  director: NarrativeDirectorPort,
): GamePorts {
  const base = makeTestPorts();
  return { ...base, narrativeDirector: director };
}

describe("NarrativeDirector integration", () => {
  let config: AppConfig;
  let generator: StoryGeneratorPort;
  let status: RuntimeStatus;
  let media: MediaPlannerPort;

  beforeEach(() => {
    config = makeGameConfig();
    generator = makeMockGenerator();
    status = makeMockStatus();
    media = makeMockMedia();
  });

  it("delivers observeCommitted after a playable line is recorded", async () => {
    const director = makeDirectorFake();

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场叙事。"),
        endEvent("end_1", "Fin."),
      ]),
    );

    const game = new Game(
      config,
      generator,
      status,
      media,
      undefined,
      makePortsWithDirector(director),
    );
    const controller = new MemoryController();
    controller.attach(game);
    await game.run();

    // The narration event enters the log via recordModelEvent → record
    const observed = director.calls.filter(
      (c): c is DirectorCall & { type: "observeCommitted" } =>
        c.type === "observeCommitted",
    );
    expect(observed.length).toBeGreaterThanOrEqual(1);

    // At least one narration event was committed with a matching seq
    const allObservedEvents = observed.flatMap((c) => c.events);
    const narrationObserveds = allObservedEvents.filter(
      (e) => e.type === "narration",
    );
    expect(narrationObserveds.length).toBeGreaterThanOrEqual(1);
    for (const event of narrationObserveds) {
      expect(event).toHaveProperty("seq");
      expect(typeof event.seq).toBe("number");
    }
  });

  it("delivers checkpoint('interaction_completed') after a choice is consumed", async () => {
    const director = makeDirectorFake();

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("选择前。"),
        {
          type: "choice",
          prompt: "怎么走？",
          options: [
            { id: "opt_a", text: "左边" },
            { id: "opt_b", text: "右边" },
          ],
        },
      ]),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支A。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("续写。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(
      config,
      generator,
      status,
      media,
      undefined,
      makePortsWithDirector(director),
    );
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        const first = (
          output.interaction as { options?: Array<{ id: string }> }
        ).options?.[0]!;
        controller.select(output.interactionId, first.id);
      },
    });
    controller.attach(game);
    await game.run();

    const checkpoints = director.calls.filter(
      (c): c is DirectorCall & { type: "checkpoint" } =>
        c.type === "checkpoint",
    );
    expect(
      checkpoints.some((c) => c.reason === "interaction_completed"),
    ).toBe(true);

    // The checkpoint must fire AFTER the player choice is formally
    // committed: a consolidation triggered by it includes the choice
    // event (audit finding 5).
    const firstCheckpointIdx = director.calls.findIndex(
      (c) => c.type === "checkpoint" && c.reason === "interaction_completed",
    );
    const observedBeforeCheckpoint = director.calls
      .slice(0, firstCheckpointIdx)
      .filter(
        (c): c is DirectorCall & { type: "observeCommitted" } =>
          c.type === "observeCommitted",
      );
    expect(
      observedBeforeCheckpoint.some((o) =>
        o.events.some((ev) => ev.type === "player_choice"),
      ),
    ).toBe(true);
  });

  it("fires exactly ONE checkpoint per resolved hybrid interaction (cancel+resubmit does not double-count)", async () => {
    const director = makeDirectorFake();

    // Opening: narration + hybrid interaction
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        hybridFixture(),
      ]),
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    // Player opens preview, cancels, then selects a preset option.
    // Exactly ONE checkpoint must be recorded.
    let previews = 0;
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        if (controller.count("interaction_opened") === 1) {
          controller.submitInput(output.interactionId, "先试试输入");
        } else {
          controller.select(
            output.interactionId,
            (output.interaction as { options?: Array<{ id: string }> }).options![0]!.id,
          );
        }
      },
      onInputPreviewOpened: (output) => {
        previews += 1;
        controller.cancel(output.previewId);
      },
    });

    const game = new Game(
      config,
      generator,
      status,
      media,
      undefined,
      makePortsWithDirector(director),
    );
    controller.attach(game);
    await game.run();

    const checkpoints = director.calls.filter(
      (c): c is DirectorCall & { type: "checkpoint" } =>
        c.type === "checkpoint",
    );
    const interactionCheckpoints = checkpoints.filter(
      (c) => c.reason === "interaction_completed",
    );
    // ASSERT: exactly one intervention_checkpoint despite preview cancel
    expect(interactionCheckpoints).toHaveLength(1);
    expect(controller.ended()).toBe(true);
  });

  it("never delivers prefetch candidate content to observeCommitted", async () => {
    const director = makeDirectorFake();

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        {
          type: "choice",
          prompt: "怎么走？",
          options: [
            { id: "opt_a", text: "左边" },
            { id: "opt_b", text: "右边" },
          ],
        },
      ]),
    );
    // Each branch returns distinct content; the unselected branch must never
    // appear in observeCommitted.
    const branchAContent = "这是分支A的专属内容。";
    const branchBContent = "这是分支B的专属内容，不应该出现。";
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(
      (request: BranchPrefetchRequest) => {
        // Runtime-generated option IDs are unpredictable; identify by text.
        if (request.option.text === "左边") {
          return handleFromDrafts("branch", [narrationEvent(branchAContent)]);
        }
        return handleFromDrafts("branch", [narrationEvent(branchBContent)]);
      },
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("续写。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(
      config,
      generator,
      status,
      media,
      undefined,
      makePortsWithDirector(director),
    );
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        const first = (
          output.interaction as { options?: Array<{ id: string }> }
        ).options?.[0]!;
        controller.select(output.interactionId, first.id);
      },
    });
    controller.attach(game);
    await game.run();

    // The prefetch content should NOT appear in observeCommitted events
    const observed = director.calls.filter(
      (c): c is DirectorCall & { type: "observeCommitted" } =>
        c.type === "observeCommitted",
    );
    // The unselected branch B content must never appear in observed events
    const allObservedTexts = observed.flatMap((c) =>
      c.events
        .filter((e) => "text" in e)
        .map((e) => (e as { text: string }).text),
    );
    expect(allObservedTexts).not.toContain(branchBContent);
    // The selected branch A content should appear (it is played and recorded)
    expect(allObservedTexts).toContain(branchAContent);
  });

  it("passes the brief from getBrief into generator options", async () => {
    const director = makeDirectorFake({
      revision: 7,
      checkpointCount: 3,
      activeThreads: [
        {
          id: "thread_1",
          kind: "main" as const,
          summary: "寻找失踪的妹妹",
          status: "developing" as const,
          importance: "major" as const,
          lastTouchedAtCheckpoint: 5,
        },
      ],
      setupDirectives: [
        {
          id: "setup_1",
          action: "reinforce" as const,
          urgency: "soon" as const,
        },
      ],
    });

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        endEvent("end_1", "Fin."),
      ]),
    );

    const game = new Game(
      config,
      generator,
      status,
      media,
      undefined,
      makePortsWithDirector(director),
    );
    const controller = new MemoryController();
    controller.attach(game);
    await game.run();

    expect(generator.generateOpening).toHaveBeenCalled();

    // The request object carries the brief from getBrief.
    const callArgs = (
      generator.generateOpening as ReturnType<typeof vi.fn>
    ).mock.calls[0] as unknown[];
    const request = callArgs[0] as OpeningRequest;
    expect(request.brief).toBeDefined();

    const brief = request.brief as NarrativeBrief;
    expect(brief.revision).toBe(7);
    expect(brief.checkpointCount).toBe(3);
    expect(brief.activeThreads).toHaveLength(1);
    expect(brief.activeThreads[0]!.summary).toBe("寻找失踪的妹妹");
    expect(brief.setupDirectives).toHaveLength(1);
    expect(brief.setupDirectives[0]!.action).toBe("reinforce");
  });

  it("has zero behavioural change when no narrativeDirector is provided", async () => {
    // Baseline: no director; run must complete normally
    const ports = makeTestPorts(); // no narrativeDirector

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        endEvent("end_1", "Fin."),
      ]),
    );

    const game = new Game(
      config,
      generator,
      status,
      media,
      undefined,
      ports,
    );
    const controller = new MemoryController();
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(controller.ended()).toBe(true);
    // No brief in the request when director is absent
    const callArgs = (
      generator.generateOpening as ReturnType<typeof vi.fn>
    ).mock.calls[0] as unknown[];
    const request = callArgs[0] as OpeningRequest;
    expect(request.brief).toBeUndefined();
  });
});
