/**
 * WorldGenerator tests（执行清单 M3.3 验收 + M1 roster/玩家契约）：fake
 * writer 下落盘文件齐全、outline revision=1、prompts 覆盖生效；空描述大声
 * 报错；创建前校验（重复/非法 ID、玩家数、非法 spriteBinding、动态-author
 * 冲突、玩家画像）在任何正式世界文件落盘前失败；canon 携带 control/
 * initialLabel；人物卡为携带来源 revision 的派生产物。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WorldGenerator,
  renderCharacters,
  renderStoryLine,
  DERIVED_CARD_SOURCE_PREFIX,
  ensureDerivedCharacterCard,
} from "./world-generator.js";
import { OutlineStore } from "../../adapters/storage/outline-store.js";
import { CanonStore } from "../../adapters/storage/canon-store.js";
import { loadPrompts } from "../../prompts.js";
import { rosterFromCanonCharacters } from "../characters/world-roster.js";
import type { OutlineWriterPort, WorldDraft, DraftCharacter } from "../outline/outline-writer.js";
import type { AssetCatalog } from "../../core/assets/types.js";

/** 测试内联素材目录（不触真实资源文件）：suyao 立绘集存在。 */
const ASSETS: AssetCatalog = {
  guidance: "",
  backgrounds: {},
  bgm: {},
  soundEffects: {},
  spriteSets: {
    suyao: { id: "suyao", variants: { neutral: { id: "neutral", src: "characters/suyao/neutral.png" } } },
  },
};

const DRAFT: WorldDraft = {
  worldSetting: "平行世界的学园都市，超能力与日常交织。",
  characters: [
    {
      id: "su_yao",
      name: "苏遥",
      description: "转学生，随身带着旧终端。",
      control: "npc",
      spriteBinding: "suyao",
    },
    { id: "lin_che", name: "林澈", description: "主人公（玩家控制），好奇心旺盛。", control: "player" },
  ],
  outline: [
    { id: "ol_act_1", purpose: "转学生登场，旧终端首次异动", kind: "act", status: "planned", location: "教室" },
    { id: "ol_act_2", purpose: "放学后共同调查终端来历", kind: "act", status: "planned", location: "旧校舍" },
    { id: "ol_end_true", purpose: "知晓终端真相并接纳彼此", kind: "ending", status: "planned", location: "旧校舍" },
  ],
};

describe("WorldGenerator", () => {
  let root: string;
  let writer: OutlineWriterPort;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "world-gen-"));
    writer = { writeOutline: vi.fn(async () => DRAFT) };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const makeGen = () =>
    new WorldGenerator({
      writer,
      gamesRoot: root,
      newGameId: () => "game_test_fixed",
      assets: ASSETS,
    });

  it("writes outline (revision 1), canon scaffold and per-game prompts", async () => {
    const { gameId } = await makeGen().generate({ userText: "学园都市题材" });
    expect(gameId).toBe("game_test_fixed");
    expect(writer.writeOutline).toHaveBeenCalledOnce();

    // outline 落盘且 revision = 1
    const store = new OutlineStore(root, gameId);
    const snap = await store.load();
    expect(snap.revision).toBe(1);
    expect(snap.nodes.map((n) => n.id)).toEqual(["ol_act_1", "ol_act_2", "ol_end_true"]);
    expect(snap.nodes.every((n) => n.status === "planned")).toBe(true);

    // world/canon.json 脚手架（M3.6 对齐形状 + M1 权威元信息）
    const canon = JSON.parse(
      await readFile(path.join(root, gameId, "world", "canon.json"), "utf8"),
    );
    expect(canon.worldSetting).toContain("学园都市");
    expect(canon.characters).toHaveLength(2);
    expect(canon.characters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "su_yao", control: "npc", initialLabel: "苏遥" }),
        expect.objectContaining({ id: "lin_che", control: "player", initialLabel: "林澈" }),
      ]),
    );
    expect(canon.promotedFacts).toEqual([]);
    expect(canon.exceptions).toEqual([]);

    // per-game prompts：characters.txt 是携带来源 revision 的派生卡。
    const characters = await readFile(
      path.join(root, gameId, "world", "prompts", "characters.txt"),
      "utf8",
    );
    expect(characters.startsWith(DERIVED_CARD_SOURCE_PREFIX)).toBe(true);
    expect(characters).toContain("【苏遥】(su_yao)");
    expect(characters).toContain("立绘绑定：suyao");
    expect(characters).toContain("【林澈】(lin_che)");
    // 玩家契约投影进卡：模型不得替玩家角色写台词。
    expect(characters.split("【林澈】")[1]).toContain("玩家");
    const storyLine = await readFile(
      path.join(root, gameId, "world", "prompts", "story_line.txt"),
      "utf8",
    );
    expect(storyLine).toContain("【世界设定】");
    expect(storyLine).toContain("转学生登场");
    // 结局目的不进 story_line（防剧透）
    expect(storyLine).not.toContain("知晓终端真相");
  });

  it("throws loudly on an empty description without touching disk", async () => {
    await expect(makeGen().generate({ userText: "   " })).rejects.toThrow(/不能为空/);
  });

  it("propagates writer failures loudly (no silent fallback)", async () => {
    const failing: OutlineWriterPort = {
      writeOutline: vi.fn(async () => {
        throw new Error("outline 输出解析失败");
      }),
    };
    await expect(
      new WorldGenerator({ writer: failing, gamesRoot: root }).generate({ userText: "x" }),
    ).rejects.toThrow("outline 输出解析失败");
  });
});

describe("per-game prompts override (loadPrompts)", () => {
  it("prefers per-game characters/story_line over global prompts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "world-gen-prompts-"));
    try {
      const promptsDir = path.join(root, "game_x", "world", "prompts");
      const { mkdir: mkdirFs, writeFile: writeFileFs } = await import("node:fs/promises");
      await mkdirFs(promptsDir, { recursive: true });
      await writeFileFs(path.join(promptsDir, "characters.txt"), "PER_GAME_CHAR", "utf8");
      await writeFileFs(path.join(promptsDir, "story_line.txt"), "PER_GAME_STORY", "utf8");

      const loaded = await loadPrompts("prompts", promptsDir);
      expect(loaded.bundle.characters).toBe("PER_GAME_CHAR");
      expect(loaded.bundle.storyLine).toBe("PER_GAME_STORY");
      // 其余段回退全局
      expect(loaded.bundle.guideline.length).toBeGreaterThan(0);
      expect(loaded.bundle.dslProtocol.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails loudly when the per-game dir lacks story_line.txt (M3.7, no global fallback)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "world-gen-prompts-empty-"));
    try {
      const emptyDir = path.join(root, "empty-prompts");
      const { mkdir: mkdirFs } = await import("node:fs/promises");
      await mkdirFs(emptyDir, { recursive: true });
      await expect(loadPrompts("prompts", emptyDir)).rejects.toThrow(/story_line\.txt 缺失/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("draft renderers", () => {
  it("renderCharacters lists each character with id header and control line", () => {
    const text = renderCharacters(DRAFT.characters);
    expect(text).toContain("【苏遥】(su_yao)");
    expect(text).toContain("【林澈】(lin_che)");
    expect(text.split("【林澈】")[1]).toContain("控制：玩家");
    expect(text.split("【苏遥】")[1]).toContain("控制：NPC");
  });

  it("renderStoryLine includes setting and act purposes only", () => {
    const text = renderStoryLine(DRAFT);
    expect(text).toContain("平行世界");
    expect(text).toContain("旧校舍");
    expect(text).not.toContain("ol_end");
  });
});

describe("WorldGenerator — 编剧音频画像（V2）", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "world-gen-voice-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes voice-design.json for designed characters and renders the voice line", async () => {
    const draft: WorldDraft = {
      ...DRAFT,
      characters: [
        {
          id: "su_yao",
          name: "苏遥",
          description: "转学生。",
          control: "npc",
          voice: {
            timbre: "年轻女性，清亮偏冷",
            delivery: ["restrained", "firm"],
            avoid: ["playful"],
            baseline: { pace: "slow" },
          },
        },
        { id: "lin_che", name: "林澈", description: "主人公。", control: "player" },
      ],
    };
    const gen = new WorldGenerator({
      writer: { writeOutline: vi.fn(async () => draft) },
      gamesRoot: root,
      newGameId: () => "game_voice_fixed",
    });
    const { gameId } = await gen.generate({ userText: "学园都市题材" });

    const stored = JSON.parse(
      await readFile(path.join(root, gameId, "world", "voice-design.json"), "utf8"),
    );
    const design = draft.characters[0]?.voice;
    expect(design).toBeDefined();
    expect(stored).toEqual({ version: 1, characters: { su_yao: { name: "苏遥", voice: design } } });

    const charactersTxt = await readFile(
      path.join(root, gameId, "world", "prompts", "characters.txt"),
      "utf8",
    );
    expect(charactersTxt).toContain("嗓音：年轻女性，清亮偏冷");
    // 无画像角色不渲染嗓音行 —— 林澈段内没有
    expect(charactersTxt.split("【林澈】")[1]).not.toContain("嗓音");
  });

  it("writes no voice-design.json when no character has a design", async () => {
    const gen = new WorldGenerator({
      writer: { writeOutline: vi.fn(async () => DRAFT) },
      gamesRoot: root,
      newGameId: () => "game_no_voice",
    });
    const { gameId } = await gen.generate({ userText: "学园都市题材" });
    await expect(
      readFile(path.join(root, gameId, "world", "voice-design.json"), "utf8"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M1：创建前校验 —— 任何正式世界文件落盘之前失败（不写半成品世界）
// ---------------------------------------------------------------------------

describe("WorldGenerator — 创建前校验（M1）", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "world-gen-validate-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 断言：generate 以 code 拒绝，且 games/<gameId> 目录根本不存在。 */
  async function expectRejectedBeforeWrite(
    characters: DraftCharacter[],
    code: RegExp,
    options?: { assets?: AssetCatalog; authorCharacterIds?: readonly string[] },
  ): Promise<void> {
    const draft: WorldDraft = { ...DRAFT, characters };
    const gen = new WorldGenerator({
      writer: { writeOutline: vi.fn(async () => draft) },
      gamesRoot: root,
      newGameId: () => "game_invalid",
      ...(options?.assets !== undefined ? { assets: options.assets } : {}),
      ...(options?.authorCharacterIds !== undefined
        ? { authorCharacterIds: options.authorCharacterIds }
        : {}),
    });
    await expect(gen.generate({ userText: "x" })).rejects.toThrow(code);
    expect(existsSync(path.join(root, "game_invalid"))).toBe(false);
  }

  it("重复 ID：在写任何正式世界文件前失败", async () => {
    await expectRejectedBeforeWrite(
      [
        { id: "player_one", name: "玩家", description: "x", control: "player" },
        { id: "player_one", name: "重名", description: "x", control: "npc" },
      ],
      /duplicate_character_id/,
    );
  });

  it("非法 ID：拒绝空白/危险键 ID", async () => {
    await expectRejectedBeforeWrite(
      [
        { id: "player_one", name: "玩家", description: "x", control: "player" },
        { id: "神秘 嘉宾", name: "空格", description: "x", control: "npc" },
      ],
      /invalid_character_id/,
    );
    await expectRejectedBeforeWrite(
      [
        { id: "player_one", name: "玩家", description: "x", control: "player" },
        { id: "__proto__", name: "危险", description: "x", control: "npc" },
      ],
      /dangerous_key/,
    );
  });

  it("玩家数：零玩家与多玩家都失败（生成世界必须显式 player）", async () => {
    await expectRejectedBeforeWrite(
      [
        { id: "a_1", name: "甲", description: "主角视角。", control: "npc" },
        { id: "b_1", name: "乙", description: "x", control: "npc" },
      ],
      /player_count/,
    );
    await expectRejectedBeforeWrite(
      [
        { id: "a_1", name: "甲", description: "x", control: "player" },
        { id: "b_1", name: "乙", description: "x", control: "player" },
      ],
      /player_count/,
    );
  });

  it("非法 spriteBinding：素材集中不存在的绑定失败（author 素材可引用）", async () => {
    await expectRejectedBeforeWrite(
      [
        { id: "player_one", name: "玩家", description: "x", control: "player" },
        { id: "a_1", name: "甲", description: "x", control: "npc", spriteBinding: "nonexistent" },
      ],
      /unknown_sprite_binding/,
      { assets: ASSETS },
    );
    // 引用存在的 author 素材集是合法的（资源复用，不是身份合并）。
    const ok: WorldDraft = {
      ...DRAFT,
      characters: [
        { id: "player_one", name: "玩家", description: "x", control: "player" },
        { id: "a_1", name: "甲", description: "x", control: "npc", spriteBinding: "suyao" },
      ],
    };
    const { gameId } = await new WorldGenerator({
      writer: { writeOutline: vi.fn(async () => ok) },
      gamesRoot: root,
      newGameId: () => "game_sprite_ok",
      assets: ASSETS,
    }).generate({ userText: "x" });
    expect(existsSync(path.join(root, gameId, "world", "canon.json"))).toBe(true);
  });

  it("动态-author 冲突：与 author 角色表同 ID 直接失败（禁止 last-wins）", async () => {
    await expectRejectedBeforeWrite(
      [
        { id: "player_one", name: "玩家", description: "x", control: "player" },
        { id: "suyao", name: "苏遥？", description: "与静态角色同 ID 的动态角色。", control: "npc" },
      ],
      /dynamic_author_conflict/,
      { authorCharacterIds: ["suyao", "linche"] },
    );
  });

  it("玩家角色不允许音频画像（模型不代玩家发声）", async () => {
    await expectRejectedBeforeWrite(
      [
        {
          id: "player_one",
          name: "玩家",
          description: "x",
          control: "player",
          voice: { timbre: "年轻", delivery: ["restrained"] },
        },
      ],
      /player_voice_design/,
    );
  });
});

// ---------------------------------------------------------------------------
// M1：人物卡 = 派生产物（来源 revision 校验、缺卡由 canon 再生）
// ---------------------------------------------------------------------------

describe("WorldGenerator — 派生人物卡（M1）", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "world-gen-card-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedWorld(): Promise<string> {
    const { gameId } = await new WorldGenerator({
      writer: { writeOutline: vi.fn(async () => DRAFT) },
      gamesRoot: root,
      newGameId: () => "game_card",
      assets: ASSETS,
    }).generate({ userText: "x" });
    return gameId;
  }

  it("卡头携带 canon roster revision（加载时可校验来源）", async () => {
    const gameId = await seedWorld();
    const canon = await new CanonStore(root, gameId).load();
    const roster = rosterFromCanonCharacters({
      scopeId: `world:${gameId}`,
      characters: canon.characters,
      assets: ASSETS,
    });
    const card = await readFile(
      path.join(root, gameId, "world", "prompts", "characters.txt"),
      "utf8",
    );
    const header = card.split("\n")[0]!;
    expect(header.startsWith(DERIVED_CARD_SOURCE_PREFIX)).toBe(true);
    expect(header).toContain(roster.revision);
  });

  it("缺卡时由 canon 再生；身份不依赖卡的存在", async () => {
    const gameId = await seedWorld();
    const cardPath = path.join(root, gameId, "world", "prompts", "characters.txt");
    await rm(cardPath, { force: true });

    const canon = await new CanonStore(root, gameId).load();
    // registry 构建只读 canon——卡不存在不影响身份存在。
    const roster = rosterFromCanonCharacters({
      scopeId: `world:${gameId}`,
      characters: canon.characters,
      assets: ASSETS,
    });
    expect(roster.characters).toHaveLength(2);

    await ensureDerivedCharacterCard({ gamesRoot: root, gameId, canon, assets: ASSETS });
    const regenerated = await readFile(cardPath, "utf8");
    expect(regenerated).toContain("【苏遥】(su_yao)");
    expect(regenerated.split("\n")[0]).toContain(roster.revision);
  });

  it("来源 revision 过期时重写（canon 角色元信息是唯一真源）", async () => {
    const gameId = await seedWorld();
    const cardPath = path.join(root, gameId, "world", "prompts", "characters.txt");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      cardPath,
      `${DERIVED_CARD_SOURCE_PREFIX} v2-stale00000000stale0000\n\n【手改角色】(fake_id)\n过时内容。\n`,
      "utf8",
    );

    const canon = await new CanonStore(root, gameId).load();
    await ensureDerivedCharacterCard({ gamesRoot: root, gameId, canon, assets: ASSETS });
    const card = await readFile(cardPath, "utf8");
    expect(card).not.toContain("手改角色");
    expect(card).toContain("【林澈】(lin_che)");
  });

  it("卡内容可经 loadPrompts 装载（派生卡进入运行时 prompt）", async () => {
    const gameId = await seedWorld();
    const loaded = await loadPrompts("prompts", path.join(root, gameId, "world", "prompts"));
    expect(loaded.bundle.characters).toContain("【苏遥】(su_yao)");
    expect(loaded.bundle.characters).toContain("控制：玩家");
  });
});
