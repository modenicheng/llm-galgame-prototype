/**
 * Game input subsystem: two-phase input commit, preview cancel, bridge
 * prefetch semantics, and response streaming (docs §32–§34).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Game } from "./game.js";

import {
  makeTestPorts,
  MemoryController,
} from "./test-helpers.js";

import { createGenerationHandle } from "./core/ports/story-generator-port.js";
import type {
  ContinuationRequest,
  InputResponseRequest,
} from "./core/ports/story-generator-port.js";

import type {
  RuntimePlayableEvent,
  StoredEvent,
} from "./schema.js";

import type { GenerationEnvelope } from "./story/types.js";
import type { EventGroupDraft } from "./core/protocol/gal-dsl/types.js";
import type { RuntimeOutput } from "./core/runtime/runtime-output.js";

import type {VisualState} from "./core/presentation/types.js";

import {
  endEvent,
  envelope,
  groupFromEvent,
  handleFromDrafts,
  inputInteractionFixture,
  makeGameConfig,
  makeManualInputResponse,
  makeMockGenerator,
  makeMockMedia,
  makeMockStatus,
  narrationEvent,
} from "./game-test-kit.js";

describe("Input preview cancellation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "galgame-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("aborts the stale NPC response when the preview is cancelled; its events never render", async () => {
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

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
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

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
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
        // legacy protocol (removed 2026-08-09, docs/changelog.md §115):
        // never applied. Only committed events project StoryState.
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

  it("seeds the predictive tail from the FULL response burst (no truncation on a final multi-group batch)", async () => {
    const config = makeGameConfig();
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    // Production shape: one early group, then a FINAL synchronous burst of
    // many groups; the last group carries a background cue. The ok handler
    // must await the pump so the predictive tail (docs §79) includes the
    // whole burst — not just the groups staged before handle.done resolved
    // (review I2).
    let emitGroup!: (draft: EventGroupDraft) => void;
    let completeResponse!: () => void;
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(
      (request: InputResponseRequest) =>
        createGenerationHandle("input", async (_signal, onGroup) => {
          onGroup(groupFromEvent({ type: "narration", text: "早到回应。" }));
          const { promise, resolve } = Promise.withResolvers<GenerationEnvelope>();
          emitGroup = onGroup;
          completeResponse = () => resolve(envelope([]));
          return promise;
        }),
    );
    (generator.generateInputBridge as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    );
    let continuationTail: VisualState | undefined;
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) => {
        continuationTail = request.tailVisualState;
        return handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]);
      },
    );

    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "你好"),
      onInputPreviewOpened: (output) => {
        // The pump is already draining: push the final burst while it waits,
        // then resolve the runner right after — the ok handler races the
        // drain exactly like the production final batch.
        for (let i = 0; i < 12; i += 1) {
          const draft: EventGroupDraft = {
            prelude: i === 11 ? [{ type: "background", assetId: "basement" }] : [],
            main: { type: "narration", text: `回应片段${i}。` },
          };
          emitGroup(draft);
        }
        completeResponse();
        controller.confirm(output.previewId);
      },
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // The last burst group's stage cue must seed the next generation's
    // request (docs §79) — a truncated tail would drop it.
    expect(continuationTail?.background).toBe("basement");
  });

  it("single-Enter flow: an instantly-settled failed stream is retried, not live-promoted", async () => {
    const config = makeGameConfig({ input: { require_preview_confirmation: false } });
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    // The response fails in the same tick the input is submitted; the
    // confirm-point microtask drain classifies it as a repair attempt.
    (generator.generateInputResponse as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() =>
        createGenerationHandle("input", async () => {
          throw new Error("首轮失败");
        }),
      )
      .mockImplementationOnce(() =>
        handleFromDrafts("input", [narrationEvent("修复回应。")]),
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

    // Original attempt + one repair — the failed stream is NOT promoted
    // live, and the repaired response plays.
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
});

// ---------------------------------------------------------------------------
// StoryState reconciliation from committed events (§81)
// ---------------------------------------------------------------------------
