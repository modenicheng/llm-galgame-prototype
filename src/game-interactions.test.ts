/**
 * Interaction form drivers and guardrails: hybrid commands, policy
 * enforcement (§8.5), resolution publication, and command scoping
 * (§10.2 stale / double-submit).
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
  OpeningRequest,
  ContinuationRequest,
  BranchPrefetchRequest,
} from "./core/ports/story-generator-port.js";

import type { AppConfig } from "./config.js";
import type {
  InteractionEvent,
} from "./schema.js";

import type { RuntimeOutput } from "./core/runtime/runtime-output.js";
import type { InteractionOpenedOutput } from "./test-helpers.js";

import {
  choiceFixture,
  endEvent,
  envelope,
  groupFromEvent,
  handleFromDrafts,
  hybridFixture,
  inputInteractionFixture,
  makeGameConfig,
  makeMockGenerator,
  makeMockMedia,
  makeMockStatus,
  narrationEvent,
} from "./game-test-kit.js";
import type {GameScopingInternals} from "./game-test-kit.js";

describe("Hybrid interaction commands", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "galgame-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("selects a preset option from a hybrid interaction via commands", async () => {
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

    // The runtime opens the interaction once and waits for a command; a
    // client-side cancel loop (re-prompting) never touches the runtime.
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[0]!;
        controller.select(output.interactionId, first.id);
      },
    });

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // 开场 + 分支内容 + 结尾 = 3 段旁白；结局一次。
    expect(controller.count("interaction_opened")).toBe(1);
    expect(controller.countPlayback("narration")).toBe(3);
    expect(controller.ended()).toBe(true);
  });

  it("after a preview cancel the hybrid re-arms BOTH paths and re-prefetches: a later select_choice is accepted and its branch plays", async () => {
    const config = makeGameConfig();
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
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
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

  it("settles the generation pump when the segment fails mid-stream (no orphaned rejection, playable prefix preserved)", async () => {
    const status = makeMockStatus();
    const media = makeMockMedia();

    const generator = makeMockGenerator();
    // The opening publishes a playable line, then an ILLEGAL interaction,
    // and the runner itself fails (network error). The buffered illegal
    // group makes the pump reject with a policy error on the failure path;
    // the catch must settle the pump (review I1) or the rejection is
    // orphaned → Node's unhandledRejection=throw kills the run.
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(
      (request: OpeningRequest) =>
        createGenerationHandle("opening", async (_signal, onGroup) => {
          onGroup(groupFromEvent({ type: "narration", text: "半句。" }));
          onGroup(groupFromEvent(inputInteraction("int_illegal")));
          throw new Error("网络中断");
        }),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(
      (request: ContinuationRequest) => {
        // The repair continuation receives the playable prefix that
        // survived the failure.
        expect(
          request.prefetchedEvents.some(
            (event) => event.type === "narration" && event.text === "半句。",
          ),
        ).toBe(true);
        return handleFromDrafts("continuation", [narrationEvent("修复段。"), endEvent("end_1", "Fin.")]);
      },
    );
    (generator.generateBranchPrefetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("branch", [narrationEvent("分支内容。")]),
    );

    const controller = new MemoryController();
    const game = new Game(
      noInputConfig(),
      generator,
      status,
      media,
      undefined,
      makeTestPorts(),
    );
    controller.attach(game);
    // Without the fix the orphaned pump rejection fails the run; with the
    // fix the failure is repairable and the run completes.
    await expect(game.run()).resolves.toBeUndefined();

    expect(generator.generateContinuation).toHaveBeenCalledTimes(1);
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

  it("whitespace-only input is rejected at the boundary and the form re-opens (edge contract: choice text ≥ 1)", async () => {
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

    let opened = 0;
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        opened += 1;
        controller.submitInput(output.interactionId, opened === 1 ? "   " : "你好");
      },
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // 空白输入没有进预览/提交路径：表单重开一次，只有有效输入被记录。
    expect(controller.count("interaction_opened")).toBe(2);
    expect(controller.count("input_preview_opened")).toBe(1);
    expect(controller.count("input_committed")).toBe(1);
    const g = game as unknown as GameScopingInternals;
    const playerInputs = g.events.filter((e) => e.type === "player_input");
    expect(playerInputs).toHaveLength(1);
    expect(playerInputs[0]!).toMatchObject({ text: "你好" });
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
