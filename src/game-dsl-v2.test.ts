/**
 * v2 runtime decode wiring（main-v2-adapter：dsl.protocol_version=2 的
 * 端到端解码/编译接线；port 自 campus a1b7aac/c41582e/cb7804b 的
 * game-dsl-v2.test.ts，适配 main 的图运行时 Game + M4.5 交互驱动）。
 *
 * 真实 StoryGenerator（mock OpenAI client 流式吐 v2 DSL 行）+ 真实 Game：
 * - knob=2 会话按 v2 解码（DslSegmentParserV2 v2 sink）→ 增量式段门
 *   （createV2SegmentGate，Ruling 16 逐组门控转发）→ 事件携带名牌快照
 *   （displayLabel → speaker）；
 * - @ch show/hide/exit 的预测舞台状态进入下一次请求的 tailVisualState；
 * - 预取分支的预测名牌状态按 branchCharacterStates 生命周期隔离/转正；
 * - v2 协议错误恰好触发一次尾部修复（生成器编排，边界 = 已提交前缀），
 *   双败走既有段失败路径（repairReason 修复续写）；
 * - knob 缺省仍为 1（无显式配置零行为变化），v1 会话与接线前逐字节
 *   一致（fixture 钉死——main 自己的场景，接线前 HEAD 89ef14e 录制）。
 */
import { describe, it, expect, vi } from "vitest";
import type { AppConfig } from "./config.js";
import { Game } from "./game.js";
import type { GamePorts } from "./game.js";
import {
  StoryGenerator,
  GeneratorPortFacade,
} from "./adapters/llm/openai-compatible-generator.js";
import { RuntimeStatus } from "./runtime/status.js";
import { makeTestConfig, makeTestPorts, MemoryController } from "./test-helpers.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import type { AssetCatalog } from "./core/assets/types.js";
import { buildCharacterRoster, createCharacterRegistry } from "./core/characters/registry.js";
import type { CharacterRegistry as RosterRegistry } from "./core/characters/types.js";
import type { StoryGeneratorPort } from "./core/ports/story-generator-port.js";
import type {
  BranchPrefetchRequest,
  ContinuationRequest,
  InputBridgeRequest,
  InputResponseRequest,
  OpeningRequest,
} from "./core/ports/story-generator-port.js";
import type { PromptBundle, InstructionSet } from "./prompts.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DUMMY_API_KEY = "sk-test-no-calls";

const V2_CATALOG: AssetCatalog = {
  guidance: "测试素材。",
  backgrounds: {
    corridor: { id: "corridor", src: "backgrounds/corridor.jpg", description: "走廊" },
  },
  bgm: {},
  soundEffects: {},
  spriteSets: {
    female_A: {
      id: "female_A",
      variants: {
        base: { id: "base", src: "characters/female_A/base.png", description: "" },
        smile: { id: "smile", src: "characters/female_A/smile.png", description: "" },
      },
    },
    female_B: {
      id: "female_B",
      variants: {
        base: { id: "base", src: "characters/female_B/base.png", description: "" },
      },
    },
  },
};

const V2_REGISTRY: RosterRegistry = createCharacterRegistry(
  buildCharacterRoster({
    schemaVersion: 2,
    scopeId: "v2-e2e",
    playerId: "player_one",
    characters: [
      { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
      {
        id: "female_A",
        name: "许晚晴",
        control: "npc",
        initialLabel: "神秘女子",
        persona: "温柔学姐。",
        presentation: {
          defaultLook: "base",
          defaultPosition: "right",
          looks: {
            base: { spriteSet: "female_A", variant: "base" },
            smile: { spriteSet: "female_A", variant: "smile" },
          },
        },
      },
      {
        id: "female_B",
        name: "林小满",
        control: "npc",
        initialLabel: "林小满",
        persona: "同级生。",
        presentation: {
          defaultLook: "base",
          defaultPosition: "left",
          looks: { base: { spriteSet: "female_B", variant: "base" } },
        },
      },
    ],
  }),
  V2_CATALOG,
);

function makeTestPrompts(): PromptBundle {
  return {
    characters: "角色A：勇敢的冒险者",
    storyLine: "第一章：夜色中的走廊。",
    guideline: "保持悬疑氛围。",
    dslProtocol: "你是互动视觉小说的编剧。输出行式 Gal DSL，不允许 JSON。",
  };
}

function makeTestInstructions(): InstructionSet {
  return {
    opening: "请从故事开场开始，生成完整开场剧情，直到第一个 choice、interaction 或 end。",
    branch_prefetch:
      "当前分支问题：{choice_prompt}\n假设玩家选择：{option_text}\n请只生成至少 {min_dialogue} 条 dialogue 的预取片段。",
    input_response: "当前交互点：{interaction_prompt}\n玩家输入：{player_input}\n请生成 NPC 回应。",
    continuation:
      "以下预取片段已固定：\n{prefetched}\n请继续生成完整剧情段。长度上限：本次最多输出 {target_lines} 条文本行。",
    input_bridge: "当前交互点：{interaction_prompt}\n生成 1–2 条 narration 作为场景过渡。",
    recovery: "上一次输出被拒绝：{repair_reason}。请修正后继续。",
  };
}

const mockMedia: MediaPlannerPort = {
  registerActive: vi.fn(),
  registerCandidate: vi.fn(),
  activateCandidate: vi.fn(),
  discardCandidate: vi.fn(),
  isReady: vi.fn().mockReturnValue(true),
  waitUntilReady: vi.fn().mockResolvedValue(undefined),
  markPresented: vi.fn(),
} as unknown as MediaPlannerPort;

function dslStream(lines: string[]): AsyncGenerator<unknown> {
  return (async function* () {
    for (const line of lines) {
      yield { choices: [{ delta: { content: `${line}\n` } }] };
    }
    yield { choices: [{ delta: {}, finish_reason: "stop" }] };
  })();
}

/** mock client 的一次调用记录。 */
interface MockCall {
  /** stream = 常规流式生成；repair = v2 尾部修复（非流式补写）。 */
  kind: "stream" | "repair";
  taskType: string;
  nonce: string;
  messages: Array<{ role: string; content: string }>;
}

interface Scenario {
  /** 常规流式生成：按任务类型（与分支选项文本）返回 v2 DSL 行。 */
  lines(taskType: string, nonce: string, user: string): string[];
  /** v2 尾部修复：返回重写后的尾部全文。 */
  repair(taskType: string, nonce: string): string;
}

interface Harness {
  game: Game;
  controller: MemoryController;
  calls: MockCall[];
  requests: {
    openings: OpeningRequest[];
    continuations: ContinuationRequest[];
    prefetches: BranchPrefetchRequest[];
    inputResponses: InputResponseRequest[];
    inputBridges: InputBridgeRequest[];
  };
}

function makeGame(scenario: Scenario, config: AppConfig): Harness {
  const generator = new StoryGenerator(
    config,
    makeTestPrompts(),
    makeTestInstructions(),
    DUMMY_API_KEY,
    undefined,
    undefined,
    V2_CATALOG,
    V2_REGISTRY,
  );

  const calls: MockCall[] = [];
  (generator as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: vi.fn(async (request: {
          stream?: boolean;
          messages: Array<{ role: string; content: string }>;
        }) => {
          const firstUser = request.messages
            .filter((message) => message.role === "user")[0]!.content;
          const taskType = /任务类型：([a-z_]+)/.exec(firstUser)?.[1] ?? "opening";
          const nonce = /生成段 nonce：([0-9a-f]{4})/.exec(firstUser)?.[1] ?? "aaaa";
          calls.push({
            kind: request.stream === false ? "repair" : "stream",
            taskType,
            nonce,
            messages: request.messages,
          });
          if (request.stream === false) {
            return {
              choices: [{ message: { content: scenario.repair(taskType, nonce) } }],
            };
          }
          return dslStream(scenario.lines(taskType, nonce, firstUser));
        }),
      },
    },
  };

  const facade = new GeneratorPortFacade(generator);
  const requests = {
    openings: [] as OpeningRequest[],
    continuations: [] as ContinuationRequest[],
    prefetches: [] as BranchPrefetchRequest[],
    inputResponses: [] as InputResponseRequest[],
    inputBridges: [] as InputBridgeRequest[],
  };
  const port: StoryGeneratorPort = {
    generateOpening(request) {
      requests.openings.push(request);
      return facade.generateOpening(request);
    },
    generateContinuation(request) {
      requests.continuations.push(request);
      return facade.generateContinuation(request);
    },
    generateBranchPrefetch(request) {
      requests.prefetches.push(request);
      return facade.generateBranchPrefetch(request);
    },
    generateInputResponse(request) {
      requests.inputResponses.push(request);
      return facade.generateInputResponse(request);
    },
    generateInputBridge(request) {
      requests.inputBridges.push(request);
      return facade.generateInputBridge(request);
    },
  };

  const ports: GamePorts = {
    ...makeTestPorts(),
    characterRegistry: V2_REGISTRY,
  };
  const game = new Game(config, port, new RuntimeStatus(), mockMedia, undefined, ports, V2_CATALOG);
  const controller = new MemoryController({
    onInteractionOpened: (output, ctrl) => {
      const options = (output.interaction as { options?: Array<{ id: string }> }).options;
      const first = options?.[0];
      if (first !== undefined) {
        ctrl.dispatch({
          type: "select_choice",
          interactionId: output.interactionId,
          optionId: first.id,
        });
      }
    },
  });
  controller.attach(game);
  return { game, controller, calls, requests };
}

function v2Config(overrides?: Parameters<typeof makeTestConfig>[0]): AppConfig {
  return makeTestConfig({
    dsl: { protocol_version: 2 },
    // 低水位 refill 关闭：续写只走显式路径，请求序列确定。
    text_buffer: { start_threshold_lines: 1, target_lines: 6, refill_threshold_lines: -1 },
    ...overrides,
  });
}

/** 分支选项文本（branch_prefetch 模板把 option JSON 序列化进 user prompt）。 */
function branchOptionTextOf(user: string): string | undefined {
  const raw = /假设玩家选择：(\{.*\})/.exec(user)?.[1];
  if (raw === undefined) return undefined;
  try {
    return (JSON.parse(raw) as { text?: string }).text;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// v2 端到端：解码、原子提交、名牌快照、预测状态
// ---------------------------------------------------------------------------

describe("v2 runtime decode — knob=2 session end-to-end", () => {
  it("decodes v2 lines, snapshots labels into events, and applies @ch stage effects", async () => {
    const harness = makeGame(
      {
        lines(taskType, nonce) {
          // 适配记录（Ruling 16 逐组转发）：branch_prefetch 是 buffer-only
          // 任务；旧场景给它的 `@end ending` 在批式门下会连已验证的 @say 组
          // 一并丢弃（组在整段门后才转发），逐组转发下该组会先行播出、
          // 再由续写复述——现让分支在第 1 行即哨兵违规（零提交组），
          // 保持本测试意图：分支失败 → 选中后走续写段（天亮了）。
          if (taskType === "branch_prefetch") {
            return [`@end ${nonce} ending`];
          }
          if (taskType !== "opening") {
            return ["@say female_A 天亮了。", `@end ${nonce} ending`, "@ending TE 尾声"];
          }
          return [
            "@n 教学楼的走廊尽头，灯还亮着一盏。",
            "@say female_A 你终于来了。",
            "@name female_A set 神秘学姐",
            "@say female_A 跟我来，别出声。",
            "@ch female_A show look=smile position=left",
            "@say female_A 快一点。",
            "@ch female_A exit",
            "@say female_A （她压低声音，退进了阴影里。）",
            "@? 接下来怎么做？",
            "@+ 跟着她走",
            "@+ 转身离开",
            "@/?",
            `@end ${nonce} interaction`,
          ];
        },
        repair() {
          return "";
        },
      },
      v2Config(),
    );

    await expect(harness.game.run()).resolves.toBeUndefined();

    // 请求身份：v2 旋钮贯穿所有请求。
    expect(harness.requests.openings[0]!.identity.protocolVersion).toBe(2);

    const dialogues = harness.controller
      .playbackEvents()
      .map((output) => output.event)
      .filter((event): event is Extract<typeof event, { type: "dialogue" }> =>
        event.type === "dialogue",
      );
    // 名牌快照（C4 §4.2）：@say 使用当时 label——改名前 initialLabel，
    // 改名后新 label；@ch show/exit 都不改名牌。第 5 句来自选中后的续写段
    // （label 已转正，仍是新名牌）。
    expect(dialogues.map((event) => event.speaker)).toEqual([
      "神秘女子",
      "神秘学姐",
      "神秘学姐",
      "神秘学姐",
      "神秘学姐",
    ]);
    expect(dialogues.every((event) => event.characterId === "female_A")).toBe(true);
    // @ch show 生效为该组的 prelude cue（画外对白无自动登台副作用）。
    expect(dialogues[2]!.stage).toMatchObject([
      {
        type: "character_patch",
        character: "female_A",
        spriteSet: { op: "set", value: "female_A" },
        variant: { op: "set", value: "smile" },
        position: { op: "set", value: "left" },
        visible: { op: "set", value: true },
      },
    ]);
    expect(dialogues[1]!.stage).toBeUndefined();
    // @ch exit（§4.2）：移除立绘条目，但名牌保留——退场后的画外对白仍用
    // 改名后的 label，其组前奏只携带 exit cue。
    expect(dialogues[3]).toMatchObject({
      type: "dialogue",
      text: "（她压低声音，退进了阴影里。）",
      speaker: "神秘学姐",
    });
    expect(dialogues[3]!.stage).toMatchObject([
      { type: "character_patch", character: "female_A", exit: true },
    ]);
    // exit 在播放位生效：该行播完的舞台投影不再包含 female_A（show 的
    // 那一行仍在）。
    const playbacks = harness.controller.playbackEvents();
    const afterExit = playbacks.find(
      (output) => output.event.type === "dialogue" && output.event.text.includes("退进了阴影"),
    );
    expect(afterExit).toBeDefined();
    expect(afterExit?.presentation?.visualState.characters.female_A).toBeUndefined();
    const afterShow = playbacks.find(
      (output) => output.event.type === "dialogue" && output.event.text === "快一点。",
    );
    expect(afterShow?.presentation?.visualState.characters.female_A).toMatchObject({
      variant: "smile",
      visible: true,
    });
    // 续写段的对白不带舞台 cue（画外对白），且名牌沿用转正后的预测状态。
    expect(dialogues[4]).toMatchObject({ text: "天亮了。", speaker: "神秘学姐" });
    expect(dialogues[4]!.stage).toBeUndefined();

    // 交互表单按 v2 语法解码并开局。
    const interactions = harness.controller.outputs.filter(
      (output) => output.type === "interaction_opened",
    );
    expect(interactions).toHaveLength(1);

    // 存档事件按序落盘（narration + 5 对白）。
    const stored = harness.game.events.filter(
      (event) => event.type === "dialogue" || event.type === "narration",
    );
    expect(stored.map((event) => event.type)).toEqual([
      "narration",
      "dialogue",
      "dialogue",
      "dialogue",
      "dialogue",
      "dialogue",
    ]);
    // 会话收束到结局。
    expect(harness.controller.ended()).toBe(true);
  });

  it("isolates prefetch branch label predictions and promotes only the selected branch", async () => {
    const harness = makeGame(
      {
        lines(taskType, nonce, user) {
          if (taskType === "opening") {
            return [
              "@say female_A 你必须选一个方向。",
              "@? 往哪边走？",
              "@+ 左边的走廊",
              "@+ 右边的楼梯",
              "@/?",
              `@end ${nonce} interaction`,
            ];
          }
          if (taskType === "branch_prefetch") {
            const option = branchOptionTextOf(user);
            if (option === "左边的走廊") {
              return [
                "@name female_A set 同路人",
                "@ch female_A show look=smile position=left",
                "@say female_A 分支甲第一句。",
                "@ch female_A hide",
                "@say female_A 分支甲第二句。",
                `@end ${nonce} buffer`,
              ];
            }
            return [
              "@name female_A set 擦肩者",
              "@say female_A 分支乙第一句。",
              "@say female_A 分支乙第二句。",
              `@end ${nonce} buffer`,
            ];
          }
          return ["@say female_A 天亮了。", `@end ${nonce} ending`, "@ending TE 尾声"];
        },
        repair() {
          return "";
        },
      },
      v2Config(),
    );

    await expect(harness.game.run()).resolves.toBeUndefined();

    // 预取请求各自拿到独立的 characterState 副本（C5 §5.1）。
    expect(harness.requests.prefetches.length).toBeGreaterThanOrEqual(2);
    const states = harness.requests.prefetches.map(
      (request) => request.identity.characterState,
    );
    for (let i = 1; i < states.length; i += 1) {
      expect(states[i]).not.toBe(states[0]);
    }

    // 选中分支（第一个选项）后：预测名牌转正、未选分支的预测被丢弃。
    const continuation = harness.requests.continuations.find(
      (request) => request.repairReason === undefined,
    );
    expect(continuation).toBeDefined();
    if (continuation === undefined) return;
    expect(continuation.identity.characterState.labels.female_A).toBe("同路人");
    expect(continuation.identity.characterState.labels.female_A).not.toBe("擦肩者");
    // 预测舞台状态：分支甲 show(smile/left) 后 hide → 仍在台上但不可见。
    expect(
      (continuation.tailVisualState as { characters: Record<string, { variant: string; visible: boolean }> })
        .characters.female_A,
    ).toMatchObject({ variant: "smile", visible: false });
    expect(harness.controller.ended()).toBe(true);
  });

  it("repairs a v2 protocol error with exactly one tail repair, then succeeds", async () => {
    const harness = makeGame(
      {
        lines(taskType, nonce) {
          if (taskType !== "opening") {
            return ["@say female_A 天亮了。", `@end ${nonce} ending`, "@ending TE 尾声"];
          }
          return [
            "@n 走廊的灯亮着。",
            // UNKNOWN_LOOK：坏 look 与下面的 @say 同组 → 组级原子失败。
            "@ch female_A show look=bad_look position=left",
            "@say female_A 你来了。",
            `@end ${nonce} ending`,
          ];
        },
        repair(_taskType, nonce) {
          return [
            "@ch female_A show look=smile position=left",
            "@say female_A 你来了。",
            `@end ${nonce} ending`,
          ].join("\n");
        },
      },
      v2Config(),
    );

    await expect(harness.game.run()).resolves.toBeUndefined();

    // 恰好一次尾部修复：opening 任务共 2 次 LLM 调用（原流 + 修复）。
    const openingCalls = harness.calls.filter((call) => call.taskType === "opening");
    expect(openingCalls).toHaveLength(2);
    expect(openingCalls[0]!.kind).toBe("stream");
    expect(openingCalls[1]!.kind).toBe("repair");
    // 修复调用携带已提交前缀（assistant）与修复指令（user，含 nonce）。
    const repairMessages = openingCalls[1]!.messages;
    expect(repairMessages.some((message) => message.role === "assistant")).toBe(true);
    expect(repairMessages.at(-1)!.content).toContain(openingCalls[1]!.nonce);
    // 修复后整段成功：旁白 + 对白（displayLabel = initialLabel）都播出。
    const dialogues = harness.controller
      .playbackEvents()
      .map((output) => output.event)
      .filter((event) => event.type === "dialogue");
    expect(dialogues).toHaveLength(1);
    expect(dialogues[0]).toMatchObject({ speaker: "神秘女子", text: "你来了。" });
    expect(harness.controller.ended()).toBe(true);
  });

  it("double-fault follows the existing segment-failure path (repairReason continuation)", async () => {
    const harness = makeGame(
      {
        lines(taskType, nonce) {
          if (taskType !== "opening") {
            return ["@say female_A 天亮了。", `@end ${nonce} ending`, "@ending TE 尾声"];
          }
          return [
            "@n 走廊的灯亮着。",
            "@ch female_A show look=bad_look position=left",
            "@say female_A 你来了。",
            `@end ${nonce} ending`,
          ];
        },
        // 修复轮仍然坏（double fault）：段失败，交给 Game 的修复续写。
        repair(_taskType, nonce) {
          return [
            "@ch female_A show look=still_bad position=left",
            "@say female_A 你来了。",
            `@end ${nonce} ending`,
          ].join("\n");
        },
      },
      v2Config(),
    );

    await expect(harness.game.run()).resolves.toBeUndefined();

    // 依然恰好一次尾部修复（第二次修复不再发生——双败即走失败路径）。
    const openingCalls = harness.calls.filter((call) => call.taskType === "opening");
    expect(openingCalls.filter((call) => call.kind === "repair")).toHaveLength(1);
    // 既有段失败路径接管：修复续写请求携带 repairReason（含诊断码）。
    const repair = harness.requests.continuations.find(
      (request) => request.repairReason !== undefined,
    );
    expect(repair).toBeDefined();
    if (repair === undefined) return;
    expect(repair.repairReason).toContain("UNKNOWN_LOOK");
    // 修复续写成功收束结局。
    expect(harness.controller.ended()).toBe(true);
  });

  it("keeps the default knob at 1 (no behavior change without explicit config)", async () => {
    const harness = makeGame(
      {
        lines(_taskType, nonce) {
          // v1 语法（裸旁白行）在默认 v1 会话下正常解码。
          return ["开场旁白第一句。", "开场旁白第二句。", `@end ${nonce} ending`];
        },
        repair() {
          return "";
        },
      },
      // 不携带 dsl 覆盖 → zod 缺省 protocol_version = 1。
      makeTestConfig({
        text_buffer: { start_threshold_lines: 1, target_lines: 6, refill_threshold_lines: -1 },
      }),
    );

    await expect(harness.game.run()).resolves.toBeUndefined();
    expect(harness.requests.openings[0]!.identity.protocolVersion).toBe(1);
    expect(harness.controller.countPlayback("narration")).toBe(2);
    expect(harness.controller.ended()).toBe(true);
    // v1 路径没有任何 v2 尾部修复调用。
    expect(harness.calls.filter((call) => call.kind === "repair")).toHaveLength(0);
  });

  it("v1 sessions stay byte-identical to the pre-wiring decode (fixture pin)", async () => {
    const harness = makeGame(
      {
        lines(_taskType, nonce) {
          return [
            "@bg corridor",
            "地下室里只亮着终端的一点蓝光。",
            "许晚晴[smile|left](神秘女子): 你不该来这里。",
            "林小满: 我只是路过。",
            `@end ${nonce} ending`,
          ];
        },
        repair() {
          return "";
        },
      },
      makeTestConfig({
        text_buffer: { start_threshold_lines: 1, target_lines: 6, refill_threshold_lines: -1 },
      }),
    );

    await expect(harness.game.run()).resolves.toBeUndefined();

    // 落盘事件逐字节钉死（nonce 不进事件；id/seq/时间戳全确定性）。
    const actual = JSON.stringify(
      harness.game.events.map((event) => ({
        ...event,
        // ending_id 内嵌生成计数，只钉存在性以避免跨场景耦合；其余字段
        // 全部逐字节比较。
        ...(event.type === "end" ? { ending_id: "<ending>" } : {}),
      })),
      null,
      0,
    );
    expect(actual).toBe(V1_FIXTURE_JSON);
    expect(harness.calls.filter((call) => call.kind === "repair")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// v1 fixture：接线前（HEAD 89ef14e 的 v1 路径）录制，接线后必须逐字节
// 一致——main 自己的场景（campus 的 fixture 钉的是 campus 的 Game 形状，
// main 的图运行时/EndEvent 形状不同，须另行录制）。
// 场景：@bg + 裸旁白 + 两个带台词头的对白（许晚晴[smile|left](神秘女子)
// 与 林小满:）+ ending 哨兵——覆盖 v1 行解码、冒号/方括号/圆括号台词头
// 解析、v1 编译（首触初始化 + 舞台 cue）与落盘事件形状。
// ---------------------------------------------------------------------------

const V1_FIXTURE_JSON =
  '[{"type":"narration","text":"地下室里只亮着终端的一点蓝光。","line_id":"line_session_1_000001","stage":[{"type":"background","assetId":"corridor"}],"seq":1,"turn":1,"timestamp":"2023-11-14T22:13:20.000Z","source":"model"},'
  + '{"type":"dialogue","characterId":"female_A","speaker":"神秘女子","text":"你不该来这里。","line_id":"line_session_1_000002","stage":[{"type":"character_patch","character":"female_A","spriteSet":{"op":"set","value":"female_A"},"variant":{"op":"set","value":"smile"},"position":{"op":"set","value":"left"},"visible":{"op":"set","value":true},"displayName":{"op":"set","value":"神秘女子"}}],"seq":2,"turn":1,"timestamp":"2023-11-14T22:13:20.001Z","source":"model"},'
  + '{"type":"dialogue","characterId":"female_B","speaker":"林小满","text":"我只是路过。","line_id":"line_session_1_000003","stage":[{"type":"character_patch","character":"female_B","spriteSet":{"op":"set","value":"female_B"},"variant":{"op":"set","value":"base"},"position":{"op":"set","value":"left"},"visible":{"op":"set","value":true},"displayName":{"op":"set","value":"林小满"}}],"seq":3,"turn":1,"timestamp":"2023-11-14T22:13:20.002Z","source":"model"},'
  + '{"type":"end","ending_id":"<ending>","text":"故事到此结束。","seq":4,"turn":1,"timestamp":"2023-11-14T22:13:20.003Z","source":"model"}]';
