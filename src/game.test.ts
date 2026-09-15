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
import { SessionIdGenerator } from "./adapters/platform/session-id-generator.js";
import type { StoryGeneratorPort } from "./core/ports/story-generator-port.js";
import { createGenerationHandle } from "./core/ports/story-generator-port.js";
import type {
  OpeningRequest,
  BranchPrefetchRequest,
} from "./core/ports/story-generator-port.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import type { RuntimeStatus } from "./runtime/status.js";
import type { AppConfig } from "./config.js";
import type {
  RuntimePlayableEvent,
} from "./schema.js";

import type { GenerationEnvelope } from "./story/types.js";

import type {
  NarrativeBrief,
} from "./core/narrative/narrative-brief.js";

import {
  endEvent,
  groupFromEvent,
  handleFromDrafts,
  hybridFixture,
  makeDirectorFake,
  makeGameConfig,
  makeMockGenerator,
  makeMockMedia,
  makeMockStatus,
  makePortsWithDirector,
  narrationEvent,
} from "./game-test-kit.js";
import type {DirectorCall} from "./game-test-kit.js";

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

describe("Narration-only branch handoff", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "galgame-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("hands a narration-only branch over to the continuation once playable lines reach the threshold", async () => {
    const config = makeGameConfig();
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

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
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
