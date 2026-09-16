/**
 * M4.3 防守节拍集成测试：free_input 触发导演评估（滞后一拍——引回进下一段
 * 剪报）；choice 不触发；相位门 formModes 收窄生效（policy 层见
 * interaction-policy.test.ts）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { StoryGeneratorPort } from "./core/ports/story-generator-port.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import { RuntimeStatus } from "./runtime/status.js";
import { Game } from "./game.js";
import {
  makeGameConfig,
  makeMockGenerator,
  makeMockMedia,
  makeMockStatus,
  handleFromDrafts,
  narrationEvent,
  inputInteractionFixture,
  choiceFixture,
  endEvent,
} from "./game-test-kit.js";
import type { SceneDirective, SceneDirectorPort } from "./application/director/director-service.js";
import { MemoryController, makeTestPorts } from "./test-helpers.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "defense-beat-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeConfig(): AppConfig {
  return makeGameConfig();
}

function makeGameInputs() {
  const config = makeConfig();
  const status = makeMockStatus();
  const media = makeMockMedia() as MediaPlannerPort;
  const generator = makeMockGenerator() as StoryGeneratorPort;
  return { config, status, media, generator };
}


interface DirectorStub {
  getDirective: (sceneId: string) => SceneDirective | undefined;
  narrowFormModes: (sceneId: string, modes: Array<"choice" | "input" | "hybrid">) => void;
  evaluateFreeInput: ReturnType<typeof vi.fn>;
  seedDirective: (sceneId: string, directive: SceneDirective) => void;
}

function makeDirectorStub(): DirectorStub {
  const directives = new Map<string, SceneDirective>();
  return {
    getDirective: (sceneId) => directives.get(sceneId),
    narrowFormModes: (sceneId, modes) => {
      directives.set(sceneId, {
        ...(directives.get(sceneId) ?? { sceneId, defenseBeats: [], endingPressure: false }),
        formModes: modes,
      });
    },
    evaluateFreeInput: vi.fn(async (input: { sceneId: string; playerInput: string }) => {
      const beat = `引回：把「${input.playerInput}」拉回终端线索`;
      const d: SceneDirective = directives.get(input.sceneId) ?? {
        sceneId: input.sceneId,
        defenseBeats: [],
        endingPressure: false,
      };
      d.defenseBeats = [...d.defenseBeats, beat];
      directives.set(input.sceneId, d);
      return beat;
    }),
    seedDirective: (sceneId, directive) => directives.set(sceneId, directive),
  };
}

describe("M4.3 防守节拍"
, () => {
  it("free_input triggers defense evaluation; the beat reaches the next briefing", async () => {
    const { config, status, media, generator } = makeGameInputs();
    const director = makeDirectorStub();
    const ports = makeTestPorts({ director: director as unknown as SceneDirectorPort });

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), inputInteractionFixture()]),
    );
    (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("input", [narrationEvent("回应。")]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, ports);
    const controller = new MemoryController({
      onInteractionOpened: (output) => controller.submitInput(output.interactionId, "我要飞上月球"),
      onInputPreviewOpened: (output) => controller.confirm(output.previewId),
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    // free_input 解决 → 导演评估被触发（滞后一拍：评估与生成并行）
    expect(director.evaluateFreeInput).toHaveBeenCalledWith(
      expect.objectContaining({ playerInput: "我要飞上月球" }),
    );
    // 引回指令进入下一段剪报（continuation 的 briefing）
    const briefings = (generator.generateContinuation as ReturnType<typeof vi.fn>)
      .mock.calls
      .map((call) => (call[0] as { briefing?: string }).briefing ?? "");
    expect(briefings.some((b) => b.includes("引回：把「我要飞上月球」拉回终端线索"))).toBe(true);
  });

  it("choice does not trigger defense evaluation", async () => {
    const { config, status, media, generator } = makeGameInputs();
    const director = makeDirectorStub();
    const ports = makeTestPorts({ director: director as unknown as SceneDirectorPort });

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [
        narrationEvent("开场。"),
        choiceFixture(),
      ]),
    );
    (generator.generateContinuation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("continuation", [narrationEvent("结尾。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, ports);
    const controller = new MemoryController({
      onInteractionOpened: (output) => {
        controller.select(
          output.interactionId,
          (output.interaction as unknown as { options: Array<{ id: string }> }).options[0]!.id,
        );
      },
    });
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(director.evaluateFreeInput).not.toHaveBeenCalled();
  });
});
