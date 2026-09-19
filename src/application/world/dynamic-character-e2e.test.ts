/**
 * M1 端到端用例：动态角色 guest_01（无立绘/无声音）在同一 ID 上贯通
 * 生成 → 保存 → 重载 → 说话 → reconcile → 导演 cast。
 *
 * 计划约束：角色可以无立绘、无音色；不允许因为缺资源而丢失身份。
 * 每一步都断言同一稳定 ID `guest_01`——名字/名牌可以变，ID 不变。
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorldGenerator, DERIVED_CARD_SOURCE_PREFIX } from "./world-generator.js";
import { CanonStore } from "../../adapters/storage/canon-store.js";
import { VoiceDesignStore } from "../../adapters/storage/voice-design-store.js";
import {
  rosterFromCanonCharacters,
  rosterCharacterIds,
} from "../characters/world-roster.js";
import { createCharacterRegistry } from "../../core/characters/registry.js";
import type { AssetCatalog } from "../../core/assets/types.js";
import type { OutlineWriterPort, WorldDraft } from "../outline/outline-writer.js";
import type { CharacterRegistry as LegacyRegistry } from "../../core/presentation/types.js";
import { EMPTY_CHARACTER_REGISTRY } from "../../core/assets/catalog.js";
import {
  createDefaultsFromRegistry,
  createInitialVisualState,
} from "../../core/presentation/defaults.js";
import { createVisualStateReducer } from "../../core/presentation/reducer.js";
import { parseDslLine } from "../../core/protocol/gal-dsl/line-parser.js";
import { compileEventGroups } from "../../core/protocol/gal-dsl/compiler.js";
import type { EventGroupDraft } from "../../core/protocol/gal-dsl/types.js";
import { reconcileStoryState } from "../../story/reconcile.js";
import { createInitialState } from "../../story/state.js";
import type { StoredEvent } from "../../schema.js";

/** 测试内联素材目录：只有 suyao 立绘集；无 characters 身份绑定（动态世界不掺 fallback cast）。 */
const ASSETS: AssetCatalog = {
  guidance: "",
  backgrounds: {},
  bgm: {},
  soundEffects: {},
  spriteSets: {
    suyao: { id: "suyao", variants: { neutral: { id: "neutral", src: "characters/suyao/neutral.png" } } },
  },
  characters: {},
};

const CHARACTER_ID = "guest_01";

function guestDraft(): WorldDraft {
  return {
    worldSetting: "深夜旧书店的临时世界。",
    characters: [
      {
        id: "player_one",
        name: "读者",
        description: "玩家控制角色：深夜来访的读者。",
        control: "player",
      },
      {
        id: "su_yao",
        name: "苏遥",
        description: "店主，安静地整理书架。",
        control: "npc",
        spriteBinding: "suyao",
        voice: { timbre: "年轻女性，清亮偏冷", delivery: ["restrained"] },
      },
      {
        // 无立绘（spriteBinding 缺省）、无声音（voice 缺省）的动态角色。
        id: CHARACTER_ID,
        name: "访客",
        description: "躲在角落读林的访客，看不清脸。",
        control: "npc",
      },
    ],
    outline: [
      { id: "ol_act_1", purpose: "深夜相遇", kind: "act", status: "planned" },
      { id: "ol_end_1", purpose: "黎明道别", kind: "ending", status: "planned" },
    ],
  };
}

/** 模型产出的一句 guest_01 台词：行头直接写稳定 ID。 */
function compileGuestLine(line: string): { characterId: string; speaker: string; text: string } {
  const known = new Set<string>([CHARACTER_ID]);
  const parsed = parseDslLine(line, known);
  expect(parsed.kind).toBe("dialogue");
  if (parsed.kind !== "dialogue") throw new Error("契约向量期望 dialogue");
  const draft: EventGroupDraft = {
    prelude: [],
    main: {
      type: "dialogue",
      speaker: parsed.speaker,
      text: parsed.text,
      visual: parsed.visual,
      name: parsed.name,
    },
  };
  // 运行时编译入口与 Game 相同：registry 来自素材目录兼容边界——动态角色
  // 不在其中时 characterId 必须原样保留行头 ID（身份不因缺素材丢失）。
  const legacy: LegacyRegistry = EMPTY_CHARACTER_REGISTRY;
  const defaults = createDefaultsFromRegistry(legacy);
  const { groups } = compileEventGroups([draft], {
    registry: legacy,
    tailState: createInitialVisualState(),
    reduce: createVisualStateReducer(defaults),
    defaultsFor: defaults.defaultFor.bind(defaults),
  });
  const main = groups[0]!.main;
  if (main.type !== "dialogue") throw new Error("编译产物应为 dialogue");
  return { characterId: main.characterId, speaker: main.speaker, text: main.text };
}

function storedDialogue(characterId: string, speaker: string, text: string, seq: number): StoredEvent {
  return {
    type: "dialogue",
    characterId,
    speaker,
    text,
    line_id: `guest_line_${seq}`,
    seq,
    turn: 1,
    timestamp: "2026-09-19T00:00:00.000Z",
    source: "model",
  } as StoredEvent;
}

describe("M1 端到端：无立绘/无声音动态角色 guest_01 保持同一 ID", () => {
  it("生成 → 保存 → 重载 → 说话 → reconcile → 导演 cast 全链路同一 ID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guest-e2e-"));
    try {
      // --- 生成 + 保存 ---
      const writer: OutlineWriterPort = { writeOutline: async () => guestDraft() };
      const { gameId } = await new WorldGenerator({
        writer,
        gamesRoot: root,
        newGameId: () => "game_guest",
        assets: ASSETS,
      }).generate({ userText: "深夜旧书店" });

      // canon 落盘携带权威元信息（control/initialLabel）。
      const canonRaw = JSON.parse(
        await readFile(path.join(root, gameId, "world", "canon.json"), "utf8"),
      ) as { characters: Array<{ id: string; control?: string; initialLabel?: string }> };
      const savedGuest = canonRaw.characters.find((c) => c.id === CHARACTER_ID);
      expect(savedGuest).toMatchObject({ control: "npc", initialLabel: "访客" });

      // voice-design 按 ID join：只有 su_yao 有画像；guest_01 无画像不是缺陷。
      const designs = await new VoiceDesignStore(root, gameId).load();
      expect(Object.keys(designs?.characters ?? {})).toEqual(["su_yao"]);

      // 派生人物卡携带来源 revision 头。
      const card = await readFile(
        path.join(root, gameId, "world", "prompts", "characters.txt"),
        "utf8",
      );
      expect(card.startsWith(DERIVED_CARD_SOURCE_PREFIX)).toBe(true);

      // --- 重载（「继续游戏」入口：从当前游戏 canon 构建 registry）---
      const canon = await new CanonStore(root, gameId).load();
      const roster = rosterFromCanonCharacters({
        scopeId: `world:${gameId}`,
        characters: canon.characters,
        assets: ASSETS,
      });
      const registry = createCharacterRegistry(roster, ASSETS);

      // 无素材动态角色在 registry 中完整存在；缺资源不丢身份。
      const guest = registry.require(CHARACTER_ID);
      expect(guest.control).toBe("npc");
      expect(guest.persona).toContain("访客");
      expect(roster.playerId).toBe("player_one");

      // --- 说话（模型行头 = 稳定 ID）---
      const line = compileGuestLine("guest_01：这本书……还没有人翻开过吧。");
      expect(line.characterId).toBe(CHARACTER_ID);

      // --- reconcile（known 集来自 roster，不再被全局素材目录挡在门外）---
      const event = storedDialogue(line.characterId, line.speaker, line.text, 1);
      const state = reconcileStoryState(createInitialState(), [event], {
        knownCharacterIds: rosterCharacterIds(roster),
      });
      expect(Object.keys(state.characters)).toContain(CHARACTER_ID);

      // --- 导演 cast（Game 侧 triggerDirective 的 cast 参数来源）---
      const cast = Object.keys(state.characters);
      expect(cast).toContain(CHARACTER_ID);

      // 全链路同一 ID：保存、registry、台词、reconcile、cast。
      expect(savedGuest?.id).toBe(CHARACTER_ID);
      expect(guest.id).toBe(CHARACTER_ID);
      expect(line.characterId).toBe(CHARACTER_ID);
      expect(cast[cast.indexOf(CHARACTER_ID)]).toBe(CHARACTER_ID);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
