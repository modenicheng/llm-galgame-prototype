/**
 * 角色身份契约（C1 固定基线与契约复现）——main 侧。
 *
 * 运行共享向量（src/test-support/character-contract-cases.ts，两侧工作树
 * 字节一致）外加 main 分支特有向量（世界生成的无素材动态角色）。红绿
 * 纪律：R01/R02/R03 断言期望行为，当前应当失败（红灯即规格，C2+ 转绿）；
 * R09 解析对照固定当前缺陷行为（待消除，非未来兼容规范）＋main 动态
 * 世界向量（M1 已转绿：无素材角色经 canon→roster→registry 形成完整身份）。
 *
 * 覆盖计划需求：R01（改名后上下文仍携带 female_A）、R02（音色跨标签
 * 稳定）、R03（renderTemplate 字面单遍，模块由 C6 落地）、R09（冒号
 * 全半角解析分歧，待消除）＋main 动态世界向量（无素材角色须经现入口
 * 形成完整 registry）。向量全部走真实公开 API：parseDslLine →
 * compileEventGroups → serializeStoryContext / AudioDescriptorFactory.build /
 * WorldGenerator.generate + loadAssetCatalog + rosterFromCanonCharacters +
 * createCharacterRegistry。
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RENAME_IDENTITY_CASE,
  VOICE_PROFILE_STABILITY_CASE,
  TEMPLATE_LITERAL_CASE,
  PARSE_COLON_DIVERGENCE_CASE,
} from "./test-support/character-contract-cases.js";
import { parseDslLine } from "./core/protocol/gal-dsl/line-parser.js";
import { compileEventGroups } from "./core/protocol/gal-dsl/compiler.js";
import type { CompiledMainEvent, EventGroupDraft } from "./core/protocol/gal-dsl/types.js";
import type {
  CharacterRegistry,
  CharacterRegistryEntry,
} from "./core/presentation/types.js";
import {
  createDefaultsFromRegistry,
  createInitialVisualState,
} from "./core/presentation/defaults.js";
import { createVisualStateReducer } from "./core/presentation/reducer.js";
import { serializeStoryContext } from "./story/context-builder.js";
import {
  buildCharacterRoster,
  createCharacterRegistry,
} from "./core/characters/registry.js";
import type {
  CharacterRegistry as RosterRegistry,
} from "./core/characters/types.js";
import type { AssetCatalog } from "./core/assets/types.js";
import type { StoryContextEvent } from "./schema.js";
import {
  AudioDescriptorFactory,
  type AudioDescriptorFactoryOptions,
} from "./application/audio/audio-descriptor-factory.js";
import type { VoicesConfig } from "./config/voices.js";
import type { PerformanceCompiler } from "./application/audio/performance-compiler.js";
import { WorldGenerator } from "./application/world/world-generator.js";
import type { OutlineWriterPort, WorldDraft } from "./application/outline/outline-writer.js";
import { loadAssetCatalog } from "./application/assets/asset-catalog-loader.js";
import { CanonStore } from "./adapters/storage/canon-store.js";
import { rosterFromCanonCharacters } from "./application/characters/world-roster.js";

// ---------------------------------------------------------------------------
// R01 helpers — drive the real parse → compile pipeline for one dialogue line
// ---------------------------------------------------------------------------

const FEMALE_A_ENTRY: CharacterRegistryEntry = {
  characterId: RENAME_IDENTITY_CASE.characterId,
  scriptName: RENAME_IDENTITY_CASE.scriptName,
  displayName: RENAME_IDENTITY_CASE.scriptName,
  spriteSet: RENAME_IDENTITY_CASE.characterId,
  defaultVariant: "base",
  defaultPosition: "right",
  allowedSpriteSets: [RENAME_IDENTITY_CASE.characterId],
};

function registryWith(entry: CharacterRegistryEntry): CharacterRegistry {
  return {
    resolveByScriptName(name) {
      return entry.scriptName === name ? entry : undefined;
    },
    resolveById(id) {
      return entry.characterId === id || entry.scriptName === id ? entry : undefined;
    },
    entries() {
      return [entry];
    },
  };
}

/**
 * C2 roster registry for the R01 vector（C5 形状适配：serializeStoryContext
 * 改为显式携带 registry 的身份稳定投影；断言语义不变——序列化结果仍须
 * 包含稳定内部 id female_A）。
 */
function contractRosterRegistry(): RosterRegistry {
  const assets: AssetCatalog = {
    guidance: "",
    backgrounds: {},
    bgm: {},
    soundEffects: {},
    spriteSets: {},
    characters: {},
  };
  return createCharacterRegistry(
    buildCharacterRoster({
      schemaVersion: 2,
      scopeId: "r01-contract",
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

/** Parse + compile one dialogue header line the way the runtime pipeline does. */
function compileDialogueLine(line: string): CompiledMainEvent {
  const known = new Set([FEMALE_A_ENTRY.scriptName, FEMALE_A_ENTRY.characterId]);
  const parsed = parseDslLine(line, known);
  expect(parsed.kind).toBe("dialogue");
  const draft: EventGroupDraft = {
    prelude: [],
    main: {
      type: "dialogue",
      speaker: parsed.kind === "dialogue" ? parsed.speaker : "",
      text: parsed.kind === "dialogue" ? parsed.text : "",
      visual: parsed.kind === "dialogue" ? parsed.visual : { hasVisual: false, resetVisual: false },
      name: parsed.kind === "dialogue" ? parsed.name : { hasName: false, resetName: false },
    },
  };
  const registry = registryWith(FEMALE_A_ENTRY);
  const defaults = createDefaultsFromRegistry(registry);
  const { groups } = compileEventGroups([draft], {
    registry,
    tailState: createInitialVisualState(),
    reduce: createVisualStateReducer(defaults),
    defaultsFor: defaults.defaultFor.bind(defaults),
  });
  return groups[0]!.main;
}

/** Stored dialogue event exactly as the runtime persists it after compilation. */
function storedDialogue(
  main: CompiledMainEvent,
  seq: number,
): StoryContextEvent {
  if (main.type !== "dialogue") throw new Error("contract vector expects a dialogue main event");
  return {
    type: "dialogue",
    characterId: main.characterId,
    speaker: main.speaker,
    text: main.text,
    line_id: `contract_line_${seq}`,
    seq,
    turn: 1,
    timestamp: "2026-09-19T00:00:00.000Z",
    source: "model",
  };
}

// ---------------------------------------------------------------------------
// R02 helpers — production-shaped TTS config (keyed by a config id that is
// NOT the asset registry id; that key-space split is the defect site)
// ---------------------------------------------------------------------------

const stubCompiler: PerformanceCompiler = {
  compile: () => ({
    rate: 1,
    pitch: 1,
    volume: 1,
    pauseBeforeMs: 0,
    pauseAfterMs: 0,
  }),
};

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

const contractCharacters: AudioDescriptorFactoryOptions["characters"] = {
  [VOICE_PROFILE_STABILITY_CASE.ttsConfigKey]: {
    name: VOICE_PROFILE_STABILITY_CASE.ttsConfigName,
    voice_profile: VOICE_PROFILE_STABILITY_CASE.voiceProfile,
  },
};

function contractFactory(): AudioDescriptorFactory {
  return new AudioDescriptorFactory({
    characters: contractCharacters,
    voices: contractVoices,
    provider: "dashscope",
    modelProfile: "cosyvoice_v3_flash",
    sampleRate: 22050,
    format: "pcm_s16le",
    env: { [VOICE_PROFILE_STABILITY_CASE.voiceIdEnv]: VOICE_PROFILE_STABILITY_CASE.voiceId },
    compiler: stubCompiler,
    seedFor: () => 42,
  });
}

// ---------------------------------------------------------------------------
// Shared vectors
// ---------------------------------------------------------------------------

describe("character identity contract — shared vectors (C1)", () => {
  it("R01: 改名后发给模型的上下文仍携带 female_A（期望行为，当前红灯）", () => {
    const original = compileDialogueLine(RENAME_IDENTITY_CASE.originalLine);
    const renamed = compileDialogueLine(RENAME_IDENTITY_CASE.renamedLine);

    // 编译层今天已保持稳定 id（绿灯部分，缺陷定位用）：
    expect(original).toMatchObject({
      type: "dialogue",
      characterId: RENAME_IDENTITY_CASE.characterId,
      speaker: RENAME_IDENTITY_CASE.scriptName,
    });
    expect(renamed).toMatchObject({ type: "dialogue", characterId: RENAME_IDENTITY_CASE.characterId });

    // 缺陷（红灯）：serializeStoryContext 只输出 event.speaker（显示名
    // 「神秘女子」），稳定 characterId 丢失——下一请求里模型无从得知
    // 神秘女子 = female_A，只能凭显示名写行头，身份链就此断裂。
    const serialized = serializeStoryContext(
      [storedDialogue(renamed, 1)],
      contractRosterRegistry(),
    );
    expect(serialized).toContain(RENAME_IDENTITY_CASE.characterId);
  });

  it("R02: 改名标签事件的音色必须等于原姓名版本（期望行为，当前红灯）", () => {
    const factory = contractFactory();
    const base = {
      type: "dialogue" as const,
      text: RENAME_IDENTITY_CASE.dialogueText,
      line_id: VOICE_PROFILE_STABILITY_CASE.lineId,
      characterId: RENAME_IDENTITY_CASE.characterId,
    };
    const original = factory.build(
      { ...base, speaker: VOICE_PROFILE_STABILITY_CASE.ttsConfigName },
      { type: "active" },
      "current",
    );
    const renamed = factory.build(
      { ...base, speaker: RENAME_IDENTITY_CASE.renamedLabel },
      { type: "active" },
      "current",
    );

    // 原名版本靠 byName 兜底命中音色（现状，绿）：
    expect(original).not.toBeNull();
    expect(original!.recipe.voiceId).toBe(VOICE_PROFILE_STABILITY_CASE.voiceId);

    // 缺陷（红灯）：改名标签版本 byId（characters 无 female_A 键）/
    // bySpeaker（键是 xuwanqing）/byName（名字是许晚晴）三路全 miss，
    // build 返回 null——角色一行台词静默失去声音。
    expect(renamed).not.toBeNull();
    expect(renamed!.recipe.voiceId).toBe(original!.recipe.voiceId);
    expect(renamed!.recipe.voiceRevision).toBe(original!.recipe.voiceRevision);
    expect(renamed!.descriptor.speakerId).toBe(RENAME_IDENTITY_CASE.characterId);
  });

  it("R03: renderTemplate 字面单遍替换（期望行为，当前红灯——模块由 C6 落地）", async () => {
    // 计划路径 src/application/prompts/template.ts 尚不存在：导入失败即
    // 预期红灯。用变量限定符做动态导入（相对 import.meta.url 解析，模块
    // 落地后本用例无需改动即可转绿），并让本文件其余向量照常运行、红灯
    // 原因可单独归因。
    const moduleUrl = new URL(TEMPLATE_LITERAL_CASE.plannedModule, import.meta.url).href;
    const module: { renderTemplate: (template: string, values: Record<string, string>) => string } =
      await import(/* @vite-ignore */ moduleUrl);
    // 值里的 "$&"（String.replace 替换模式）与 "{nonce}"（占位符回声）
    // 都是字面量：单遍替换，绝不二次展开。
    expect(
      module.renderTemplate(TEMPLATE_LITERAL_CASE.template, TEMPLATE_LITERAL_CASE.values),
    ).toBe(TEMPLATE_LITERAL_CASE.expected);
  });

  it("R09 解析对照（固定当前行为，待消除）：未注册说话人的半角/全角冒号结果不同", () => {
    // 不传 knownSpeakers（未注册「神秘女子」）：半角冒号走 dialogue 正则
    // 直接命中，凭空造出 speaker=神秘女子 的幻影身份；全角冒号因说话人
    // 未注册不做归一化，整行降级 narration。同一句台词、两种冒号、两种
    // 身份——固定为待消除行为快照，不作为未来兼容规范。
    const ascii = parseDslLine(PARSE_COLON_DIVERGENCE_CASE.asciiColonLine);
    const fullwidth = parseDslLine(PARSE_COLON_DIVERGENCE_CASE.fullwidthColonLine);

    expect(ascii).toMatchObject({
      kind: "dialogue",
      speaker: PARSE_COLON_DIVERGENCE_CASE.unregisteredSpeaker,
      text: PARSE_COLON_DIVERGENCE_CASE.dialogueText,
    });
    expect(fullwidth).toMatchObject({
      kind: "narration",
      text: PARSE_COLON_DIVERGENCE_CASE.fullwidthColonLine,
    });
  });
});

// ---------------------------------------------------------------------------
// Main 分支向量 — 世界生成的无素材动态角色
// ---------------------------------------------------------------------------

describe("character identity contract — main dynamic-world vector", () => {
  it("世界生成的无素材动态角色必须经现入口形成完整 registry（期望行为，当前红灯）", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "contract-world-"));
    try {
      // 无素材动态角色：无立绘绑定（spriteBinding 缺省）、无音频画像
      // （voice 缺省）——计划约束：角色可以无立绘、无音色，但身份不得
      // 因此丢失。M1 起生成世界必须显式玩家（lin_che 为 player）。
      const draft: WorldDraft = {
        worldSetting: "契约向量临时世界。",
        characters: [
          { id: "su_yao", name: "苏遥", description: "转学生。", control: "npc", spriteBinding: "suyao" },
          { id: "lin_che", name: "林澈", description: "主人公，好奇心旺盛。", control: "player" },
        ],
        outline: [
          { id: "ol_act_1", purpose: "相遇", kind: "act", status: "planned" },
        ],
      };
      const writer: OutlineWriterPort = {
        writeOutline: async () => draft,
      };
      const { gameId } = await new WorldGenerator({
        writer,
        gamesRoot: root,
        newGameId: () => "game_contract",
      }).generate({ userText: "契约向量临时世界" });

      // 生成的游戏确实携带该角色（world/canon.json 脚手架，绿灯部分）：
      const canonRaw = JSON.parse(
        await readFile(path.join(root, gameId, "world", "canon.json"), "utf8"),
      ) as { characters: Array<{ id: string }> };
      expect(canonRaw.characters.some((character) => character.id === "lin_che")).toBe(true);

      // M1 运行时入口：registry 由当前游戏 canon 构建（roster 模式），
      // 素材目录只提供资源绑定校验——与 bootstrap 同一装配路径。
      const catalogPath = fileURLToPath(new URL("../assets/resources.yaml", import.meta.url));
      const assets = await loadAssetCatalog(catalogPath);
      const canon = await new CanonStore(root, gameId).load();
      const roster = rosterFromCanonCharacters({
        scopeId: `world:${gameId}`,
        characters: canon.characters,
        assets,
      });
      const registry = createCharacterRegistry(roster, assets);

      // 断言语义（M1 转绿）：无素材动态角色在运行时 registry 中完整存在，
      // 模型按角色卡行头写出的 ID 能解析回同一身份；缺资源不丢身份。
      const byId = registry.get("lin_che");
      expect(byId).toBeDefined();
      expect(byId!.id).toBe("lin_che");
      expect(registry.require("lin_che").control).toBe("player");
      expect(registry.get("su_yao")!.control).toBe("npc");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
