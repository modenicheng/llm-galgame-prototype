/**
 * Tests for AudioDescriptorFactory: voice resolution, descriptor/recipe
 * shapes, env-based voice IDs, mock bindings, and deterministic seeds.
 *
 * C7：factory 只按稳定 CharacterId 定位身份（registry 注入），label 只进
 * displaySpeaker；兼容查表集中在 legacy-identity 解析器；声音不可用是
 * 可观测降级（voiceAvailability=unavailable），不是身份失败。导演声音
 * 指导（voiceDirectionFor）与编剧画像（voiceDesigns）严格按稳定 ID 查询。
 */
import { describe, it, expect, vi } from "vitest";
import {
  AudioDescriptorFactory,
  type AudioDescriptorFactoryOptions,
  type BuildAudioResult,
} from "./audio-descriptor-factory.js";
import type { VoicesConfig } from "../../config/voices.js";
import { PerformanceCompilerImpl, type LinePerformance, type PerformanceCompiler } from "./performance-compiler.js";
import type { RuntimePlayableEvent } from "../../schema.js";
import type { InternalAudioRecipe } from "./internal-audio-recipe.js";
import type { AssetCatalog } from "../../core/assets/types.js";
import { buildCharacterRoster, createCharacterRegistry } from "../../core/characters/registry.js";
import type {
  CharacterDefinition,
  CharacterRegistry,
} from "../../core/characters/types.js";
import {
  createLegacyIdentityResolver,
  type LegacyIdentityMapping,
} from "../../core/characters/legacy-identity.js";
import {
  RENAME_IDENTITY_CASE,
  VOICE_PROFILE_STABILITY_CASE,
} from "../../test-support/character-contract-cases.js";

const stubCompiler: PerformanceCompiler = {
  compile: () => ({
    rate: 1,
    pitch: 1,
    volume: 1,
    pauseBeforeMs: 0,
    pauseAfterMs: 0,
  }),
};

const voices: VoicesConfig = {
  version: 3,
  profiles: {
    suyao_main: {
      semantic: {
        base_description: "温柔的少女声",
        allowed_delivery: ["gentle"],
        forbidden_delivery: ["cold"],
      },
      providers: {
        dashscope: {
          model: "cosyvoice-v2",
          voice_id_env: "SUYAO_VOICE_ID",
          voice_revision: 3,
          instruction_mode: "free",
        },
      },
    },
    ruoxi_main: {
      semantic: {
        base_description: "温柔的少女声",
        allowed_delivery: [],
        forbidden_delivery: [],
      },
      providers: {},
    },
  },
};

// ---------------------------------------------------------------------------
// Roster fixtures — 身份真源（C7：不再有 speaker/name 键控的 characters 表）
// ---------------------------------------------------------------------------

const EMPTY_ASSETS: AssetCatalog = {
  guidance: "",
  backgrounds: {},
  bgm: {},
  soundEffects: {},
  spriteSets: {},
};

function registryOf(
  scopeId: string,
  npcs: Array<Partial<CharacterDefinition> & { id: string }>,
): CharacterRegistry {
  const characters: CharacterDefinition[] = [
    {
      id: "player_one",
      name: "玩家",
      control: "player",
      initialLabel: "你",
      persona: "玩家本人（音频工厂测试）。",
    },
    ...npcs.map((npc) => ({
      name: npc.name ?? npc.id,
      control: "npc" as const,
      initialLabel: npc.initialLabel ?? npc.name ?? npc.id,
      persona: npc.persona ?? "测试人设。",
      ...npc,
    })),
  ];
  return createCharacterRegistry(
    buildCharacterRoster({
      schemaVersion: 2,
      scopeId,
      playerId: "player_one",
      characters,
    }),
    EMPTY_ASSETS,
  );
}

/** 默认 roster：suyao（有音色）+ ruoxi（profile 无 provider 绑定）+ mute_npc（无音色）。 */
function defaultRegistry(): CharacterRegistry {
  return registryOf("audio-factory-test", [
    { id: "suyao", name: "苏遥", initialLabel: "苏遥", voiceProfileId: "suyao_main" },
    { id: "ruoxi", name: "若曦", initialLabel: "若曦", voiceProfileId: "ruoxi_main" },
    { id: "mute_npc", name: "沉默的行人", initialLabel: "沉默的行人" },
  ]);
}

const LEGACY_MAPPING: LegacyIdentityMapping = {
  scope: { scopeId: "audio-factory-test", schemaVersion: 1 },
  scriptNames: [
    { scriptName: "苏遥", characterId: "suyao" },
    { scriptName: "若曦", characterId: "ruoxi" },
  ],
  ttsKeys: [{ ttsKey: "suyao", characterId: "suyao" }],
};

function makeFactory(overrides: Partial<AudioDescriptorFactoryOptions> = {}): AudioDescriptorFactory {
  return new AudioDescriptorFactory({
    registry: defaultRegistry(),
    voices,
    provider: "dashscope",
    modelProfile: "cosyvoice_v3_flash",
    sampleRate: 22050,
    format: "pcm_s16le",
    env: { SUYAO_VOICE_ID: "suyao-voice-001" },
    compiler: stubCompiler,
    seedFor: (lineId) => [...lineId].reduce((acc, char) => acc + char.charCodeAt(0), 0),
    ...overrides,
  });
}

/** 新路径事件：稳定 characterId + 名牌快照（displayLabel）。 */
function dialogue(
  characterId: string,
  label: string,
  text: string,
  lineId: string,
): RuntimePlayableEvent {
  return { type: "dialogue", characterId, displayLabel: label, speaker: label, text, line_id: lineId };
}

/** 旧形状事件：只有 speaker（display 名），无 characterId。 */
function legacyDialogue(speaker: string, text: string, lineId: string): RuntimePlayableEvent {
  return { type: "dialogue", speaker, text, line_id: lineId };
}

function narration(text: string, lineId: string): RuntimePlayableEvent {
  return { type: "narration", text, line_id: lineId };
}

function available(result: BuildAudioResult | null): Exclude<BuildAudioResult, { voiceAvailability: "unavailable" }> {
  expect(result).not.toBeNull();
  expect(result!.voiceAvailability).toBe("available");
  return result as Exclude<BuildAudioResult, { voiceAvailability: "unavailable" }>;
}

/** 断言 available 并取 recipe（非 available 即抛错，测试失败归因清晰）。 */
function recipeOf(result: BuildAudioResult | null): InternalAudioRecipe {
  return available(result).recipe;
}

/** 断言 unavailable 并取诊断载荷。 */
function unavailableOf(result: BuildAudioResult | null): {
  reason: string;
  diagnostic: string;
} {
  expect(result).not.toBeNull();
  expect(result!.voiceAvailability).toBe("unavailable");
  const outcome = result as { reason: string; diagnostic: string };
  return outcome;
}

describe("AudioDescriptorFactory", () => {
  it("builds a descriptor + recipe for dialogue with a profile", () => {
    const result = makeFactory().build(
      dialogue("suyao", "苏遥", "今天天气真好。", "l1"),
      { type: "active" },
      "current",
    );

    const { descriptor, recipe } = available(result);
    expect(descriptor).toMatchObject({
      lineId: "l1",
      scope: { type: "active" },
      priority: "current",
      speakerId: "suyao",
      displaySpeaker: "苏遥",
      format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
    });
    expect(descriptor.cacheKey).toBe(recipe.cacheKey);
    expect(recipe).toMatchObject({
      lineId: "l1",
      text: "今天天气真好。",
      model: "cosyvoice-v2",
      voiceId: "suyao-voice-001",
      voiceRevision: 3,
      rate: 1,
      pitch: 1,
      volume: 1,
    });
  });

  it("returns null for narration — narration has no voice", () => {
    expect(makeFactory().build(narration("风雪夜。", "l3"), { type: "active" }, "current")).toBeNull();
  });

  it("uses the event label snapshot for displaySpeaker, never the roster name", () => {
    // 同一 characterId、改名后的名牌快照：displaySpeaker 跟随事件 label，
    // 音频身份（voiceId/revision/cacheKey）不变。
    const result = makeFactory().build(
      dialogue("suyao", "神秘女子", "你好。", "l2b"),
      { type: "active" },
      "current",
    );
    const { descriptor } = available(result);
    expect(descriptor.displaySpeaker).toBe("神秘女子");
    expect(descriptor.speakerId).toBe("suyao");
    expect(recipeOf(result).voiceId).toBe("suyao-voice-001");
  });

  it("uses the configured env voice ID", () => {
    const recipe = available(
      makeFactory().build(dialogue("suyao", "苏遥", "hi", "l4"), { type: "active" }, "current"),
    ).recipe as InternalAudioRecipe;
    expect(recipe.voiceId).toBe("suyao-voice-001");
    // Missing env is a startup error in dashscope mode (validateDashscopeEnv);
    // the factory itself resolves to "" rather than inventing a fallback id.
    const unset = available(
      makeFactory({ env: {} }).build(dialogue("suyao", "苏遥", "hi", "l4"), { type: "active" }, "current"),
    ).recipe as InternalAudioRecipe;
    expect(unset.voiceId).toBe("");
  });

  it("resolves the voice id from env and passes instruction_mode to the compiler", () => {
    // binding: { model: "cosyvoice-v3-flash", voice_id_env: "COSYVOICE_VOICE_SUYAO",
    //            voice_revision: 1, instruction_mode: "fixed_emotion" }
    const fixedEmotionVoices: VoicesConfig = {
      version: 3,
      profiles: {
        suyao_main: {
          semantic: {
            base_description: "温柔的少女声",
            allowed_delivery: ["gentle"],
            forbidden_delivery: ["cold"],
          },
          providers: {
            dashscope: {
              model: "cosyvoice-v3-flash",
              voice_id_env: "COSYVOICE_VOICE_SUYAO",
              voice_revision: 1,
              instruction_mode: "fixed_emotion",
            },
          },
        },
      },
    };
    const seenModes: Array<string | undefined> = [];
    const factory = makeFactory({
      voices: fixedEmotionVoices,
      env: { COSYVOICE_VOICE_SUYAO: "cosyvoice-v3-flash-suyao-abc" },
      compiler: {
        compile: (input) => {
          seenModes.push(input.instructionMode);
          return {
            rate: 1,
            pitch: 1,
            volume: 1,
            instruction: `你说话的情感是${input.performance?.emotion}。`,
            pauseBeforeMs: 0,
            pauseAfterMs: 0,
          };
        },
      },
    });
    const result = factory.build(
      dialogue("suyao", "苏遥", "今天天气真好。", "l12"),
      { type: "active" },
      "current",
      { emotion: "sad" },
    )!;

    expect(seenModes).toEqual(["fixed_emotion"]);
    expect(recipeOf(result)).toMatchObject({
      voiceId: "cosyvoice-v3-flash-suyao-abc",
      voiceRevision: 1,
      instruction: "你说话的情感是sad。",
    });
  });

  it("synthesizes a stable mock binding when provider is mock", () => {
    const result = available(
      makeFactory({
        provider: "mock",
        env: { MOCK_VOICE_suyao: "mock-voice-9" },
      }).build(dialogue("suyao", "苏遥", "hi", "l5"), { type: "active" }, "current"),
    );

    expect(result.recipe).toMatchObject({
      model: "cosyvoice_v3_flash",
      voiceId: "mock-voice-9",
      voiceRevision: 0,
    });
    // Same character + text + mock binding → deterministic key.
    const again = available(
      makeFactory({
        provider: "mock",
        env: { MOCK_VOICE_suyao: "mock-voice-9" },
      }).build(dialogue("suyao", "苏遥", "hi", "l5"), { type: "active" }, "current"),
    );
    expect(again.recipe.cacheKey).toBe(result.recipe.cacheKey);
  });

  it("uses a deterministic per-line seed", () => {
    const factory = makeFactory();
    const first = available(
      factory.build(dialogue("suyao", "苏遥", "你好", "l7"), { type: "active" }, "current"),
    );
    const second = available(
      factory.build(dialogue("suyao", "苏遥", "你好", "l7"), { type: "active" }, "current"),
    );
    expect(first.recipe.seed).toBe(second.recipe.seed);
    expect(first.recipe.cacheKey).toBe(second.recipe.cacheKey);

    const otherLine = available(
      factory.build(dialogue("suyao", "苏遥", "你好", "l8"), { type: "active" }, "current"),
    );
    expect(otherLine.recipe.seed).not.toBe(first.recipe.seed);
  });

  it("scopes the descriptor to the requested scope", () => {
    const result = available(
      makeFactory().build(
        dialogue("suyao", "苏遥", "hi", "l9"),
        { type: "candidate", branchId: "b1" },
        "candidate_first_line",
      ),
    );
    expect(result.descriptor.scope).toEqual({ type: "candidate", branchId: "b1" });
    expect(result.descriptor.priority).toBe("candidate_first_line");
  });

  it("compiles event.performance into the recipe", () => {
    const seen: Array<LinePerformance | undefined> = [];
    const factory = makeFactory({
      compiler: {
        compile: (input) => {
          seen.push(input.performance);
          return {
            rate: 1.2,
            pitch: 0.9,
            volume: 0.7,
            instruction: "语气：温柔。",
            pauseBeforeMs: 800,
            pauseAfterMs: 400,
          };
        },
      },
    });
    const performance: LinePerformance = { emotion: "sad", pace: "slow" };
    const result = available(
      factory.build(
        dialogue("suyao", "苏遥", "今天天气真好。", "l10"),
        { type: "active" },
        "current",
        performance,
      ),
    );

    expect(seen).toEqual([performance]);
    expect(result.recipe).toMatchObject({
      rate: 1.2,
      pitch: 0.9,
      volume: 0.7,
      instruction: "语气：温柔。",
      pauseBeforeMs: 800,
      pauseAfterMs: 400,
    });
  });

  it("carries compiled pauses into the recipe and cacheKey", () => {
    const withPause = available(
      makeFactory({
        compiler: {
          compile: () => ({ rate: 1, pitch: 1, volume: 1, pauseBeforeMs: 800, pauseAfterMs: 0 }),
        },
      }).build(dialogue("suyao", "苏遥", "停顿。", "l11"), { type: "active" }, "current"),
    );
    const identity = available(
      makeFactory().build(dialogue("suyao", "苏遥", "停顿。", "l11"), { type: "active" }, "current"),
    );

    expect(withPause.recipe.pauseBeforeMs).toBe(800);
    expect(withPause.recipe.pauseAfterMs).toBe(0);
    expect(identity.recipe.pauseBeforeMs).toBe(0);
    // A non-zero pause must change the audio identity.
    expect(withPause.recipe.cacheKey).not.toBe(identity.recipe.cacheKey);
  });
});

// ---------------------------------------------------------------------------
// 导演声音指导 / 编剧画像（main V1/V2）——严格按稳定 characterId 查询
// ---------------------------------------------------------------------------

describe("AudioDescriptorFactory — voiceDirectionFor", () => {
  it("forwards the direction of the line's speaker into the compiler (queried by stable id)", () => {
    const seen: Array<Record<string, unknown>> = [];
    const recordingCompiler: PerformanceCompiler = {
      compile: (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        return { rate: 1, pitch: 1, volume: 1, pauseBeforeMs: 0, pauseAfterMs: 0 };
      },
    };
    const factory = makeFactory({
      compiler: recordingCompiler,
      voiceDirectionFor: (characterId) =>
        characterId === "suyao" ? { volume: "whisper", note: "夜谈压低声音" } : undefined,
    });
    factory.build(dialogue("suyao", "苏遥", "小声点。", "l21"), { type: "active" }, "current");
    expect(seen[0]?.direction).toEqual({ volume: "whisper", note: "夜谈压低声音" });
  });

  it("changes the compiled recipe and cacheKey when direction differs", () => {
    const withDirection = available(
      makeFactory({
        compiler: new PerformanceCompilerImpl(),
        voiceDirectionFor: () => ({ volume: "whisper", delivery: "gentle" }),
      }).build(dialogue("suyao", "苏遥", "小声点。", "l22"), { type: "active" }, "current"),
    );
    const without = available(
      makeFactory({ compiler: new PerformanceCompilerImpl() }).build(
        dialogue("suyao", "苏遥", "小声点。", "l22"),
        { type: "active" },
        "current",
      ),
    );
    expect(withDirection.recipe.volume).toBe(20);
    // direction delivery 仍受调色板过滤：gentle 在 allowed 内才进语气段。
    expect(withDirection.recipe.instruction).toContain("温柔");
    expect(withDirection.recipe.cacheKey).not.toBe(without.recipe.cacheKey);
  });

  it("never consults the direction source for narration", () => {
    const probe = vi.fn(() => undefined);
    const factory = makeFactory({ voiceDirectionFor: probe });
    expect(factory.build(narration("旁白一行。", "l23"), { type: "active" }, "current")).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("C7：指导查询键是稳定 characterId，不是名牌/显示名", () => {
    // 改名标签的事件：指导仍按 characterId=suyao 命中——显示名不是查询键。
    const probe = vi.fn(
      (characterId: string): { volume: "whisper" } | undefined =>
        characterId === "suyao" ? { volume: "whisper" } : undefined,
    );
    const factory = makeFactory({ voiceDirectionFor: probe, compiler: new PerformanceCompilerImpl() });
    const result = available(
      factory.build(dialogue("suyao", "神秘女子", "小声点。", "l24"), { type: "active" }, "current"),
    );
    expect(probe).toHaveBeenCalledWith("suyao");
    expect(probe).not.toHaveBeenCalledWith("神秘女子");
    expect(result.recipe.volume).toBe(20);
  });
});

describe("AudioDescriptorFactory — voiceDesigns (按稳定 characterId 查询)", () => {
  it("unions design delivery/avoid into the compiled palette (queried by stable id)", () => {
    // 指导候选 playful 不在 profile 的 allowed_delivery（gentle）内——
    // 只有画像并集放行时才进语气段。
    const design = {
      timbre: "清亮的少女声",
      delivery: ["playful"],
      avoid: ["cold"],
      baseline: { energy: "low" as const },
    };
    const withDesign = available(
      makeFactory({
        compiler: new PerformanceCompilerImpl(),
        voiceDirectionFor: (characterId) =>
          characterId === "suyao" ? { delivery: "playful" } : undefined,
        voiceDesigns: { suyao: design },
      }).build(dialogue("suyao", "苏遥", "这是什么？", "l31"), { type: "active" }, "current"),
    );
    expect(withDesign.recipe.instruction).toContain("俏皮");
    // 同一 ID 改名标签：画像仍命中（查询键是 characterId，不是名牌），
    // 编译结果与缓存键与原名版本完全一致。
    const renamed = available(
      makeFactory({
        compiler: new PerformanceCompilerImpl(),
        voiceDirectionFor: (characterId) =>
          characterId === "suyao" ? { delivery: "playful" } : undefined,
        voiceDesigns: { suyao: design },
      }).build(dialogue("suyao", "神秘女子", "这是什么？", "l31"), { type: "active" }, "current"),
    );
    expect(renamed.recipe.cacheKey).toBe(withDesign.recipe.cacheKey);
    expect(renamed.recipe.instruction).toContain("俏皮");
    // 无画像对照：playful 被调色板滤掉（profile 只放行 gentle）。
    const withoutDesign = available(
      makeFactory({
        compiler: new PerformanceCompilerImpl(),
        voiceDirectionFor: (characterId) =>
          characterId === "suyao" ? { delivery: "playful" } : undefined,
      }).build(dialogue("suyao", "苏遥", "这是什么？", "l31"), { type: "active" }, "current"),
    );
    expect(withoutDesign.recipe.instruction).not.toContain("俏皮");
  });
});

// ---------------------------------------------------------------------------
// C7：声音不可用是可观测降级（R24 语义；§6.1）
// ---------------------------------------------------------------------------

describe("AudioDescriptorFactory — voiceAvailability=unavailable degradation", () => {
  it("无音色角色（玩家/voiceless NPC）→ 显式降级，registry 保留角色", () => {
    const registry = defaultRegistry();
    const result = makeFactory({ registry }).build(
      dialogue("mute_npc", "沉默的行人", "……", "u1"),
      { type: "active" },
      "current",
    );
    expect(result).toMatchObject({ voiceAvailability: "unavailable", reason: "voiceless_character" });
    expect(unavailableOf(result).diagnostic).toContain("mute_npc");
    // 身份不受影响：registry 仍能解析该角色。
    expect(registry.get("mute_npc")?.name).toBe("沉默的行人");
  });

  it("玩家台词（player_dialogue，无音色绑定）→ 降级为文字播放", () => {
    const result = makeFactory().build(
      { type: "player_dialogue", interaction_id: "i1", speaker: "你", text: "我明白了。", line_id: "u2" },
      { type: "active" },
      "current",
    );
    expect(result).toMatchObject({ voiceAvailability: "unavailable", reason: "voiceless_character" });
  });

  it("配置 profile 不存在 → missing_profile 诊断（定位 profile 名）", () => {
    const registry = registryOf("audio-factory-test", [
      { id: "orphan", name: "孤儿", voiceProfileId: "no_such_profile" },
    ]);
    const result = makeFactory({ registry }).build(
      dialogue("orphan", "孤儿", "有人吗？", "u3"),
      { type: "active" },
      "current",
    );
    expect(result).toMatchObject({ voiceAvailability: "unavailable", reason: "missing_profile" });
    expect(unavailableOf(result).diagnostic).toContain("no_such_profile");
  });

  it("provider 缺绑定（dashscope 下 providers 为空）→ missing_provider_binding，不再静默 mock 兜底", () => {
    const result = makeFactory().build(
      dialogue("ruoxi", "若曦", "你好。", "u4"),
      { type: "active" },
      "current",
    );
    expect(result).toMatchObject({
      voiceAvailability: "unavailable",
      reason: "missing_provider_binding",
    });
    // mock provider 仍是合法的确定性合成路径（不是降级）。
    const mock = makeFactory({ provider: "mock" }).build(
      dialogue("ruoxi", "若曦", "你好。", "u4"),
      { type: "active" },
      "current",
    );
    expect(mock!.voiceAvailability).toBe("available");
  });

  it("未知 characterId → 不静默新建身份，给 unknown_character 诊断", () => {
    const result = makeFactory().build(
      dialogue("ghost", "幽灵", "hi", "u5"),
      { type: "active" },
      "current",
    );
    expect(result).toMatchObject({ voiceAvailability: "unavailable", reason: "unknown_character" });
  });
});

// ---------------------------------------------------------------------------
// C7：兼容查表集中在 legacy-identity 解析器（scoped、versioned）
// ---------------------------------------------------------------------------

describe("AudioDescriptorFactory — legacy identity adapter concentration", () => {
  it("旧事件（无 characterId）经 legacy 解析器按 scriptName 唯一命中", () => {
    const factory = makeFactory({ legacyResolver: createLegacyIdentityResolver(LEGACY_MAPPING) });
    const result = factory.build(legacyDialogue("苏遥", "你好。", "c1"), { type: "active" }, "current");
    const { descriptor, recipe } = available(result);
    expect(descriptor.speakerId).toBe("suyao");
    expect(descriptor.displaySpeaker).toBe("苏遥");
    expect(recipe.voiceId).toBe("suyao-voice-001");
  });

  it("旧事件名牌不在 legacy 表（改名标签）→ unresolved_speaker，不猜姓名", () => {
    const factory = makeFactory({ legacyResolver: createLegacyIdentityResolver(LEGACY_MAPPING) });
    const result = factory.build(legacyDialogue("神秘女子", "你好。", "c2"), { type: "active" }, "current");
    expect(result).toMatchObject({ voiceAvailability: "unavailable", reason: "unresolved_speaker" });
    expect(unavailableOf(result).diagnostic).toContain("神秘女子");
  });

  it("未装配 legacy 解析器的旧事件 → unresolved_speaker（诊断要求装配兼容层）", () => {
    const result = makeFactory().build(legacyDialogue("苏遥", "你好。", "c3"), { type: "active" }, "current");
    expect(result).toMatchObject({ voiceAvailability: "unavailable", reason: "unresolved_speaker" });
  });
});

// ---------------------------------------------------------------------------
// C7：身份隔离三连（§6.1 —— 同 ID 双标签 / 同标签双 ID / 跨 scope 不同音色设计）
// ---------------------------------------------------------------------------

describe("AudioDescriptorFactory — identity isolation (R05/R24)", () => {
  it("同一 ID 两个名牌 → 完全相同的音色绑定与缓存键", () => {
    const factory = makeFactory();
    const original = available(
      factory.build(dialogue("suyao", "苏遥", "同一句台词。", "i1"), { type: "active" }, "current"),
    );
    const renamed = available(
      factory.build(dialogue("suyao", "神秘女子", "同一句台词。", "i1"), { type: "active" }, "current"),
    );
    expect(renamed.recipe.voiceId).toBe(original.recipe.voiceId);
    expect(renamed.recipe.voiceRevision).toBe(original.recipe.voiceRevision);
    expect(renamed.recipe.cacheKey).toBe(original.recipe.cacheKey);
    expect(renamed.descriptor.speakerId).toBe("suyao");
    // 展示层各自使用 label 快照。
    expect(original.descriptor.displaySpeaker).toBe("苏遥");
    expect(renamed.descriptor.displaySpeaker).toBe("神秘女子");
  });

  it("相同名牌的两个 ID → 不串音（各自解析到各自的音色）", () => {
    const registry = registryOf("isolation-labels", [
      { id: "suyao", name: "苏遥", initialLabel: "神秘女子", voiceProfileId: "suyao_main" },
      { id: "ruoxi", name: "若曦", initialLabel: "神秘女子", voiceProfileId: "ruoxi_main" },
    ]);
    const twinVoices: VoicesConfig = {
      version: 3,
      profiles: {
        suyao_main: voices.profiles.suyao_main!,
        ruoxi_main: {
          semantic: { base_description: "低沉的少女声", allowed_delivery: [], forbidden_delivery: [] },
          providers: {
            dashscope: {
              model: "cosyvoice-v2",
              voice_id_env: "RUOXI_VOICE_ID",
              voice_revision: 5,
              instruction_mode: "free",
            },
          },
        },
      },
    };
    const factory = makeFactory({
      registry,
      voices: twinVoices,
      env: { SUYAO_VOICE_ID: "suyao-voice-001", RUOXI_VOICE_ID: "ruoxi-voice-005" },
    });
    const a = available(
      factory.build(dialogue("suyao", "神秘女子", "同一句台词。", "i2"), { type: "active" }, "current"),
    );
    const b = available(
      factory.build(dialogue("ruoxi", "神秘女子", "同一句台词。", "i2"), { type: "active" }, "current"),
    );
    // 身份按 ID 分流：speakerId、voiceId、缓存键都不同。
    expect(a.descriptor.speakerId).toBe("suyao");
    expect(b.descriptor.speakerId).toBe("ruoxi");
    expect(a.recipe.voiceId).toBe("suyao-voice-001");
    expect(b.recipe.voiceId).toBe("ruoxi-voice-005");
    expect(a.recipe.cacheKey).not.toBe(b.recipe.cacheKey);
    // 展示层同名牌（label 快照照常展示）。
    expect(a.descriptor.displaySpeaker).toBe("神秘女子");
    expect(b.descriptor.displaySpeaker).toBe("神秘女子");
  });

  it("不同世界（scopeId）相同 ID 的不同 voice design → 缓存键不碰撞", () => {
    const worldAVoices: VoicesConfig = {
      version: 3,
      profiles: {
        suyao_main: {
          semantic: { base_description: "清亮的少女声", allowed_delivery: [], forbidden_delivery: [] },
          providers: {
            dashscope: {
              model: "cosyvoice-v2",
              voice_id_env: "SUYAO_VOICE_ID",
              voice_revision: 2,
              instruction_mode: "free",
            },
          },
        },
      },
    };
    const worldBVoices: VoicesConfig = {
      version: 3,
      profiles: {
        suyao_main: {
          semantic: { base_description: "沙哑的年长声线", allowed_delivery: [], forbidden_delivery: [] },
          providers: {
            dashscope: {
              model: "cosyvoice-v3-flash",
              voice_id_env: "SUYAO_VOICE_ID",
              voice_revision: 7,
              instruction_mode: "fixed_emotion",
            },
          },
        },
      },
    };
    const factoryA = makeFactory({
      registry: registryOf("world-alpha", [{ id: "suyao", name: "苏遥", voiceProfileId: "suyao_main" }]),
      voices: worldAVoices,
    });
    const factoryB = makeFactory({
      registry: registryOf("world-beta", [{ id: "suyao", name: "苏遥", voiceProfileId: "suyao_main" }]),
      voices: worldBVoices,
    });
    const a = available(
      factoryA.build(dialogue("suyao", "苏遥", "同一句台词。", "i3"), { type: "active" }, "current"),
    );
    const b = available(
      factoryB.build(dialogue("suyao", "苏遥", "同一句台词。", "i3"), { type: "active" }, "current"),
    );
    expect(a.descriptor.speakerId).toBe("suyao");
    expect(b.descriptor.speakerId).toBe("suyao");
    // 不同 voice design（模型/revision/指令模式）→ 不同缓存键，绝不重放
    // 另一个世界的合成结果。缓存键的隔离由音色绑定成分承担（model/
    // voiceId/voiceRevision/compiled 指令），scopeId 经由各自 registry
    // 的绑定选择进入，不把 scopeId 本身塞进键（分支预取与正式路径共享
    // 音频缓存的既有语义保持不变）。
    expect(a.recipe.model).toBe("cosyvoice-v2");
    expect(b.recipe.model).toBe("cosyvoice-v3-flash");
    expect(a.recipe.voiceRevision).toBe(2);
    expect(b.recipe.voiceRevision).toBe(7);
    expect(a.recipe.cacheKey).not.toBe(b.recipe.cacheKey);
  });

  it("同一 ID 在 candidate 与 active scope → 同一缓存键（音频复用语义保持）", () => {
    const factory = makeFactory();
    const candidate = available(
      factory.build(
        dialogue("suyao", "苏遥", "分支预取台词。", "i4"),
        { type: "candidate", branchId: "b1" },
        "candidate_first_line",
      ),
    );
    const active = available(
      factory.build(dialogue("suyao", "苏遥", "分支预取台词。", "i4"), { type: "active" }, "current"),
    );
    expect(candidate.recipe.cacheKey).toBe(active.recipe.cacheKey);
    expect(candidate.descriptor.scope).toEqual({ type: "candidate", branchId: "b1" });
    expect(active.descriptor.scope).toEqual({ type: "active" });
  });
});

// ---------------------------------------------------------------------------
// C1 契约向量（计划 R02）——同一 characterId（female_A）的事件，名牌从注册名
// 「许晚晴」换成改名标签「神秘女子」后，音色身份必须完全一致。C7 转绿：
// 身份按 roster 稳定 ID 解析（female_A → xuwanqing_main），名牌只进
// displaySpeaker。R04 的旧缺陷现场（TTS 配置键 xuwanqing ≠ 资产 ID
// female_A 的键空间分裂）由绑定按稳定 ID 给出消除——本向量的 roster
// 绑定 voiceProfileId=xuwanqing_main，即真实迁移表取值。
// ---------------------------------------------------------------------------

describe("C1 contract vector — voice profile stability across labels (R02)", () => {
  const contractVoices: VoicesConfig = {
    version: 3,
    profiles: {
      [VOICE_PROFILE_STABILITY_CASE.voiceProfile]: {
        semantic: {
          base_description: "温柔娴静的学姐声",
          allowed_delivery: ["gentle"],
          forbidden_delivery: ["cold"],
        },
        providers: {
          dashscope: {
            model: "cosyvoice-v2",
            voice_id_env: VOICE_PROFILE_STABILITY_CASE.voiceIdEnv,
            voice_revision: 2,
            instruction_mode: "free",
          },
        },
      },
    },
  };

  function contractFactory(): AudioDescriptorFactory {
    return makeFactory({
      registry: registryOf("r02-contract", [
        {
          id: RENAME_IDENTITY_CASE.characterId,
          name: VOICE_PROFILE_STABILITY_CASE.ttsConfigName,
          initialLabel: VOICE_PROFILE_STABILITY_CASE.ttsConfigName,
          persona: "契约向量角色。",
          voiceProfileId: VOICE_PROFILE_STABILITY_CASE.voiceProfile,
        },
      ]),
      voices: contractVoices,
      env: { [VOICE_PROFILE_STABILITY_CASE.voiceIdEnv]: VOICE_PROFILE_STABILITY_CASE.voiceId },
    });
  }

  it("keeps the same voice identity for a renamed label as for the original name", () => {
    const base = {
      type: "dialogue" as const,
      text: RENAME_IDENTITY_CASE.dialogueText,
      line_id: VOICE_PROFILE_STABILITY_CASE.lineId,
      characterId: RENAME_IDENTITY_CASE.characterId,
    };
    const original = contractFactory().build(
      { ...base, speaker: VOICE_PROFILE_STABILITY_CASE.ttsConfigName },
      { type: "active" },
      "current",
    );
    const renamed = contractFactory().build(
      { ...base, speaker: RENAME_IDENTITY_CASE.renamedLabel },
      { type: "active" },
      "current",
    );

    // 原名版本与改名版本都按 characterId=female_A 解析同一音色身份：
    const originalRecipe = recipeOf(original);
    const renamedRecipe = recipeOf(renamed);
    expect(renamed, "改名标签事件必须仍解析出音色").not.toBeNull();
    expect(renamedRecipe.voiceId).toBe(VOICE_PROFILE_STABILITY_CASE.voiceId);
    expect(originalRecipe.voiceId).toBe(renamedRecipe.voiceId);
    expect(originalRecipe.voiceRevision).toBe(renamedRecipe.voiceRevision);
    expect(available(renamed).descriptor.speakerId).toBe(RENAME_IDENTITY_CASE.characterId);
  });
});
