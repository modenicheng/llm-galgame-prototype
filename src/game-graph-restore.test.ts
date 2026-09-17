/**
 * Game × graph integration (real storage in tmpdir): run-loop graph
 * commits (M1.3) and cursor restore / retrace across restarts (M1.4/M1.5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Game } from "./game.js";
import { RetraceRequestedError } from "./core/runtime/errors.js";

import { GameGraphStore } from "./adapters/storage/game-graph-store.js";
import { RunGraphCoordinator } from "./application/graph/run-graph-coordinator.js";

import {
  makeTestPorts,
  MemoryController,
  MemoryRunGraph,
  FakeClock,
} from "./test-helpers.js";

import { createGenerationHandle } from "./core/ports/story-generator-port.js";
import type {
  OpeningRequest,
  ContinuationRequest,
} from "./core/ports/story-generator-port.js";

import type {
  InteractionEvent,
} from "./schema.js";

import type { RuntimeOutput } from "./core/runtime/runtime-output.js";

import { EMPTY_MEMORY_DIGEST } from "./core/graph/memory-digest.js";

import {
  endEvent,
  groupFromEvent,
  handleFromDrafts,
  makeDirectorFake,
  makeGameConfig,
  makeMockGenerator,
  makeMockMedia,
  makeMockStatus,
  narrationEvent,
} from "./game-test-kit.js";

describe("Graph runtime lifecycle (M1.3)", () => {
  function makeGraphPorts() {
    const graph = new MemoryRunGraph();
    const ports = makeTestPorts({ graph });
    return { graph, ports };
  }

  it("opening-only run: root run and ending, no decisions (opening events stay out of the graph)", async () => {
    const { graph, ports } = makeGraphPorts();
    const generator = makeMockGenerator();
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), endEvent("end_solo", "落幕")]),
    );
    const game = new Game(
      makeGameConfig(), generator, makeMockStatus(), makeMockMedia(), undefined, ports,
    );
    new MemoryController().attach(game);
    await game.run();

    expect(graph.rootRunsStarted).toBe(1);
    expect(graph.decisions).toHaveLength(0);
    expect(graph.endings).toHaveLength(1);
    expect(graph.endings[0]?.endingId).toMatch(/^ending:/); // 运行时重写为生成式结局 id
  });

  it("interaction opens a decision node, resolution opens an edge, end concludes the run", async () => {
    const { graph, ports } = makeGraphPorts();
    const generator = makeMockGenerator();
    const interaction: InteractionEvent = {
      type: "interaction",
      interaction_id: "interaction_1",
      prompt: "继续吗？",
      mode: "choice",
      options: [{ id: "yes", text: "继续" }, { id: "no", text: "停止" }],
    };
    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), interaction]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("继续。"), endEvent("end_final")]),
    );
    const game = new Game(
      makeGameConfig(), generator, makeMockStatus(), makeMockMedia(), undefined, ports,
    );
    const controller = new MemoryController({
      onInteractionOpened: (output, current) => {
        const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[0]!;
        current.select(output.interactionId, first.id);
      },
    });
    controller.attach(game);
    await game.run();

    // 决策节点：表单快照（含 prompt 与选项文本）+ 运行时状态
    expect(graph.decisions).toHaveLength(1);
    const form = graph.decisions[0]?.form as {
      mode: string;
      prompt: string;
      options?: string[];
    };
    expect(form).toMatchObject({
      mode: "choice",
      prompt: "继续吗？",
      options: ["继续", "停止"],
    });
    const moment = graph.decisions[0]?.moment as { storyState: { scene: { id: string } } };
    expect(moment.storyState.scene.id).toBeTruthy();

    // 边：choice 语义来自玩家选择
    expect(graph.begunEdges).toEqual([{ kind: "option", text: "继续" }]);
    const flat = graph.appendedBatches.flat();
    expect(flat.some((event) => event.type === "player_choice")).toBe(true);
    expect(flat.some((event) => event.type === "narration")).toBe(true);

    // 结局收束
    expect(graph.endings).toHaveLength(1);
    expect(graph.endings[0]?.endingId).toMatch(/^ending:/);
  });

  it("preserves generated events and repairs the segment when the opening stream fails", async () => {
    const config = makeGameConfig();
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

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
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
    const config = makeGameConfig();
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

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
    const controller = new MemoryController();
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // Two failed repairs were consumed beyond the budget, then the third
    // succeeded and the game reached its ending instead of crashing.
    expect(repairs).toBe(3);
    expect(controller.ended()).toBe(true);
  });

  it("routes a repaired segment's choice into the normal branch flow", async () => {
    const config = makeGameConfig();
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

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
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
    const config = makeGameConfig();
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

    const game = new Game(config, generator, status, media, undefined, makeTestPorts());
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

describe("M1.4 游标恢复（真存储跨重启）", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "galgame-restore-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** 同一游戏目录上开一套 store + 协调器；id 工厂跨重启共享（防 id 撞号）。 */
  function makeGraphs() {
    let n = 0;
    const newId = (prefix: string) => `${prefix}r${++n}`;
    const make = () => {
      const store = new GameGraphStore(tempDir, "game_restore");
      const graph = new RunGraphCoordinator(store, new FakeClock(), newId);
      return { store, graph };
    };
    return make;
  }

  it("continues from the cursor decision after a restart: form re-presented, memory caught up, seq continuous", async () => {
    const make = makeGraphs();
    const { graph, store } = make();

    // —— 第一次运行：推进到第二个决策点后中断 ——
    const director1 = makeDirectorFake();
    const gen1 = makeMockGenerator();
    (gen1.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场叙事。"),
        {
          type: "choice",
          prompt: "第一次选择：",
          options: [{ id: "a", text: "救她" }, { id: "b", text: "离开" }],
        },
      ]),
    );
    (gen1.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [
        narrationEvent("第一次选择后的叙事。"),
        {
          type: "choice",
          prompt: "第二次选择：",
          options: [{ id: "c", text: "追上去" }, { id: "d", text: "留下" }],
        },
      ]),
    );
    let opens1 = 0;
    const controller1 = new MemoryController({
      onInteractionOpened: (output) => {
        opens1 += 1;
        // 第二个交互不回答——进程「崩溃」在游标上
        if (opens1 === 1) {
          const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[0]!;
          controller1.select(output.interactionId, first.id);
        }
      },
    });
    const game1 = new Game(
      makeGameConfig(), gen1, makeMockStatus(), makeMockMedia(), undefined,
      { ...makeTestPorts({ graph }), sessionId: "run1", narrativeDirector: director1 },
    );
    controller1.attach(game1);
    const run1 = game1.run();
    await vi.waitFor(() => expect(opens1).toBe(2));
    game1.dispatch({ type: "shutdown" });
    await expect(run1).rejects.toThrow("运行时已收到关闭指令");
    expect((await store.loadCursor())?.position).toMatch(/^dc_/);

    // —— 重启：同一目录、全新运行时 ——
    const { graph: graph2, store: store2 } = make();
    const director2 = makeDirectorFake();
    const gen2 = makeMockGenerator();
    (gen2.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation2", [
        narrationEvent("恢复后的叙事。"),
        endEvent("end_restore", "恢复了。"),
      ]),
    );
    const controller2 = new MemoryController({
      onInteractionOpened: (output) => {
        const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[0]!;
        controller2.select(output.interactionId, first.id);
      },
    });
    const game2 = new Game(
      makeGameConfig(), gen2, makeMockStatus(), makeMockMedia(), undefined,
      { ...makeTestPorts({ graph: graph2 }), sessionId: "run2", narrativeDirector: director2 },
    );
    controller2.attach(game2);
    await expect(game2.run()).resolves.toBeUndefined();

    // 不重新生成 opening；游标交互的表单原样重放（新运行时 id）
    expect(gen2.generateOpening).not.toHaveBeenCalled();
    expect(gen2.generateContinuation).toHaveBeenCalledTimes(1);
    expect(controller2.count("interaction_opened")).toBe(1);
    const reopened = controller2.outputs.find(
      (output): output is RuntimeOutput & { type: "interaction_opened" } =>
        output.type === "interaction_opened",
    );
    expect(reopened?.interaction.prompt).toBe("第二次选择：");
    const reopenedOptions = (reopened?.interaction as { options?: Array<{ text: string }> }).options;
    expect(reopenedOptions?.map((option) => option.text)).toEqual(["追上去", "留下"]);

    // 导演追赶：先按快照摘要重建，再全路径重放（水位过滤交给 observeCommitted）
    expect(director2.restoredWith).toEqual([EMPTY_MEMORY_DIGEST]);
    const observed = director2.calls.find((call) => call.type === "observeCommitted");
    if (observed?.type !== "observeCommitted") throw new Error("director 未收到重放");
    expect(observed.events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(observed.events.at(-1)?.type).toBe("interaction");

    // 图完整性：D1（首次）+ D2（游标重放）两个决策；旧边 D1→D2 + 恢复后的
    // 新边 D2→结局；seq 跨重启连续（新边从 6 起）、游标清除
    expect(await store2.listDecisions()).toHaveLength(2);
    const edges = await store2.listEdges();
    expect(edges).toHaveLength(2);
    const freshEdge = edges.find((edge) => edge.payload.firstSeq === 6);
    expect(freshEdge?.payload).toEqual({ eventCount: 3, firstSeq: 6, lastSeq: 8 });
    expect(freshEdge?.to.kind).toBe("ending");
    expect(await store2.loadCursor()).toBeNull();
    expect(controller2.ended()).toBe(true);
    const scenesText = await readFile(path.join(store2.location, "graph/scenes.jsonl"), "utf8");
    expect(scenesText.trim().split("\n")).toHaveLength(1); // 场景节点缓存水合，无重复
  });

  it("a completed run restores as ended: session_ended re-emitted, no generation", async () => {
    const make = makeGraphs();
    const { graph, store } = make();

    const gen1 = makeMockGenerator();
    (gen1.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场叙事。"),
        {
          type: "choice",
          prompt: "去留：",
          options: [{ id: "a", text: "留下" }, { id: "b", text: "离开" }],
        },
      ]),
    );
    (gen1.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结局前的叙事。"), endEvent("end_one", "完。")]),
    );
    const controller1 = new MemoryController({
      onInteractionOpened: (output) => {
        const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[0]!;
        controller1.select(output.interactionId, first.id);
      },
    });
    const game1 = new Game(
      makeGameConfig(), gen1, makeMockStatus(), makeMockMedia(), undefined,
      { ...makeTestPorts({ graph }), sessionId: "run1" },
    );
    controller1.attach(game1);
    await expect(game1.run()).resolves.toBeUndefined();
    const storedEnding = (await store.listRuns()).at(-1)?.ending;
    expect(storedEnding).toMatch(/^end_/);

    const { graph: graph2 } = make();
    const gen2 = makeMockGenerator();
    const controller2 = new MemoryController();
    const game2 = new Game(
      makeGameConfig(), gen2, makeMockStatus(), makeMockMedia(), undefined,
      { ...makeTestPorts({ graph: graph2 }), sessionId: "run2" },
    );
    controller2.attach(game2);
    await expect(game2.run()).resolves.toBeUndefined();

    expect(gen2.generateOpening).not.toHaveBeenCalled();
    expect(gen2.generateContinuation).not.toHaveBeenCalled();
    expect(controller2.ended()).toBe(true);
    const endedOutput = controller2.outputs.find(
      (output): output is RuntimeOutput & { type: "session_ended" } =>
        output.type === "session_ended",
    );
    expect(endedOutput?.ending.ending_id).toBe(storedEnding);
    // 结局文本从末边负载原样回收（与第一次运行时发出的结局文本一致）
    const firstEnded = controller1.outputs.find(
      (output): output is RuntimeOutput & { type: "session_ended" } =>
        output.type === "session_ended",
    );
    expect(endedOutput?.ending.text).toBe(firstEnded?.ending.text);
  });

  it("M1.5 restart: rebuilds at the cursor form, abandons the old run, and the new choice makes a new edge", async () => {
    const make = makeGraphs();
    const { graph } = make();

    // —— 第一次运行：推进到第二个决策点后中断 ——
    const gen1 = makeMockGenerator();
    (gen1.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场叙事。"),
        {
          type: "choice",
          prompt: "第一次选择：",
          options: [{ id: "a", text: "救她" }, { id: "b", text: "离开" }],
        },
      ]),
    );
    (gen1.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [
        narrationEvent("第一次选择后的叙事。"),
        {
          type: "choice",
          prompt: "第二次选择：",
          options: [{ id: "c", text: "追上去" }, { id: "d", text: "留下" }],
        },
      ]),
    );
    let opens1 = 0;
    const controller1 = new MemoryController({
      onInteractionOpened: (output) => {
        opens1 += 1;
        if (opens1 === 1) {
          const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[0]!;
          controller1.select(output.interactionId, first.id);
        }
      },
    });
    const game1 = new Game(
      makeGameConfig(), gen1, makeMockStatus(), makeMockMedia(), undefined,
      { ...makeTestPorts({ graph }), sessionId: "run1" },
    );
    controller1.attach(game1);
    const run1 = game1.run();
    await vi.waitFor(() => expect(opens1).toBe(2));
    game1.dispatch({ type: "shutdown" });
    await expect(run1).rejects.toThrow("运行时已收到关闭指令");

    // —— restart 重建：弃局旧周目，在游标表单上重开新周目 ——
    const { graph: graph2, store: store2 } = make();
    const gen2 = makeMockGenerator();
    (gen2.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation2", [
        narrationEvent("重来之后的叙事。"),
        endEvent("end_retry", "这次走到了结局。"),
      ]),
    );
    const controller2 = new MemoryController({
      onInteractionOpened: (output) => {
        const first = (output.interaction as { options?: Array<{ id: string }> }).options?.[1]!;
        controller2.select(output.interactionId, first.id); // 这次选另一个选项
      },
    });
    const game2 = new Game(
      makeGameConfig(), gen2, makeMockStatus(), makeMockMedia(), undefined,
      { ...makeTestPorts({ graph: graph2 }), sessionId: "run2", runMode: "restart" },
    );
    controller2.attach(game2);
    await expect(game2.run()).resolves.toBeUndefined();

    // 不重新生成 opening；游标表单重放（第二次选择）
    expect(gen2.generateOpening).not.toHaveBeenCalled();
    expect(controller2.count("interaction_opened")).toBe(1);
    const reopened = controller2.outputs.find(
      (output): output is RuntimeOutput & { type: "interaction_opened" } =>
        output.type === "interaction_opened",
    );
    expect(reopened?.interaction.prompt).toBe("第二次选择：");

    // 周目记账：run1 弃局于游标；run2 origin=retrace 且已结局
    const runs = await store2.listRuns();
    expect(runs).toHaveLength(2);
    const cursorPos = runs[0]?.abandonedAt;
    expect(cursorPos).toMatch(/^dc_/);
    expect(runs[1]?.origin).toEqual({ kind: "retrace", from: cursorPos });
    expect(runs[1]?.ending).toMatch(/^end_/);
    expect(await store2.loadCursor()).toBeNull();

    // 图：旧边 D1→D2 + 新边 D2→结局；无重复场景节点
    const edges = await store2.listEdges();
    expect(edges).toHaveLength(2);
    expect(edges[1]?.choice).toEqual({ kind: "option", text: "留下" });
    const scenesText = await readFile(path.join(store2.location, "graph/scenes.jsonl"), "utf8");
    expect(scenesText.trim().split("\n")).toHaveLength(1);
  });

  it("M5.3 retrace + identical choice fast-forwards to the successor with zero generation", async () => {
    const make = makeGraphs();
    const { graph, store } = make();

    // —— run1：推进到第三个决策表单后中断（D2 已有出边「留下」）——
    const gen1 = makeMockGenerator();
    (gen1.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场叙事。"),
        {
          type: "choice",
          prompt: "第一次选择：",
          options: [{ id: "a", text: "救她" }, { id: "b", text: "离开" }],
        },
      ]),
    );
    (gen1.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [
        narrationEvent("续写叙事。"),
        {
          type: "choice",
          prompt: "第二次选择：",
          options: [{ id: "c", text: "追上去" }, { id: "d", text: "留下" }],
        },
      ]),
    );
    let opens1 = 0;
    const controller1 = new MemoryController({
      onInteractionOpened: (output) => {
        opens1 += 1;
        const options = (output.interaction as { options?: Array<{ id: string }> }).options ?? [];
        if (opens1 === 1) controller1.select(output.interactionId, options[0]!.id);
        if (opens1 === 2) controller1.select(output.interactionId, options[1]!.id); // 留下
      },
    });
    const game1 = new Game(
      makeGameConfig(), gen1, makeMockStatus(), makeMockMedia(), undefined,
      { ...makeTestPorts({ graph }), sessionId: "run1" },
    );
    controller1.attach(game1);
    const run1 = game1.run();
    await vi.waitFor(() => expect(opens1).toBe(3));
    game1.dispatch({ type: "shutdown" });
    await expect(run1).rejects.toThrow("运行时已收到关闭指令");

    // 图：D1 -救她→ D2 -留下→ D3（游标停驻 D3 的表单）。
    const decisions = await store.listDecisions();
    expect(decisions).toHaveLength(3);
    const d2 = decisions[1]!.id;
    const { graph: graph2, store: store2 } = make();
    void graph2;

    // —— game2：resume 恢复在 D3 表单 → 发送 retrace 命令回溯到 D2 ——
    const gen2 = makeMockGenerator();
    let opens2 = 0;
    const controller2 = new MemoryController({
      onInteractionOpened: (output) => {
        opens2 += 1;
        const options = (output.interaction as { options?: Array<{ id: string; text?: string }> }).options ?? [];
        if (opens2 === 1) {
          // 恢复表单（第三次选择）：由测试主体发送 retrace 命令，不作答。
          return;
        }
        if (opens2 === 2) {
          // D2 重放表单（第二次选择）：重选同一选项「留下」→ 快进命中。
          const leave = options.find((o) => o.text === "留下")!;
          controller2.select(output.interactionId, leave.id);
        }
        // opens2 === 3：快进后的 D3 表单重放——零生成，等待断言即可。
      },
    });
    const game2 = new Game(
      makeGameConfig(), gen2, makeMockStatus(), makeMockMedia(), undefined,
      { ...makeTestPorts({ graph: graph2 }), sessionId: "run2" },
    );
    controller2.attach(game2);
    const run2 = game2.run();
    // 等恢复表单打开（第三次选择 → opens 计数在 game2 上独立）
    await vi.waitFor(() => expect(controller2.count("interaction_opened")).toBe(1));
    game2.dispatch({ type: "retrace", decisionId: d2 });
    await expect(run2).rejects.toThrow(RetraceRequestedError);
    await game2.prepareRetrace(d2);
    const run2b = game2.run();

    // 回溯 → D2 表单重放（第二次选择）→ 选「留下」→ 快进到 D3 表单。
    await vi.waitFor(() => expect(controller2.count("interaction_opened")).toBe(2));
    const lastOpened = [...controller2.outputs]
      .reverse()
      .find((output): output is RuntimeOutput & { type: "interaction_opened" } =>
        output.type === "interaction_opened");
    expect(lastOpened?.interaction.prompt).toBe("第二次选择：");

    // 快进零生成：D3 表单重放不经过任何内容生成（后继剧情直接来自既有边
    // 负载）。generateBranchPrefetch 是表单呈现的固定环境成本（每个重放表单
    // 每选项一次），与快进选择本身无关——零生成断言落在内容生成上。
    await vi.waitFor(() => expect(controller2.count("interaction_opened")).toBe(3));
    expect(gen2.generateOpening).not.toHaveBeenCalled();
    expect(gen2.generateContinuation).not.toHaveBeenCalled();
    // 快进落点：游标前移到既有后继 D3。
    expect((await store2.loadCursor())?.position).toBe(decisions[2]!.id);

    // 记账：run1 弃局于 D3；新 retrace run 从 D2 开启；图零删除。
    const runs = await store2.listRuns();
    expect(runs[0]?.abandonedAt).toBe(decisions[2]!.id);
    expect(runs.at(-1)?.origin).toEqual({ kind: "retrace", from: d2 });
    expect(await store2.listDecisions()).toHaveLength(3);
    expect(await store2.listEdges()).toHaveLength(2);
    game2.dispatch({ type: "shutdown" });
    await expect(run2b).rejects.toThrow("运行时已收到关闭指令");
  });
});

// ---------------------------------------------------------------------------
// Input preview cancellation
// ---------------------------------------------------------------------------
