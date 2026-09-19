/**
 * 任务协议卡生成（C6，计划 §5.2/§5.4）——示例必须真实可编译。
 *
 * 覆盖：双协议版本（v1 legacy 行式 / v2 显式指令）、每个任务的卡示例
 * 经**真实** parser/compiler 解析编译（v1：parseDslLine → DslSegmentParser
 * → compileEventGroups；v2：compileSegmentV2）、main 真实内容包 roster、无
 * presentation 的 fallback roster（main/动态世界形态）、空 NPC cast 的
 * narration-only 示例、provenance 来源信息、确定性输出、共享模板无内容
 * 包专名、修复卡派生。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProtocolCard, bindProtocolCardNonce } from "./protocol-card.js";
import { dslTaskCapability, type BaseDslTaskType } from "../../core/protocol/gal-dsl/capabilities.js";
import {
  buildCharacterRoster,
  createCharacterRegistry,
} from "../../core/characters/registry.js";
import { loadCharacterPackRoster } from "../../adapters/static/character-pack-loader.js";
import type {
  CharacterDefinition,
  CharacterRegistry,
  CastContext,
} from "../../core/characters/types.js";
import type { AssetCatalog } from "../../core/assets/types.js";
import { toCharacterRegistry } from "../../core/assets/catalog.js";
import { parseDslLine } from "../../core/protocol/gal-dsl/line-parser.js";
import { DslSegmentParser } from "../../core/protocol/gal-dsl/segment-validator.js";
import { compileEventGroups, compileSegmentV2 } from "../../core/protocol/gal-dsl/compiler.js";
import {
  createDefaultsFromRegistry,
  createInitialVisualState,
  createPresentationDefaultsFromRoster,
} from "../../core/presentation/defaults.js";
import { createVisualStateReducer } from "../../core/presentation/reducer.js";
import { createCharacterRuntimeState } from "../../core/characters/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASKS: readonly BaseDslTaskType[] = [
  "opening",
  "continuation",
  "branch_prefetch",
  "input_response",
  "input_bridge",
];

/** 带 presentation 的 NPC + 玩家（内容包形态的最小合成）。 */
function fullDefinitions(): CharacterDefinition[] {
  return [
    { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
    {
      id: "heroine",
      name: "测试角色",
      control: "npc",
      initialLabel: "测试角色",
      persona: "测试人设。",
      presentation: {
        defaultLook: "base",
        defaultPosition: "right",
        looks: {
          base: { spriteSet: "heroine", variant: "base" },
          smile: { spriteSet: "heroine", variant: "smile" },
        },
      },
    },
  ];
}

/** 无 presentation 的 NPC（main fallback / 动态世界形态）。 */
function bareDefinitions(): CharacterDefinition[] {
  return [
    { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
    { id: "wanderer", name: "过客", control: "npc", initialLabel: "过客", persona: "无立绘角色。" },
  ];
}

const FULL_ASSETS: AssetCatalog = {
  guidance: "",
  backgrounds: { corridor: { id: "corridor", src: "b.jpg", description: "走廊" } },
  bgm: { calm: { id: "calm", src: "m.mp3", description: "平静" } },
  soundEffects: { door: { id: "door", src: "d.mp3", description: "开门" } },
  spriteSets: {
    heroine: {
      id: "heroine",
      variants: {
        base: { id: "base", src: "a.png", description: "" },
        smile: { id: "smile", src: "a2.png", description: "" },
      },
    },
  },
};

const BARE_ASSETS: AssetCatalog = {
  guidance: "",
  backgrounds: {},
  bgm: {},
  soundEffects: {},
  spriteSets: {},
};

function registryOf(definitions: CharacterDefinition[], assets: AssetCatalog): CharacterRegistry {
  return createCharacterRegistry(
    buildCharacterRoster({
      schemaVersion: 2,
      scopeId: "card-test",
      playerId: "player_one",
      characters: definitions,
    }),
    assets,
  );
}

function fullCast(): CastContext {
  return { allowedSpeakerIds: ["heroine"], sceneParticipantIds: ["player_one", "heroine"] };
}

function bareCast(): CastContext {
  return { allowedSpeakerIds: ["wanderer"], sceneParticipantIds: ["player_one", "wanderer"] };
}

function emptyCast(): CastContext {
  return { allowedSpeakerIds: [], sceneParticipantIds: ["player_one"] };
}

/** main 真实内容包 roster（characters.yaml 静态 fallback 世界）：spriteSets 由 looks 机械派生（1:1）。 */
async function packRegistry(): Promise<CharacterRegistry> {
  const rosterPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../characters.yaml",
  );
  const roster = await loadCharacterPackRoster(rosterPath);
  const spriteSets: AssetCatalog["spriteSets"] = {};
  for (const definition of roster.characters) {
    for (const look of Object.values(definition.presentation?.looks ?? {})) {
      const set = (spriteSets[look.spriteSet] ??= { id: look.spriteSet, variants: {} });
      set.variants[look.variant] = { id: look.variant, src: "synthetic.png", description: "" };
    }
  }
  const assets: AssetCatalog = {
    guidance: "",
    backgrounds: { campus_plaza: { id: "campus_plaza", src: "b.jpg", description: "广场" } },
    bgm: {},
    soundEffects: {},
    spriteSets,
  };
  return createCharacterRegistry(roster, assets);
}

function packCast(registry: CharacterRegistry): CastContext {
  const npcIds = registry.roster.characters
    .filter((definition) => definition.control === "npc")
    .map((definition) => definition.id);
  return { allowedSpeakerIds: npcIds, sceneParticipantIds: npcIds };
}

// ---------------------------------------------------------------------------
// 真实编译验证：v1（parse → segment parser → compile）与 v2（compileSegmentV2）
// ---------------------------------------------------------------------------

const TEST_NONCE = "81ab";

/** v1 全链路：每行 parseDslLine → DslSegmentParser（哨兵/表单校验）→ compileEventGroups。 */
function compileV1Example(exampleText: string, registry: CharacterRegistry, assets: AssetCatalog): void {
  const bound = bindProtocolCardNonce(exampleText, TEST_NONCE);
  // C7：toCharacterRegistry 直接从 roster 派生 v1 展示注册表。
  const presentationRegistry = toCharacterRegistry(registry.roster);
  const known = new Set<string>();
  for (const entry of presentationRegistry.entries()) {
    known.add(entry.scriptName);
    known.add(entry.characterId);
  }
  const parser = new DslSegmentParser({
    expectedNonce: TEST_NONCE,
    allowedReasons: ["buffer", "interaction", "ending"],
  });
  const drafts = [];
  for (const rawLine of bound.split("\n")) {
    const parsed = parseDslLine(rawLine, known);
    drafts.push(...parser.pushLine(parsed));
  }
  const { groups, status } = parser.finish();
  expect(status.kind, `v1 示例必须完整收束：${bound}`).toBe("complete");
  drafts.push(...groups);
  const defaults = createDefaultsFromRegistry(presentationRegistry);
  const { groups: compiled } = compileEventGroups(drafts, {
    registry: presentationRegistry,
    tailState: createInitialVisualState(),
    reduce: createVisualStateReducer(defaults),
    defaultsFor: defaults.defaultFor.bind(defaults),
  });
  // 纯哨兵示例（结局收束示例）合法地没有可播放组；其余示例必须产出组。
  if (!bound.startsWith("@end")) {
    expect(compiled.length, `v1 示例必须编译出可播放组：${bound}`).toBeGreaterThan(0);
  } else {
    expect(status.kind === "complete" && status.reason).toBe("ending");
  }
}

/** v2 全链路：compileSegmentV2（v2 解析 → 分组 → 能力/身份/资源校验 → 归约）。 */
function compileV2Example(
  exampleText: string,
  registry: CharacterRegistry,
  assets: AssetCatalog,
  task: BaseDslTaskType,
  cast: CastContext,
): void {
  const bound = bindProtocolCardNonce(exampleText, TEST_NONCE);
  const result = compileSegmentV2({
    text: bound,
    expectedNonce: TEST_NONCE,
    task,
    registry,
    cast,
    reduce: createVisualStateReducer(createPresentationDefaultsFromRoster(registry)),
    visualState: createInitialVisualState(),
    characterState: createCharacterRuntimeState(),
    catalog: assets,
  });
  expect(
    result.ok,
    `v2 示例必须编译通过（${task}）：${bound}\n诊断：${JSON.stringify(result.diagnostics)}`,
  ).toBe(true);
  expect(result.status.kind).toBe("complete");
  // 纯哨兵示例（结局收束示例）合法地没有可播放组；其余示例必须产出组。
  if (!bound.startsWith("@end")) {
    expect(result.groups.length).toBeGreaterThan(0);
  } else {
    expect(result.status.kind === "complete" && result.status.reason).toBe("ending");
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("buildProtocolCard — 结构与 provenance", () => {
  it("v1 卡规则用 legacy 行式表面形态描述能力（不出现 v2 的 @say/@n 指令）", () => {
    const card = buildProtocolCard({
      task: "input_bridge",
      registry: registryOf(fullDefinitions(), FULL_ASSETS),
      cast: fullCast(),
      assets: FULL_ASSETS,
      protocolVersion: 1,
    });
    expect(card.rules).toContain("旁白行");
    expect(card.rules).toContain("@end <nonce> buffer");
    expect(card.rules).not.toContain("@say");
    expect(card.rules).toContain("不得以 ending 收束");
  });

  it("v2 卡规则列能力表命令集（与 dslTaskCapability 同源）", () => {
    const card = buildProtocolCard({
      task: "continuation",
      registry: registryOf(fullDefinitions(), FULL_ASSETS),
      cast: fullCast(),
      assets: FULL_ASSETS,
      protocolVersion: 2,
    });
    expect(card.rules).toContain(dslTaskCapability("continuation").commands.join(" "));
    expect(card.rules).toContain("@end <nonce> buffer|interaction|ending");
    expect(card.rules).toContain("@ending <TE|HE|NE|BE>");
  });

  it("provenance 携带来源版本（协议版本 / roster revision / 能力来源 / 示例溯源）", () => {
    const registry = registryOf(fullDefinitions(), FULL_ASSETS);
    const card = buildProtocolCard({
      task: "continuation",
      registry,
      cast: fullCast(),
      assets: FULL_ASSETS,
      protocolVersion: 2,
    });
    expect(card.provenance.protocolVersion).toBe(2);
    expect(card.provenance.rosterRevision).toBe(registry.roster.revision);
    expect(card.provenance.capabilitySource).toBe("src/core/protocol/gal-dsl/capabilities.ts");
    expect(card.provenance.exampleCharacterIds).toEqual(["heroine"]);
    expect(card.provenance.exampleAssetIds).toEqual(["corridor"]);
    // 整卡文本带版本头（来源可审计，不做隐式拼接）。
    expect(card.text).toContain("DSL 协议版本 2");
    expect(card.text).toContain(`roster:${registry.roster.revision}`);
  });

  it("确定性输出：同输入两次构建逐字节相同", () => {
    const input = {
      task: "opening" as const,
      registry: registryOf(fullDefinitions(), FULL_ASSETS),
      cast: fullCast(),
      assets: FULL_ASSETS,
      protocolVersion: 2 as const,
    };
    expect(buildProtocolCard(input).text).toBe(buildProtocolCard(input).text);
  });

  it("共享模板无内容包专名：合成 roster 的卡不含任何内容包人名", () => {
    for (const protocolVersion of [1, 2] as const) {
      const card = buildProtocolCard({
        task: "continuation",
        registry: registryOf(fullDefinitions(), FULL_ASSETS),
        cast: fullCast(),
        assets: FULL_ASSETS,
        protocolVersion,
      });
      for (const name of ["苏遥", "许晚晴", "林澈", "树莓娘", "林小满", "夏一鸣", "韩澈"]) {
        expect(card.text, `v${protocolVersion} 卡不得出现内容包专名 ${name}`).not.toContain(name);
      }
    }
  });

  it("修复卡经派生继承原任务能力，并显式声明尾部限制", () => {
    const card = buildProtocolCard({
      task: "branch_prefetch",
      repair: true,
      registry: registryOf(fullDefinitions(), FULL_ASSETS),
      cast: fullCast(),
      assets: FULL_ASSETS,
      protocolVersion: 2,
    });
    expect(card.task).toBe("protocol_repair");
    expect(card.capability.commands).toEqual(dslTaskCapability("branch_prefetch").commands);
    expect(card.provenance.baseTask).toBe("branch_prefetch");
    expect(card.rules).toContain("不改变 nonce");
  });
});

describe("buildProtocolCard — 空与受限 cast", () => {
  it("空 NPC cast：narration-only 示例，绝不硬塞示例角色", () => {
    const registry = registryOf(fullDefinitions(), FULL_ASSETS);
    for (const protocolVersion of [1, 2] as const) {
      const card = buildProtocolCard({
        task: "continuation",
        registry,
        cast: emptyCast(),
        assets: FULL_ASSETS,
        protocolVersion,
      });
      const main = card.examples[0]!;
      expect(main.text, `v${protocolVersion} 空 cast 主示例必须是仅旁白`).not.toMatch(/: |@say/);
      expect(card.provenance.exampleCharacterIds).toEqual([]);
      expect(card.text).toContain("仅旁白");
    }
  });

  it("bridge 卡不因 cast 里有 NPC 而给台词能力（能力表优先于 cast）", () => {
    const card = buildProtocolCard({
      task: "input_bridge",
      registry: registryOf(fullDefinitions(), FULL_ASSETS),
      cast: fullCast(),
      assets: FULL_ASSETS,
      protocolVersion: 2,
    });
    const main = card.examples[0]!;
    expect(main.text).not.toContain("@say");
    expect(main.text).toContain("@n ");
    expect(main.text).toContain("@end <nonce> buffer");
  });
});

describe("buildProtocolCard — 每个任务的示例都能被真实 parser/compiler 编译", () => {
  const fullRegistry = () => registryOf(fullDefinitions(), FULL_ASSETS);
  const bareRegistry = () => registryOf(bareDefinitions(), BARE_ASSETS);

  it("v1 + 合成满配 roster：全部任务、全部示例编译通过", () => {
    const registry = fullRegistry();
    for (const task of TASKS) {
      const card = buildProtocolCard({
        task,
        registry,
        cast: fullCast(),
        assets: FULL_ASSETS,
        protocolVersion: 1,
      });
      expect(card.examples.length, task).toBeGreaterThan(0);
      for (const example of card.examples) {
        compileV1Example(example.text, registry, FULL_ASSETS);
      }
    }
  });

  it("v2 + 合成满配 roster：全部任务、全部示例编译通过", () => {
    const registry = fullRegistry();
    for (const task of TASKS) {
      const card = buildProtocolCard({
        task,
        registry,
        cast: fullCast(),
        assets: FULL_ASSETS,
        protocolVersion: 2,
      });
      for (const example of card.examples) {
        compileV2Example(example.text, registry, FULL_ASSETS, task, fullCast());
      }
    }
  });

  it("fallback roster（NPC 无 presentation，main/动态世界形态）：台词示例退化为无槽行头", async () => {
    const registry = bareRegistry();
    const v1 = buildProtocolCard({
      task: "input_response",
      registry,
      cast: bareCast(),
      assets: BARE_ASSETS,
      protocolVersion: 1,
    });
    const main = v1.examples[0]!;
    expect(main.text).toContain("过客: ");
    expect(main.text).not.toContain("[");
    compileV1Example(main.text, registry, BARE_ASSETS);

    const v2 = buildProtocolCard({
      task: "input_response",
      registry,
      cast: bareCast(),
      assets: BARE_ASSETS,
      protocolVersion: 2,
    });
    const mainV2 = v2.examples[0]!;
    expect(mainV2.text).toContain("@say wanderer ");
    compileV2Example(mainV2.text, registry, BARE_ASSETS, "input_response", bareCast());
  });

  it("真实内容包 roster（characters.yaml，main 静态 fallback 世界）：双版本全部任务编译通过且示例人物来自 roster", async () => {
    const registry = await packRegistry();
    const cast = packCast(registry);
    const npcNames = registry.roster.characters
      .filter((definition) => definition.control === "npc")
      .map((definition) => definition.name);
    for (const protocolVersion of [1, 2] as const) {
      for (const task of TASKS) {
        const card = buildProtocolCard({
          task,
          registry,
          cast,
          assets: {
            guidance: "",
            backgrounds: { campus_plaza: FULL_ASSETS.backgrounds.campus_plaza! },
            bgm: {},
            soundEffects: {},
            spriteSets: FULL_ASSETS.spriteSets,
          },
          protocolVersion,
        });
        expect(card.examples.length, `${task} v${protocolVersion}`).toBeGreaterThan(0);
        for (const example of card.examples) {
          if (protocolVersion === 1) compileV1Example(example.text, registry, FULL_ASSETS);
          else compileV2Example(example.text, registry, FULL_ASSETS, task, cast);
        }
        // 示例人物确实是 roster 里的真实角色（台词示例任务）。
        if (dslTaskCapability(task).commands.includes("@say")) {
          const exampleCharacter = card.provenance.exampleCharacterIds
            .map((id) => registry.get(id)?.name)
            .find((name) => name !== undefined);
          expect(exampleCharacter, `${task} v${protocolVersion}`).toBeDefined();
          expect(npcNames).toContain(exampleCharacter);
        }
      }
    }
  });

  it("示例 nonce 绑定：<nonce> 逐字替换且不重求值", () => {
    expect(bindProtocolCardNonce("@end <nonce> buffer", "81ab")).toBe("@end 81ab buffer");
    expect(bindProtocolCardNonce("@end <nonce> <nonce>", "$&")).toBe("@end $& $&");
  });
});
