/**
 * WorldGenerator tests（执行清单 M3.3 验收）：fake writer 下落盘文件齐全、
 * outline revision=1、prompts 覆盖生效；空描述大声报错。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorldGenerator, renderCharacters, renderStoryLine } from "./world-generator.js";
import { OutlineStore } from "../../adapters/storage/outline-store.js";
import { loadPrompts } from "../../prompts.js";
import type { OutlineWriterPort, WorldDraft } from "../outline/outline-writer.js";

const DRAFT: WorldDraft = {
  worldSetting: "平行世界的学园都市，超能力与日常交织。",
  characters: [
    { id: "su_yao", name: "苏遥", description: "转学生，随身带着旧终端。", spriteBinding: "suyao" },
    { id: "lin_che", name: "林澈", description: "主人公，好奇心旺盛。" },
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

    // world/canon.json 脚手架（M3.6 对齐形状）
    const canon = JSON.parse(
      await readFile(path.join(root, gameId, "world", "canon.json"), "utf8"),
    );
    expect(canon.worldSetting).toContain("学园都市");
    expect(canon.characters).toHaveLength(2);
    expect(canon.promotedFacts).toEqual([]);
    expect(canon.exceptions).toEqual([]);

    // per-game prompts
    const characters = await readFile(
      path.join(root, gameId, "world", "prompts", "characters.txt"),
      "utf8",
    );
    expect(characters).toContain("【苏遥】(su_yao)");
    expect(characters).toContain("立绘绑定：suyao");
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
  it("renderCharacters lists each character with id header", () => {
    const text = renderCharacters(DRAFT);
    expect(text).toContain("【苏遥】(su_yao)");
    expect(text).toContain("【林澈】(lin_che)");
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
          voice: {
            timbre: "年轻女性，清亮偏冷",
            delivery: ["restrained", "firm"],
            avoid: ["playful"],
            baseline: { pace: "slow" },
          },
        },
        { id: "lin_che", name: "林澈", description: "主人公。" },
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
    expect(stored).toEqual({
      version: 1,
      characters: {
        su_yao: {
          name: "苏遥",
          voice: {
            timbre: "年轻女性，清亮偏冷",
            delivery: ["restrained", "firm"],
            avoid: ["playful"],
            baseline: { pace: "slow" },
          },
        },
      },
    });

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
