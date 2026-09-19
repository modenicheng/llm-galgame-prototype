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
import { buildCharacterRoster, createCharacterRegistry } from "./core/characters/registry.js";
import type { AssetCatalog } from "./core/assets/types.js";
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
  triggerDirective: (input: { sceneId: string; scenePurpose: string; recentSummary: string }) => void;
  getDirective: (sceneId: string) => SceneDirective | undefined;
  narrowFormModes: (sceneId: string, modes: Array<"choice" | "input" | "hybrid">) => void;
  evaluateFreeInput: ReturnType<typeof vi.fn>;
  seedDirective: (sceneId: string, directive: SceneDirective) => void;
}

function makeDirectorStub(): DirectorStub {
  const directives = new Map<string, SceneDirective>();
  return {
    triggerDirective: () => {},
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

  it("M2 §6.2：导演场景名单 = 显式会话 roster NPC（稳定 ID），不是累计 state.keys 重建", async () => {
    const { config, status, media, generator } = makeGameInputs();
    const director = makeDirectorStub();
    const triggerSpy = vi.fn(director.triggerDirective);
    director.triggerDirective = triggerSpy as DirectorStub["triggerDirective"];
    // roster：玩家 + 两个有立绘 NPC + 一个无立绘电话角色（guest_01 全程
    // 不说话——state.characters 里不会有它，roster 里有它）。
    const registry = createCharacterRegistry(
      buildCharacterRoster({
        schemaVersion: 2,
        scopeId: "m2-director-cast",
        playerId: "player_one",
        characters: [
          { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
          { id: "suyao", name: "苏遥", control: "npc", initialLabel: "苏遥", persona: "同班同学。" },
          { id: "linche", name: "林澈", control: "npc", initialLabel: "林澈", persona: "同屋。" },
          { id: "guest_01", name: "来电者", control: "npc", initialLabel: "？？？", persona: "电话那头。" },
        ],
      }),
      {
        guidance: "",
        backgrounds: {},
        bgm: {},
        soundEffects: {},
        spriteSets: {},
      } as AssetCatalog,
    );
    const ports = makeTestPorts({
      director: director as unknown as SceneDirectorPort,
      ...(registry !== undefined ? { characterRegistry: registry } : {}),
    });

    (generator.generateOpening as ReturnType<typeof vi.fn>).mockImplementation(() =>
      handleFromDrafts("opening", [narrationEvent("开场。"), endEvent("end_1", "Fin.")]),
    );

    const game = new Game(config, generator, status, media, undefined, ports);
    const controller = new MemoryController();
    controller.attach(game);
    await expect(game.run()).resolves.toBeUndefined();

    expect(triggerSpy).toHaveBeenCalled();
    const cast = (triggerDirectiveCastOf(triggerSpy));
    // 全体 roster NPC 的稳定 ID（含从未说话的无立绘电话角色）。
    expect(cast).toEqual(["suyao", "linche", "guest_01"]);
    // 玩家由运行时代言，不进模型 voice 指导名单；显示名绝不出现。
    expect(cast).not.toContain("player_one");
    expect(cast.some((id) => id === "苏遥" || id === "林澈")).toBe(false);
  });
});

/** 从 triggerDirective 间谍调用里取 cast 数组（缺省 = 空名单）。 */
function triggerDirectiveCastOf(
  spy: ReturnType<typeof vi.fn>,
): string[] {
  const first = spy.mock.calls[0] as
    | [{ cast?: string[] }]
    | undefined;
  return first?.[0]?.cast ?? [];
}
