/**
 * ActorBriefing 防火墙测试（执行清单 M4.2 验收）：
 * - 结构性防火墙：输入类型不含 outline 全量/结局候选/他周目数据；
 * - 生成请求 user prompt 的负面断言（未实现 outline purpose / 结局候选
 *   文本不出现在 prompt 中）；
 * - 有 directive 时含防守/收束段；无 directive 时与现行为等价。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildActorBriefing } from "./actor-briefing.js";
import { DirectorService } from "./director-service.js";
import type { AgentRunnerPort } from "../../core/ports/agent-runner-port.js";
import { GameGraphStore } from "../../adapters/storage/game-graph-store.js";
import type { GraphStorePort } from "../../core/ports/graph-store-port.js";
import type { MemoryProjection } from "../../core/narrative/memory-projection.js";
import { buildDslUserPrompt } from "../../story/context-builder.js";
import { createInitialState } from "../../story/state.js";
import type { DslContextInput } from "../../story/context-builder.js";
import type { StoryState } from "../../story/types.js";

function makeBriefingCtx(briefing?: string): DslContextInput {
  const state: StoryState = createInitialState({
    scene: { id: "scene_1", location: "旧校舍", purpose: "调查终端" },
  });
  const ctx: DslContextInput = {
    prompts: {
      characters: "【苏遥】转学生。",
      storyLine: "STORY_LINE_WITH_OLD_GLOBAL_TEXT",
      guideline: "guideline",
      dslProtocol: "dsl-protocol",
    },
    state,
    recentEvents: [],
    taskType: "continuation",
    generationNonce: "n-1",
    targetLines: 6,
    ...(briefing !== undefined ? { actorBriefing: briefing } : {}),
  } as DslContextInput;
  return ctx;
}

function makeBriefWithSections(): MemoryProjection {
  return {
    revision: 1,
    consolidatedThroughEventSeq: 5,
    currentEventSeq: 8,
    checkpointCount: 2,
    location: "旧校舍",
    characters: ["苏遥"],
    activeThreads: [],
    setupDirectives: [],
    relevantEpisodes: [],
    anchors: [],
    relatedFacts: [
      { id: "fact_1", content: "终端会对苏遥的指纹反应", evidenceEventSeqs: [1], checkpoint: 1, superseded: false },
    ],
    characterBeliefs: [
      { id: "belief_1", characterId: "苏遥", content: "苏遥相信终端是坏的", status: "active", createdAtCheckpoint: 1, origin: "believe" },
    ],
    avoidanceLessons: [
      { id: "lesson_1", tag: "setup-flow", content: "没有回收计划的伏笔不许下场", source: "rejection", occurrences: 2, active: true, createdAtCheckpoint: 1 },
    ],
  };
}

describe("buildActorBriefing", () => {
  it("renders directive sections (defense beats + ending pressure + form modes)", () => {
    const text = buildActorBriefing({
      directive: {
        sceneId: "scene_1",
        sceneGoal: "查清终端来历",
        defenseBeats: ["玩家试图离校时引回终端线索"],
        endingPressure: true,
        formModes: ["choice"],
      },
    });
    expect(text).toContain("[场景指令]");
    expect(text).toContain("目标：查清终端来历");
    expect(text).toContain("防守：玩家试图离校时引回终端线索");
    expect(text).toContain("收束：剧情接近终章");
    expect(text).toContain("表单模式收窄：choice");
  });

  it("renders memory projection sections (facts/beliefs/lessons) via memoryBrief", () => {
    const text = buildActorBriefing({
      memoryBrief: makeBriefWithSections(),
    });
    expect(text).toContain("[相关既定事实]");
    expect(text).toContain("终端会对苏遥的指纹反应");
    expect(text).toContain("[角色认知]");
    expect(text).toContain("[规避清单]");
  });

  it("returns an empty string when there is nothing to brief (regression equivalence)", () => {
    expect(buildActorBriefing({})).toBe("");
    // 空 briefing 时 prompt 与「无便签」旧行为完全一致
    const withEmpty = buildDslUserPrompt(4, makeBriefingCtx(""));
    const without = buildDslUserPrompt(4, makeBriefingCtx(undefined));
    expect(withEmpty).toBe(without);
    expect(without).not.toContain("[场景指令]");
  });

  it("firewall: user prompt never contains unimplemented outline purposes or ending candidates", () => {
    // 未实现大纲的 purpose / 结局候选文本 —— 这些数据在 ActorBriefingInput
    // 类型上不存在；此处以「即便调用方持有也进不了剪报」的方式验证：
    // buildActorBriefing 的输出只可能来自其输入字段。
    const outlineSecret = "结局候选：主角黑化毁灭学园（未实现大纲 purpose）";
    const directive = buildActorBriefing({
      directive: {
        sceneId: "scene_1",
        sceneGoal: "调查旧校舍的终端",
        defenseBeats: [],
        endingPressure: false,
      },
    });
    expect(directive).not.toContain(outlineSecret);
    const prompt = buildDslUserPrompt(4, makeBriefingCtx(directive));
    expect(prompt).not.toContain(outlineSecret);
    expect(prompt).toContain("调查旧校舍的终端");
  });

  it("M1：canon 全量（世界真相/他周目知识）不进演员剪报——受控参数边界保持", () => {
    // M1 起角色名册/canon 由 roster 真源提供，但演员侧输入形状不变：
    // ActorBriefingInput 上不存在 canon/roster 字段，结构上无法注入全量
    // canon（含结局候选、晋升事实、他周目知识）。
    const canonSecret = "canon 晋升事实：旧终端通往平行世界（第 3 周目证据）";
    const briefing = buildActorBriefing({
      memoryBrief: makeBriefWithSections(),
      rawEventCount: 8,
      directive: {
        sceneId: "scene_1",
        sceneGoal: "调查旧校舍的终端",
        defenseBeats: [],
        endingPressure: false,
      },
    });
    expect(briefing).not.toContain(canonSecret);
    expect(briefing).not.toContain("worldSetting");
    const prompt = buildDslUserPrompt(4, makeBriefingCtx(briefing));
    expect(prompt).not.toContain(canonSecret);
  });
});

// ---------------------------------------------------------------------------
// M2 §5.2 负向快照：导演持有大纲/canon/他周目数据的完整视图，但演员剪报
// （MemoryProjection + SceneDirective）只输出方向性指令——结局候选文本、
// 大纲全量 purpose、canon 秘密、已弃周目剧情绝不出现在演员 prompt。
// ---------------------------------------------------------------------------

describe("actor briefing firewall — negative snapshots against a real DirectorService", () => {
  let root: string;
  let store: GameGraphStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "actor-leak-"));
    store = new GameGraphStore(root, "game_actor_leak_test");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 结局候选/大纲/canon/他周目里的秘密文本（出现即算泄露）。 */
  const ENDING_SECRET = "结局候选A：主角黑化毁灭学园（未实现大纲 purpose）";
  const CANON_SECRET = "canon 晋升事实：旧终端通往平行世界（第 3 周目证据）";
  const PRIOR_RUN_SECRET = "已弃周目：上一轮回里苏遥已经死过一次";

  function makeOutlineWithSecrets() {
    return {
      getOutline: () => ({
        revision: 1,
        nodes: [
          { id: "act_1", kind: "act" as const, status: "realized" as const, purpose: "第一章" },
          { id: "act_2", kind: "act" as const, status: "realized" as const, purpose: "第二章" },
          { id: "ending_a", kind: "ending" as const, status: "planned" as const, purpose: ENDING_SECRET },
          { id: "ending_b", kind: "ending" as const, status: "planned" as const, purpose: "结局候选B：全员生还" },
        ],
      }),
      load: vi.fn(async () => ({ revision: 1, nodes: [] })),
      applyRevision: vi.fn(async () => 2),
    };
  }

  function makeCanonWithSecrets() {
    return {
      getCanon: () => ({
        revision: 1,
        worldSetting: "",
        characters: [],
        promotedFacts: [
          {
            id: "canon_1",
            content: CANON_SECRET,
            evidenceRuns: ["run_2", "run_3"],
            judgedBy: "canon-adjudicator",
            promotedAt: "2026-09-18T00:00:00.000Z",
          },
        ],
        exceptions: [],
      }),
      load: vi.fn(async () => ({ revision: 1, worldSetting: "", characters: [], promotedFacts: [], exceptions: [] })),
      saveScaffold: vi.fn(),
      applyPromotion: vi.fn(async () => 2),
    };
  }

  it("ending candidates, canon secrets, and prior-run history never leak into the actor briefing", async () => {
    // 种子：一段已弃周目的「旧校舍」已实现剧情（决策节点 + 边负载）。
    // readSceneHistory 的回放投影会渲染出 PRIOR_RUN_SECRET，使「跨周目
    // 秘密不进演员剪报」的负向断言真实可失败（非空洞）。用最小
    // GraphStorePort 假件直供 readSceneHistory 消费的三项数据面——不落
    // 真实快照文件（快照契约版本归图泳道，这里不与其 schema 演进耦合）。
    const priorRunEvent = {
      seq: 1,
      turn: 1,
      timestamp: "2026-09-01T00:00:00.000Z",
      source: "model",
      type: "narration",
      text: PRIOR_RUN_SECRET,
      line_id: "prior-line-1",
    } as unknown as import("../../schema.js").StoredEvent;
    const priorRunStore = {
      location: "fake-prior-run-store",
      listDecisions: async () => [
        {
          id: "dc_prior_1",
          sceneId: "sc_prior",
          form: { mode: "choice", prompt: "上一周目的选择" },
          entryState: {
            storyState: createInitialState({
              scene: { id: "旧校舍", location: "旧校舍", purpose: "上一周目的旧校舍" },
            }),
          },
        },
      ],
      listEdges: async () => [
        {
          id: "eg_prior_1",
          from: "dc_prior_1",
          to: { kind: "ending", id: "end_prior" },
          choice: { kind: "option", text: "追问终端的来历" },
          payload: { eventCount: 1, firstSeq: 1, lastSeq: 1 },
        },
      ],
      readPayload: async () => [priorRunEvent],
    } as unknown as GraphStorePort;

    // 导演侧可见的全量数据：结局候选（大纲）、canon 晋升事实（跨周目）、
    // 已弃周目场景史（readSceneHistory 工具回放）。
    let sceneHistory = "";
    const runner = {
      runLoop: vi.fn(async (request: {
        user: string;
        tools: Array<{ name: string }>;
        executeTool: (name: string, args: string) => Promise<string>;
      }) => {
        // 导演的工具循环确实读到了已弃周目剧情（D7：含已弃周目——导演
        // 取材来源；秘密文本从这里只进导演侧）。
        sceneHistory = await request.executeTool(
          "readSceneHistory",
          JSON.stringify({ sceneId: "旧校舍" }),
        );
        return {
          text: JSON.stringify({
            sceneGoal: "查清终端来历",
            defenseBeats: [],
            endingPressure: false,
          }),
        };
      }),
    };
    const director = new DirectorService({
      runner: runner as unknown as AgentRunnerPort,
      store: priorRunStore,
      outline: makeOutlineWithSecrets(),
      canon: makeCanonWithSecrets(),
    });
    const directive = await director.refreshDirective({
      sceneId: "旧校舍",
      scenePurpose: "调查终端",
      recentSummary: "玩家进入旧校舍。",
      cast: ["suyao"],
    });

    // 对照组（导演可见）：工具回放确实包含跨周目秘密——否则下面的
    // 「不进剪报」断言是空洞的。
    expect(sceneHistory).toContain(PRIOR_RUN_SECRET);

    // SceneDirective 只有方向性指令：endingPressure 是布尔，不是候选文本。
    const briefing = buildActorBriefing({
      memoryBrief: makeBriefWithSections(),
      rawEventCount: 8,
      directive,
    });
    expect(briefing).not.toContain(ENDING_SECRET);
    expect(briefing).not.toContain("结局候选");
    expect(briefing).not.toContain(CANON_SECRET);
    expect(briefing).not.toContain(PRIOR_RUN_SECRET);
    expect(briefing).toContain("[场景指令]");

    // 演员侧最终 prompt（buildDslUserPrompt 渲染）同样干净。
    const prompt = buildDslUserPrompt(4, makeBriefingCtx(briefing));
    expect(prompt).not.toContain(ENDING_SECRET);
    expect(prompt).not.toContain(CANON_SECRET);
    expect(prompt).not.toContain(PRIOR_RUN_SECRET);
  });

  it("the director's own prompt DOES see canon (director-visible): the firewall is the briefing boundary", async () => {
    const runner = {
      runLoop: vi.fn(async (_request: { user: string }) => ({
        text: JSON.stringify({ sceneGoal: "x", defenseBeats: [], endingPressure: false }),
      })),
    };
    const director = new DirectorService({
      runner: runner as unknown as AgentRunnerPort,
      store,
      canon: makeCanonWithSecrets(),
    });
    await director.refreshDirective({
      sceneId: "旧校舍",
      scenePurpose: "调查",
      recentSummary: "",
      cast: ["suyao"],
    });
    const directorUser = (runner.runLoop.mock.calls[0]?.[0] as { user: string }).user;
    // 对照组：导演输入含 canon 秘密（导演可见），剪报边界才是防火墙位置。
    expect(directorUser).toContain(CANON_SECRET);
  });

  it("ending-candidate control: the director consumes the outline only as a boolean endingPressure signal", async () => {
    // 对照组（结局候选的导演可见通道）：大纲 activate 结局候选 → 导演
    // directive 的 endingPressure=true（布尔信号）。演员剪报里它是方向性
    // 指令「收束」一行——结局候选文本/其余候选永不到场。
    const activeNodes: Array<{
      id: string;
      kind: "act" | "ending";
      status: "planned" | "active" | "realized" | "pruned";
      purpose: string;
    }> = [
      { id: "act_1", kind: "act", status: "realized", purpose: "第一章" },
      { id: "ending_a", kind: "ending", status: "active", purpose: ENDING_SECRET },
    ];
    const outline = {
      getOutline: () => ({ revision: 1, nodes: activeNodes }),
      load: vi.fn(async () => ({ revision: 1, nodes: [] })),
      applyRevision: vi.fn(async () => 2),
    };
    const runner = {
      runLoop: vi.fn(async (_request: { user: string }) => ({
        text: JSON.stringify({ sceneGoal: "x", defenseBeats: [], endingPressure: false }),
      })),
    };
    const director = new DirectorService({
      runner: runner as unknown as AgentRunnerPort,
      store,
      outline,
    });
    const directive = await director.refreshDirective({
      sceneId: "旧校舍",
      scenePurpose: "调查",
      recentSummary: "",
      cast: ["suyao"],
    });
    // 导演确实消费了大纲（模型说 false，大纲信号覆盖为 true）。
    expect(directive.endingPressure).toBe(true);
    // 演员只见方向性指令：一行「收束」，没有候选文本。
    const briefing = buildActorBriefing({ directive });
    expect(briefing).toContain("收束：剧情接近终章");
    expect(briefing).not.toContain(ENDING_SECRET);
    expect(briefing).not.toContain("结局候选");
  });
});
