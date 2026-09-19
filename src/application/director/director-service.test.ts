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

  describe("canon input (M3.6 ③)", () => {
    function makeCanon(canon: {
      promotedFacts: Array<{ id: string; content: string; evidenceRuns: string[]; judgedBy: string; promotedAt: string }>;
      exceptions: Array<{ id: string; content: string; reason: string; compensatingLimit: string }>;
    }) {
      return {
        getCanon: () => ({ revision: 1, worldSetting: "", characters: [], ...canon }),
        load: vi.fn(async () => ({ revision: 1, worldSetting: "", characters: [], ...canon })),
        saveScaffold: vi.fn(),
        applyPromotion: vi.fn(async () => 2),
      };
    }

    it("carries promoted facts into the director prompt (directors see canon)", async () => {
      const canonStore = makeCanon({
        promotedFacts: [
          {
            id: "canon_1",
            content: "旧终端连通着废弃的广播站。",
            evidenceRuns: ["run_a", "run_b"],
            judgedBy: "canon-adjudicator",
            promotedAt: "2026-09-17T00:00:00.000Z",
          },
        ],
        exceptions: [
          {
            id: "exc_1",
            content: "苏遥记得前世。",
            reason: "矛盾",
            compensatingLimit: "仅限终章梦境段",
          },
        ],
      });
      const runner = makeRunner();
      const service = new DirectorService({
        runner: runner as unknown as AgentRunnerPort,
        store,
        canon: canonStore,
      });
      await service.refreshDirective({
        sceneId: "旧校舍",
        scenePurpose: "调查",
        recentSummary: "",
      });
      const userArg = (runner.runLoop.mock.calls[0]![0] as unknown as { user: string }).user;
      expect(userArg).toContain("世界既定（canon）");
      expect(userArg).toContain("旧终端连通着废弃的广播站。");
      expect(userArg).toContain("例外：苏遥记得前世。（限制：仅限终章梦境段）");
    });

    it("omits the canon section when nothing was promoted", async () => {
      const canonStore = makeCanon({ promotedFacts: [], exceptions: [] });
      const runner = makeRunner();
      const service = new DirectorService({
        runner: runner as unknown as AgentRunnerPort,
        store,
        canon: canonStore,
      });
      await service.refreshDirective({
        sceneId: "教室",
        scenePurpose: "日常",
        recentSummary: "",
      });
      const userArg = (runner.runLoop.mock.calls[0]![0] as unknown as { user: string }).user;
      expect(userArg).not.toContain("canon");
    });
  });

  describe("outline-derived ending pressure (M3.5 ①)", () => {
    type Node = ReturnType<typeof makeOutlineNode>;
    function makeOutlineNode(
      id: string,
      kind: "act" | "ending",
      status: "planned" | "active" | "realized" | "pruned",
    ) {
      return { id, kind, status, purpose: `${kind} ${id}` };
    }
    function makeOutline(nodes: Node[]) {
      return {
        getOutline: () => ({ nodes, revision: 1 }),
        load: vi.fn(async () => ({ nodes, revision: 1 })),
        applyRevision: vi.fn(async () => 2),
      };
    }

    it("forces endingPressure when every frontier act is realized (model said false)", async () => {
      const outline = makeOutline([
        makeOutlineNode("act_1", "act", "realized"),
        makeOutlineNode("act_2", "act", "realized"),
        makeOutlineNode("act_3", "act", "pruned"),
        makeOutlineNode("ending_a", "ending", "planned"),
      ]);
      const service = new DirectorService({
        runner: makeRunner() as unknown as AgentRunnerPort,
        store,
        outline,
      });
      const directive = await service.refreshDirective({
        sceneId: "天台",
        scenePurpose: "终章前夜",
        recentSummary: "所有主线场景已演完。",
      });
      expect(directive.endingPressure).toBe(true);
    });

    it("forces endingPressure when maintenance activated an ending candidate", async () => {
      const outline = makeOutline([
        makeOutlineNode("act_1", "act", "active"),
        makeOutlineNode("ending_a", "ending", "active"),
      ]);
      const service = new DirectorService({
        runner: makeRunner() as unknown as AgentRunnerPort,
        store,
        outline,
      });
      const directive = await service.refreshDirective({
        sceneId: "旧校舍",
        scenePurpose: "进入终章",
        recentSummary: "",
      });
      expect(directive.endingPressure).toBe(true);
    });

    it("keeps the model verdict when the outline is still mid-story", async () => {
      const outline = makeOutline([
        makeOutlineNode("act_1", "act", "realized"),
        makeOutlineNode("act_2", "act", "active"),
        makeOutlineNode("ending_a", "ending", "planned"),
      ]);
      const service = new DirectorService({
        runner: makeRunner() as unknown as AgentRunnerPort,
        store,
        outline,
      });
      const directive = await service.refreshDirective({
        sceneId: "教室",
        scenePurpose: "日常",
        recentSummary: "",
      });
      expect(directive.endingPressure).toBe(false);
    });

    it("degrades to false (with a warning) when the outline is not loaded yet", async () => {
      const outline = {
        getOutline: () => {
          throw new Error("OutlineStore.getOutline() called before load");
        },
        load: vi.fn(async () => ({ nodes: [], revision: 0 })),
        applyRevision: vi.fn(async () => 1),
      };
      const service = new DirectorService({
        runner: makeRunner() as unknown as AgentRunnerPort,
        store,
        outline,
      });
      const directive = await service.refreshDirective({
        sceneId: "教室",
        scenePurpose: "日常",
        recentSummary: "",
      });
      // 导演不被大纲读取失败阻塞：directive 照常产出。
      expect(directive.sceneGoal).toBe("查清终端来历");
      expect(directive.endingPressure).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// voice 指导与音频调色板（角色音频特征设计 V1）
// ---------------------------------------------------------------------------

function makeVoiceRunner(payload: unknown) {
  return {
    runLoop: vi.fn(async (request: { system: string; user: string }) => ({
      text: JSON.stringify(payload),
      // 捕获 prompt 供调色板断言
      captured: request,
    })),
  };
}

describe("DirectorService — voice 指导与调色板", () => {
  let root: string;
  let store: GameGraphStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "director-voice-"));
    store = new GameGraphStore(root, "game_director_voice_test");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("parses the voice section into the directive, dropping invalid entries", async () => {
    const runner = makeVoiceRunner({
      sceneGoal: "夜谈",
      defenseBeats: [],
      endingPressure: false,
      voice: {
        苏遥: { delivery: "breathless", volume: "whisper", note: "  夜谈压低声音  ", pace: "mega" },
        旁白: { delivery: "screaming", note: 42 },
        林澈: "不是对象",
      },
    });
    const service = new DirectorService({
      runner: runner as unknown as AgentRunnerPort,
      store,
    });
    const directive = await service.refreshDirective({
      sceneId: "天台",
      scenePurpose: "夜谈",
      recentSummary: "",
    });
    expect(directive.voice).toEqual({
      苏遥: { delivery: "breathless", volume: "whisper", note: "夜谈压低声音" },
    });
    expect(service.getDirective("天台")?.voice).toEqual(directive.voice);
  });

  it("omits voice when the model gives none or only invalid targets", async () => {
    for (const payload of [
      { sceneGoal: "x", defenseBeats: [], endingPressure: false, voice: { 苏遥: { pace: 7 } } },
      { sceneGoal: "x", defenseBeats: [], endingPressure: false, voice: [1, 2] },
    ]) {
      const runner = makeVoiceRunner(payload);
      const service = new DirectorService({
        runner: runner as unknown as AgentRunnerPort,
        store,
      });
      const directive = await service.refreshDirective({
        sceneId: "教室",
        scenePurpose: "日常",
        recentSummary: "",
      });
      expect(directive.voice).toBeUndefined();
    }
  });

  it("M2 边界钉（R18）：voice 键目前宽松——显示名键可通过 parse，但工厂按稳定 ID 探测永不命中", async () => {
    // C7 只收紧了工厂侧（AudioDescriptorFactory 按稳定 characterId 查询
    // voiceDirectionFor）；parseVoiceDirections 仍接受任意键——显示名
    // 「苏遥」照常入库。该键对工厂是死数据：bootstrap 的探针是
    // directive.voice[characterId]，characterId=suyao 永远取不到「苏遥」
    // 键（不猜、不映射）。M2 将在导演侧收紧键校验（拒绝非 roster ID）；
    // 在此之前本测试钉住现状——不得静默加宽（让工厂开始按显示名寻址）
    // 或提前「修好」（丢弃非 ID 键）此边界，那都是 M2 的决定。
    const runner = makeVoiceRunner({
      sceneGoal: "夜谈",
      defenseBeats: [],
      endingPressure: false,
      voice: {
        苏遥: { volume: "whisper", note: "显示名键（M2 前宽松放行）" },
        suyao: { volume: "loud" },
      },
    });
    const service = new DirectorService({
      runner: runner as unknown as AgentRunnerPort,
      store,
    });
    const directive = await service.refreshDirective({
      sceneId: "天台",
      scenePurpose: "夜谈",
      recentSummary: "",
    });
    const voice = directive.voice!;
    // 宽松 parse 现状：两个键都原样保留（M2 收紧前）。
    expect(voice["苏遥"]).toEqual({ volume: "whisper", note: "显示名键（M2 前宽松放行）" });
    expect(voice.suyao).toEqual({ volume: "loud" });
    // 工厂探针语义（bootstrap：voiceDirectionHub.for = directive.voice[id]）：
    // 按稳定 characterId 查询——只命中 ID 键，显示名键不可达。
    const probe = (characterId: string) => voice[characterId];
    expect(probe("suyao")).toEqual({ volume: "loud" });
    expect(probe("suyao")).not.toBe(voice["苏遥"]);
  });

  it("renders the palette section for cast members with palette data", async () => {
    const runner = makeVoiceRunner({ sceneGoal: "x", defenseBeats: [], endingPressure: false });
    const service = new DirectorService({
      runner: runner as unknown as AgentRunnerPort,
      store,
      speakerPalette: (id) =>
        id === "苏遥"
          ? { allowedDelivery: ["gentle", "firm"], forbiddenDelivery: ["cold"] }
          : undefined,
    });
    await service.refreshDirective({
      sceneId: "教室",
      scenePurpose: "日常",
      recentSummary: "",
      cast: ["苏遥", "林澈"],
    });
    const user = (runner.runLoop.mock.calls[0]?.[0] as { user: string }).user;
    expect(user).toContain("===== 在场角色音频调色板 =====");
    expect(user).toContain("- 苏遥：语气可用 [gentle, firm]：忌用 [cold]");
    expect(user).not.toContain("林澈");
  });

  it("omits the palette section without a palette provider or cast", async () => {
    const runner = makeVoiceRunner({ sceneGoal: "x", defenseBeats: [], endingPressure: false });
    const service = new DirectorService({
      runner: runner as unknown as AgentRunnerPort,
      store,
    });
    await service.refreshDirective({
      sceneId: "教室",
      scenePurpose: "日常",
      recentSummary: "",
      cast: ["苏遥"],
    });
    let user = (runner.runLoop.mock.calls[0]?.[0] as { user: string }).user;
    expect(user).not.toContain("音频调色板");

    const paletteService = new DirectorService({
      runner: runner as unknown as AgentRunnerPort,
      store,
      speakerPalette: () => ({ allowedDelivery: ["gentle"] }),
    });
    await paletteService.refreshDirective({
      sceneId: "教室",
      scenePurpose: "日常",
      recentSummary: "",
    });
    user = (runner.runLoop.mock.calls[1]?.[0] as { user: string }).user;
    expect(user).not.toContain("音频调色板");
  });
});
