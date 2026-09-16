/**
 * DirectorService tests（执行清单 M4.1 验收）：工具被调、directive 落缓存、
 * 汇流判定承接（exposeConfluenceJudge）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameGraphStore } from "../../adapters/storage/game-graph-store.js";
import { DirectorService } from "./director-service.js";
import type { AgentRunnerPort } from "../../core/ports/agent-runner-port.js";
import type { ConfluenceJudgePort } from "../../core/ports/confluence-judge-port.js";

function makeRunner(overrides?: Partial<Parameters<typeof Object>>) {
  return {
    runLoop: vi.fn(async (request: {
      tools: Array<{ name: string }>;
      executeTool: (name: string, args: string) => Promise<string>;
    }) => {
      // 模拟模型行为：调一次 readSceneHistory + narrowFormModes，再给最终文本
      const history = await request.executeTool(
        "readSceneHistory",
        JSON.stringify({ sceneId: "旧校舍" }),
      );
      await request.executeTool(
        "narrowFormModes",
        JSON.stringify({ modes: ["choice", "hybrid"] }),
      );
      return {
        text:
          history.length > 0
            ? '{"sceneGoal":"查清终端来历","defenseBeats":["阻止玩家离题"],"endingPressure":false}'
            : "{}",
      };
    }),
  };
}

describe("DirectorService", () => {
  let root: string;
  let store: GameGraphStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "director-svc-"));
    store = new GameGraphStore(root, "game_director_test");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs the tools, caches the directive, and narrows form modes", async () => {
    const runner = makeRunner();
    const service = new DirectorService({
      runner: runner as unknown as AgentRunnerPort,
      store,
    });

    const directive = await service.refreshDirective({
      sceneId: "旧校舍",
      scenePurpose: "调查终端",
      recentSummary: "玩家进入旧校舍。",
    });

    expect(runner.runLoop).toHaveBeenCalledOnce();
    expect(directive.sceneGoal).toBe("查清终端来历");
    expect(directive.defenseBeats).toEqual(["阻止玩家离题"]);
    expect(directive.endingPressure).toBe(false);
    // narrowFormModes 工具的结果落在缓存（相位门）
    expect(service.getDirective("旧校舍")?.formModes).toEqual(["choice", "hybrid"]);
  });

  it("falls back to an empty directive when the model gives no JSON", async () => {
    const runner = {
      runLoop: vi.fn(async () => ({ text: "（没有 JSON 的普通文本）" })),
    };
    const service = new DirectorService({
      runner: runner as unknown as AgentRunnerPort,
      store,
    });
    const directive = await service.refreshDirective({
      sceneId: "教室",
      scenePurpose: "日常",
      recentSummary: "",
    });
    expect(directive.sceneGoal).toBeUndefined();
    expect(directive.defenseBeats).toEqual([]);
  });

  it("exposes the confluence judge it owns (M4.1 ④ handoff)", () => {
    const judge = { judge: vi.fn() } as unknown as ConfluenceJudgePort;
    const service = new DirectorService({
      runner: makeRunner() as unknown as AgentRunnerPort,
      store,
      judge,
    });
    expect(service.exposeConfluenceJudge()).toBe(judge);
    const noJudge = new DirectorService({
      runner: makeRunner() as unknown as AgentRunnerPort,
      store,
    });
    expect(noJudge.exposeConfluenceJudge()).toBeUndefined();
  });
});
