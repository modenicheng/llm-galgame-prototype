/**
 * Tests for the LLM context builder.
 */

import { describe, it, expect } from "vitest";
import {
  buildDslUserPrompt,
  buildSystemContext,
  renderCastSection,
  serializeModelAssetCatalog,
  serializeStoryContext,
  serializeVisualContext,
  type ContextInput,
  type DslContextInput,
} from "./context-builder.js";
import { RENAME_IDENTITY_CASE } from "../test-support/character-contract-cases.js";
import {
  buildCharacterRoster,
  createCharacterRegistry,
} from "../core/characters/registry.js";
import type { CharacterRegistry as RosterRegistry } from "../core/characters/types.js";
import type { GenerationIdentity } from "../core/ports/story-generator-port.js";
import type { AssetCatalog, ModelAssetCatalog } from "../core/assets/types.js";
import { createInitialState } from "./state.js";
import type { MemoryProjection } from "../core/narrative/memory-projection.js";
import type { PromptBundle } from "../prompts.js";
import type { StoryContextEvent } from "../schema.js";
import type { StoryState } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePrompts(): PromptBundle {
  return {
    characters: "角色A：勇敢的冒险者\n角色B：神秘的向导",
    storyLine: "第一章：进入迷雾森林，寻找失落的圣物。",
    guideline: "保持悬疑氛围，不要使用现代词汇。",
    dslProtocol: "你是互动视觉小说的编剧。输出行式 Gal DSL。",
  };
}

function makeDefaultContext(): ContextInput {
  return {
    prompts: makePrompts(),
    state: createInitialState(),
    recentEvents: [],
  };
}

function makeRichState(): StoryState {
  return createInitialState({
    scene: {
      id: "dark_forest",
      location: "森林深处",
      time: "深夜",
      purpose: "找到隐藏的圣物线索",
    },
    characters: {
      hero: { location: "森林" },
      guide: { location: "森林" },
    },
    recent_summary: "夜幕降临，冒险者在林中点起火把。",
  });
}

function makeBrief(): MemoryProjection {
  return {
    revision: 2,
    consolidatedThroughEventSeq: 88,
    currentEventSeq: 92,
    checkpointCount: 1,
    location: "旧图书馆",
    characters: ["苏遥"],
    activeThreads: [
      {
        id: "thread_suyao",
        kind: "mystery",
        summary: "旧终端里藏着苏遥的秘密",
        status: "developing",
        importance: "major",
        lastTouchedAtCheckpoint: 12,
      },
    ],
    setupDirectives: [{ id: "setup_key", action: "reinforce", urgency: "now" }],
    relevantEpisodes: [],
    anchors: [],
        avoidanceLessons: [],
    relatedFacts: [],
    characterBeliefs: [],
  };
}

function makeRecentEvents(): StoryContextEvent[] {
  return [
    {
      type: "narration",
      text: "迷雾笼罩着古老的森林。",
      line_id: "line_001",
      seq: 1,
      turn: 1,
      timestamp: "2024-01-01T00:00:00.000Z",
      source: "model",
    },
    {
      type: "dialogue",
      speaker: "向导",
      text: "小心脚下，这里有很多古老的陷阱。",
      portrait: { character: "guide", expression: "wary", position: "left" },
      line_id: "line_002",
      seq: 2,
      turn: 1,
      timestamp: "2024-01-01T00:00:01.000Z",
      source: "model",
    },
    {
      type: "player_choice",
      choice_id: "opt_cautious",
      text: "谨慎地跟着向导前进",
      seq: 3,
      turn: 1,
      timestamp: "2024-01-01T00:00:02.000Z",
      source: "player",
    },
  ];
}

// ---------------------------------------------------------------------------
// buildSystemContext
// ---------------------------------------------------------------------------

describe("buildSystemContext", () => {
  it("should include the output protocol (dsl-protocol)", () => {
    const ctx = makeDefaultContext();
    const system = buildSystemContext(ctx);
    expect(system).toContain("行式 Gal DSL");
    expect(system).toContain("角色设定");
  });

  it("should include character settings", () => {
    const ctx = makeDefaultContext();
    const system = buildSystemContext(ctx);
    expect(system).toContain("角色设定");
    expect(system).toContain("角色A");
    expect(system).toContain("角色B");
  });

  it("should include storyline", () => {
    const ctx = makeDefaultContext();
    const system = buildSystemContext(ctx);
    expect(system).toContain("故事大纲");
    expect(system).toContain("迷雾森林");
  });

  it("should include guideline", () => {
    const ctx = makeDefaultContext();
    const system = buildSystemContext(ctx);
    expect(system).toContain("写作限制");
    expect(system).toContain("悬疑氛围");
  });

  it("should include author config when provided", () => {
    const ctx: ContextInput = {
      ...makeDefaultContext(),
      authorConfig: {
        control: {
          world: { mode: "locked" },
          characters: { mode: "preferred" },
          plot: { mode: "free" },
          endings: { mode: "free" },
          style: { mode: "locked" },
        },
        rules: {
          locked: ["所有角色必须是动物"],
          preferred: [],
          seeds: [],
        },
      },
    };
    const system = buildSystemContext(ctx);
    expect(system).toContain("作者控制配置");
    expect(system).toContain("locked");
    expect(system).toContain("所有角色必须是动物");
  });

  it("should not include dynamic state in system context", () => {
    // System context should NOT contain the state summary — that goes
    // into the user prompt for per-request freshness.
    const ctx: ContextInput = {
      ...makeDefaultContext(),
      state: makeRichState(),
    };
    const system = buildSystemContext(ctx);
    expect(system).not.toContain("[Scene]");
    expect(system).not.toContain("[Characters]");
    expect(system).not.toContain("[Open Threads]");
    expect(system).not.toContain("[Canon]");
    expect(system).not.toContain("[Recent]");
  });
});

// ---------------------------------------------------------------------------
// buildDslUserPrompt + director brief
// ---------------------------------------------------------------------------

describe("buildDslUserPrompt", () => {
  it("orders sections stable-first for prefix-cache locality (D9)", () => {
    const ctx: DslContextInput = {
      ...makeDefaultContext(),
      taskType: "continuation",
      generationNonce: "b7f2",
      targetLines: 6,
      tailVisualState: { background: "library", characters: {} },
      actorBriefing:
        "===== 导演便签 =====\n记忆已整理至事件 88（当前事件 92），最近 0 条原始事件见上方剧情历史。\n[活跃剧情线]\n- thread_1（main，developing，major）：寻找失踪的妹妹",
      modelAssetCatalog: {
        guidance: "",
        backgrounds: { library: { description: "旧图书馆" } },
        bgm: {},
        soundEffects: {},
        spriteSets: {},
      },
    };

    const prompt = buildDslUserPrompt(4, ctx);
    expect(prompt).toContain("导演便签");

    // 稳定区（历史→素材）在前，易变区（状态→便签→舞台）居中，任务头置尾。
    const at = (marker: string) => prompt.indexOf(marker);
    const historyAt = at("===== 剧情历史 =====");
    const catalogAt = at("===== 可用素材 =====");
    const stateAt = at("===== 当前故事状态 =====");
    const noteAt = at("导演便签");
    const stageAt = at("===== 当前舞台状态 =====");
    const taskTypeAt = at("任务类型：");
    const nonceAt = at("生成段 nonce：");
    expect(historyAt).toBeGreaterThanOrEqual(0);
    expect(catalogAt).toBeGreaterThan(historyAt);
    expect(stateAt).toBeGreaterThan(catalogAt);
    expect(noteAt).toBeGreaterThan(stateAt);
    expect(stageAt).toBeGreaterThan(noteAt);
    expect(taskTypeAt).toBeGreaterThan(stageAt);
    expect(nonceAt).toBeGreaterThan(taskTypeAt);
    // 任务头之后不再有历史区（历史只出现在前缀位置）。
    expect(prompt.indexOf("===== 剧情历史 =====", historyAt + 1)).toBe(-1);
    expect(prompt).toContain("记忆已整理至事件 88（当前事件 92）");
    expect(prompt).toContain("[活跃剧情线]");
  });

  it("omits the director note entirely without a brief", () => {
    const ctx: DslContextInput = {
      ...makeDefaultContext(),
      taskType: "continuation",
      generationNonce: "c0de",
      targetLines: 6,
    };

    const prompt = buildDslUserPrompt(4, ctx);
    expect(prompt).not.toContain("导演便签");
    expect(prompt).not.toContain("记忆已整理至事件");
  });
});

// ---------------------------------------------------------------------------
// C1 契约向量（计划 R01）——C5 转绿：serializeStoryContext 显式携带
// registry，输出身份稳定的事件 JSON（§5.1）——对白行携带稳定
// characterId 与发射时刻名牌，不再只回放显示名，也没有 `神秘女子: 台词`
// 这类可被误解析为新角色的行头格式。
// ---------------------------------------------------------------------------

/** R01 向量的 C2 roster registry（唯一 NPC = female_A）。 */
function r01RosterRegistry(): RosterRegistry {
  const assets: AssetCatalog = {
    guidance: "",
    backgrounds: {},
    bgm: {},
    soundEffects: {},
    spriteSets: {},
  };
  return createCharacterRegistry(
    buildCharacterRoster({
      schemaVersion: 2,
      scopeId: "r01-context-builder",
      playerId: "player_one",
      characters: [
        {
          id: "player_one",
          name: "玩家",
          control: "player",
          initialLabel: "你",
          persona: "玩家本人（契约向量）。",
        },
        {
          id: RENAME_IDENTITY_CASE.characterId,
          name: RENAME_IDENTITY_CASE.scriptName,
          control: "npc",
          initialLabel: RENAME_IDENTITY_CASE.scriptName,
          persona: "契约向量角色。",
        },
      ],
    }),
    assets,
  );
}

describe("C1 contract vector — identity after rename (R01)", () => {
  it("serialized history still carries the stable characterId after a display-name rename", () => {
    // 事件形状与运行时落盘一致（编译产物：characterId=female_A，
    // speaker=改名标签）。全链路推导见 src/character-contract.test.ts。
    const events: StoryContextEvent[] = [
      {
        type: "dialogue",
        characterId: RENAME_IDENTITY_CASE.characterId,
        speaker: RENAME_IDENTITY_CASE.renamedLabel,
        text: RENAME_IDENTITY_CASE.dialogueText,
        line_id: "line_contract_r01",
        seq: 1,
        turn: 1,
        timestamp: "2026-09-19T00:00:00.000Z",
        source: "model",
      },
    ];

    const serialized = serializeStoryContext(events, r01RosterRegistry());
    expect(serialized).toContain(RENAME_IDENTITY_CASE.characterId);
    // 冒号行头格式（半角/全角）不得出现。
    expect(serialized).not.toMatch(/神秘女子[:：]/);
  });
});

// ---------------------------------------------------------------------------
// C5 评审移交 C6（carried finding 1，port 自 campus 0b8de2e）：prompt 层
// 身份渲染此前零测试覆盖。在 main 的字符串拼装 API 上钉住：cast 段
// （允许发声 + 场景参与者）、任务头的协议/身份版本行、视觉段的 visible
// 真值推导、空允许 cast 的「仅旁白」消息。
// ---------------------------------------------------------------------------

/** 带 looks 的 roster registry（cast/素材段测试用）。 */
function castRosterRegistry(): RosterRegistry {
  const assets: AssetCatalog = {
    guidance: "",
    backgrounds: { library: { id: "library", src: "l.jpg", description: "图书馆" } },
    bgm: {},
    soundEffects: {},
    spriteSets: {
      female_A: {
        id: "female_A",
        variants: {
          base: { id: "base", src: "a.png", description: "" },
          smile: { id: "smile", src: "a2.png", description: "" },
        },
      },
    },
  };
  return createCharacterRegistry(
    buildCharacterRoster({
      schemaVersion: 2,
      scopeId: "cast-render-test",
      playerId: "player_one",
      characters: [
        {
          id: "player_one",
          name: "玩家",
          control: "player",
          initialLabel: "你",
          persona: "玩家本人。",
        },
        {
          id: "female_A",
          name: "契约角色",
          control: "npc",
          initialLabel: "契约角色",
          persona: "契约人设。",
          presentation: {
            defaultLook: "base",
            defaultPosition: "right",
            looks: {
              base: { spriteSet: "female_A", variant: "base" },
              smile: { spriteSet: "female_A", variant: "smile" },
            },
          },
        },
      ],
    }),
    assets,
  );
}

function makeIdentity(
  registry: RosterRegistry,
  overrides?: Partial<GenerationIdentity>,
): GenerationIdentity {
  return {
    protocolVersion: 1,
    rosterRevision: registry.roster.revision,
    cast: {
      allowedSpeakerIds: ["female_A"],
      sceneParticipantIds: ["player_one", "female_A"],
    },
    characterState: { labels: Object.create(null) },
    ...overrides,
  };
}

describe("prompt-level identity rendering (C5 移交 C6 的测试欠账)", () => {
  const registry = castRosterRegistry();

  it("cast 段：允许发声与场景参与者分列；名牌覆盖显示为「id（当前名牌：…）」", () => {
    const section = renderCastSection(
      makeIdentity(registry, {
        characterState: { labels: { female_A: "化名" } as Record<string, string> },
      }),
    );
    expect(section).toContain("允许发声（本段 NPC 台词仅限这些角色 ID）：female_A（当前名牌：化名）");
    expect(section).toContain("场景参与者（含电话/画外角色，不等于台上可见）：player_one、female_A（当前名牌：化名）");
  });

  it("cast 段：空允许 cast 输出「仅旁白」消息，不硬塞角色", () => {
    const section = renderCastSection(
      makeIdentity(registry, {
        cast: { allowedSpeakerIds: [], sceneParticipantIds: ["player_one"] },
      }),
    );
    expect(section).toContain("允许发声：本段没有可发声 NPC——不要输出任何角色台词，只写旁白。");
  });

  it("任务头携带 DSL 协议版本与身份版本（roster revision）行；无 identity 时缺省", () => {
    const base: DslContextInput = {
      prompts: makePrompts(),
      state: createInitialState(),
      recentEvents: [],
      taskType: "continuation",
      generationNonce: "d41f",
      targetLines: 6,
      identity: makeIdentity(registry),
    };
    const withIdentity = buildDslUserPrompt(3, base);
    expect(withIdentity).toContain("DSL 协议版本：1");
    expect(withIdentity).toContain(`身份版本（roster revision）：${registry.roster.revision}`);

    const { identity: _omit, ...withoutIdentityInput } = base;
    const withoutIdentity = buildDslUserPrompt(
      3,
      withoutIdentityInput as DslContextInput,
    );
    expect(withoutIdentity).not.toContain("DSL 协议版本");
    expect(withoutIdentity).not.toContain("身份版本（roster revision）");
  });

  it("identity 在场的用户 prompt：cast 段恰一次（分节头逐字节）；cast 段在易变区", () => {
    const prompt = buildDslUserPrompt(3, {
      prompts: makePrompts(),
      state: createInitialState(),
      recentEvents: [],
      taskType: "continuation",
      generationNonce: "d41f",
      targetLines: 6,
      registry,
      identity: makeIdentity(registry),
    });
    // 分节头逐字节恰一次（port 自 campus 05f3772 补钉）。
    expect(prompt).toContain("===== 本段 cast =====");
    expect(prompt.split("===== 本段 cast =====")).toHaveLength(2);
    // cast 段在任务头之前、素材/状态之后（易变区中部，不打散稳定前缀）。
    expect(prompt.indexOf("===== 本段 cast =====")).toBeGreaterThan(
      prompt.indexOf("===== 当前故事状态 ====="),
    );
    expect(prompt.indexOf("===== 本段 cast =====")).toBeLessThan(
      prompt.indexOf("任务类型："),
    );
  });

  it("视觉段按 visible 真值渲染；identity 在场时不从素材目录推导不在场名单", () => {
    const visual = serializeVisualContext(
      {
        background: "library",
        characters: {
          female_A: {
            displayName: "契约角色",
            spriteSet: "female_A",
            variant: "base",
            position: "right",
            visible: true,
          },
        },
      },
      // 传了 roster 也不该出现「不在场」清单（那是 cast 段的职责）——
      // 在场集合与 roster 可见角色重合时不输出该行。
      buildCharacterRoster({
        schemaVersion: 2,
        scopeId: "visual-truth-test",
        playerId: "player_one",
        characters: [
          { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
          {
            id: "female_A",
            name: "契约角色",
            control: "npc",
            initialLabel: "契约角色",
            persona: "契约角色。",
            presentation: {
              defaultLook: "base",
              defaultPosition: "right",
              looks: { base: { spriteSet: "female_A", variant: "base" } },
            },
          },
        ],
      }),
    );
    expect(visual).toContain("背景：library");
    expect(visual).toContain("female_A（显示名：契约角色）");
    expect(visual).not.toContain("不在场");
    // 隐藏角色必须显式说明（visible 真值，不是省略）。
    const hidden = serializeVisualContext({
      characters: {
        female_A: {
          displayName: "契约角色",
          spriteSet: "female_A",
          variant: "base",
          position: "right",
          visible: false,
        },
      },
    });
    expect(hidden).toContain("隐藏（说话不会自动显示，需 @ch female_A show 恢复）");
  });

  it("视觉段的 identity 增量（campus 05f3772 补钉）：两角色一名在场一名不在场——identity 在场时不列「不在场」，缺省时才列", () => {
    // roster 有 female_A / player_one；视觉状态只有 female_A 在场。
    const visualState = {
      background: "library",
      characters: {
        female_A: {
          displayName: "契约角色",
          spriteSet: "female_A",
          variant: "base",
          position: "right" as const,
          visible: true,
        },
      },
    };
    // C7：不在场名单从 registry roster 派生（不再走模型目录 characters）。
    // 驱动名单 = 有舞台绑定但未登台的 roster 角色（玩家无绑定，不进名单）。
    const legacyRoster = buildCharacterRoster({
      schemaVersion: 2,
      scopeId: "identity-delta-test",
      playerId: "player_one",
      characters: [
        { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
        {
          id: "female_A",
          name: "契约角色",
          control: "npc",
          initialLabel: "契约角色",
          persona: "契约角色。",
          presentation: {
            defaultLook: "base",
            defaultPosition: "right",
            looks: { base: { spriteSet: "female_A", variant: "base" } },
          },
        },
        {
          id: "yuki",
          name: "由纪",
          control: "npc",
          initialLabel: "由纪",
          persona: "同级生。",
          presentation: {
            defaultLook: "base",
            defaultPosition: "left",
            looks: { base: { spriteSet: "female_A", variant: "base" } },
          },
        },
      ],
    });
    // identity 在场（buildDslUserPrompt 的调用形态）：不传 roster → 无「不在场」。
    const withIdentity = serializeVisualContext(visualState);
    expect(withIdentity).not.toContain("不在场");
    // identity 缺省（兼容路径）：从 roster 派生 → 列出不在场（由纪未登台）。
    const legacy = serializeVisualContext(visualState, legacyRoster);
    expect(legacy).toContain("不在场：由纪");
    // 整 prompt 层面双向钉死（buildDslUserPrompt 按是否携带 identity 切换）。
    const identityPrompt = buildDslUserPrompt(3, {
      prompts: makePrompts(),
      state: createInitialState(),
      recentEvents: [],
      taskType: "continuation",
      generationNonce: "d41f",
      targetLines: 6,
      identity: makeIdentity(registry),
      tailVisualState: visualState,
      modelAssetCatalog: {
        guidance: "",
        backgrounds: {},
        bgm: {},
        soundEffects: {},
        spriteSets: {},
      },
    });
    expect(identityPrompt).not.toContain("不在场：");
    const { identity: _omit, ...withoutIdentity } = {
      ...makeDefaultContext(),
      taskType: "continuation",
      generationNonce: "d41f",
      targetLines: 6,
      tailVisualState: visualState,
      // C7：identity 缺省的兼容路径从 registry roster 派生不在场名单
      //（不再走模型目录 characters）。
      registry: createCharacterRegistry(legacyRoster, {
        guidance: "",
        backgrounds: {},
        bgm: {},
        soundEffects: {},
        spriteSets: {
          female_A: { id: "female_A", variants: { base: { id: "base", src: "a.png", description: "" } } },
        },
      }),
      modelAssetCatalog: {
        guidance: "",
        backgrounds: {},
        bgm: {},
        soundEffects: {},
        spriteSets: {},
      },
    } as DslContextInput;
    const legacyPrompt = buildDslUserPrompt(3, withoutIdentity as DslContextInput);
    expect(legacyPrompt).toContain("不在场：由纪");
  });
});

// ---------------------------------------------------------------------------
// C6 §5.4 素材目录去重：registry 在场时外观按角色列 look（不再同时给
// 全量 spriteSets 清单 + characters 映射双份）；无 roster 兼容路径保持
// 旧渲染字节（port 自 campus 0b8de2e，字符串 API 适配）。
// ---------------------------------------------------------------------------

describe("serializeModelAssetCatalog roster 去重（C6 §5.4）", () => {
  const registry = castRosterRegistry();

  const catalog: ModelAssetCatalog = {
    guidance: "素材目录说明。",
    backgrounds: { library: { description: "图书馆" } },
    bgm: {},
    soundEffects: {},
    spriteSets: {
      female_A: {
        description: "契约角色立绘",
        variants: { base: { description: "常态" }, smile: { description: "微笑" } },
      },
    },
  };

  it("registry 在场：外观按角色列 look，不再给全量 spriteSets + characters 双份", () => {
    const text = serializeModelAssetCatalog(catalog, registry.roster);
    expect(text).toContain("素材目录说明。");
    expect(text).toContain("- female_A（脚本名：契约角色，默认位置：right）可用外观 look：base、smile");
    expect(text).not.toMatch(/^立绘组 /m);
    expect(text).not.toContain("可用立绘组");
  });

  it("C7：无 roster 兼容路径只列素材清单（模型目录不再携带 characters 段）", () => {
    const text = serializeModelAssetCatalog(catalog);
    expect(text).toContain("立绘组 female_A：契约角色立绘");
    expect(text).toContain("  base — 常态");
    expect(text).not.toContain("脚本名：契约角色");
    expect(text).not.toContain("可用立绘组");
  });

  it("roster 里无 presentation 的角色：明示「可以说话，不配立绘」；玩家标注不由你代写台词", () => {
    const bare = createCharacterRegistry(
      buildCharacterRoster({
        schemaVersion: 2,
        scopeId: "bare-dedup-test",
        playerId: "player_one",
        characters: [
          { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
          { id: "wanderer", name: "过客", control: "npc", initialLabel: "过客", persona: "无立绘。" },
        ],
      }),
      {
        guidance: "",
        backgrounds: {},
        bgm: {},
        soundEffects: {},
        spriteSets: {},
      },
    );
    const text = serializeModelAssetCatalog(catalog, bare.roster);
    expect(text).toContain("player_one（脚本名：玩家，玩家本人——不由你代写台词）");
    expect(text).toContain("wanderer（脚本名：过客，无立绘：可以说话，不配立绘）");
  });

  it("buildDslUserPrompt：registry 在场时可用素材段走去重渲染，分节头恰一次", () => {
    const prompt = buildDslUserPrompt(5, {
      prompts: makePrompts(),
      state: createInitialState(),
      recentEvents: [],
      taskType: "continuation",
      generationNonce: "d41f",
      targetLines: 6,
      registry,
      modelAssetCatalog: catalog,
    });
    expect(prompt).toContain("可用外观 look：base、smile");
    expect(prompt).not.toMatch(/^立绘组 /m);
    expect(prompt.split("===== 可用素材 =====")).toHaveLength(2);
  });
});
