/**
 * world-roster（M1）测试——world draft / canon 角色与 C2 roster 的互转、
 * 玩家契约校验与创建前失败纪律。
 *
 * 覆盖：R06（创建任何正式世界文件前，重复 ID/非法 ID/多玩家/非法
 * spriteBinding/动态-author 冲突必须结构化失败）；R07（生成世界必须显式
 * 玩家，playerId 不由「主角」文案猜测）；fallback 与生成世界 roster 不互掺。
 */

import { describe, it, expect } from "vitest";
import {
  validateWorldCharacters,
  canonCharactersFromDraft,
  rosterFromCanonCharacters,
  isRosterCapableCanon,
  rosterCharacterIds,
  WorldCharacterSetError,
} from "./world-roster.js";
import type { WorldDraft } from "../outline/outline-writer.js";
import type { CanonSnapshot } from "../../core/ports/canon-store-port.js";
import type { AssetCatalog } from "../../core/assets/types.js";

function makeAssets(spriteSets: string[] = ["suyao"]): AssetCatalog {
  return {
    guidance: "",
    backgrounds: {},
    bgm: {},
    soundEffects: {},
    spriteSets: Object.fromEntries(
      spriteSets.map((id) => [id, { id, variants: { neutral: { id: "neutral", src: "x.png" } } }]),
    ),
  };
}

function baseDraft(): WorldDraft {
  return {
    worldSetting: "临时世界。",
    characters: [
      { id: "player_one", name: "玩家", description: "玩家控制角色。", control: "player" },
      { id: "guest_01", name: "访客", description: "无立绘无声音的动态 NPC。", control: "npc" },
    ],
    outline: [
      { id: "ol_act_1", purpose: "相遇", kind: "act", status: "planned" },
      { id: "ol_end_1", purpose: "道别", kind: "ending", status: "planned" },
    ],
  };
}

function canonSnapshot(
  characters: CanonSnapshot["characters"],
): CanonSnapshot {
  return {
    revision: 0,
    worldSetting: "临时世界。",
    characters,
    promotedFacts: [],
    exceptions: [],
  };
}

describe("validateWorldCharacters — 创建前失败（结构化 issues）", () => {
  it("接受显式玩家 + NPC 的合法集合", () => {
    const issues = validateWorldCharacters({
      characters: baseDraft().characters,
      source: "draft",
      assets: makeAssets(),
    });
    expect(issues).toEqual([]);
  });

  it("拒绝重复 ID（duplicate_character_id）", () => {
    const draft = baseDraft();
    draft.characters = [
      ...draft.characters,
      { id: "guest_01", name: "访客二", description: "重复 ID。", control: "npc" },
    ];
    const issues = validateWorldCharacters({
      characters: draft.characters,
      source: "draft",
    });
    expect(issues.some((issue) => issue.code === "duplicate_character_id")).toBe(true);
  });

  it("拒绝非法 ID 与危险键（invalid_character_id / dangerous_key）", () => {
    const issues = validateWorldCharacters({
      characters: [
        { id: "神秘 嘉宾", name: "空格 ID", description: "非法。", control: "npc" },
        { id: "__proto__", name: "危险键", description: "非法。", control: "npc" },
      ],
      source: "draft",
    });
    expect(issues.some((issue) => issue.code === "invalid_character_id")).toBe(true);
    expect(issues.some((issue) => issue.code === "dangerous_key")).toBe(true);
  });

  it("拒绝零玩家与多玩家（player_count）——不凭「主角」文案猜测", () => {
    const noPlayer = validateWorldCharacters({
      characters: [
        { id: "a_1", name: "甲", description: "主角视角。", control: "npc" },
      ],
      source: "draft",
    });
    expect(noPlayer.some((issue) => issue.code === "player_count")).toBe(true);

    const twoPlayers = validateWorldCharacters({
      characters: [
        { id: "a_1", name: "甲", description: "主角视角。", control: "player" },
        { id: "b_1", name: "乙", description: "也是主角。", control: "player" },
      ],
      source: "draft",
    });
    expect(twoPlayers.some((issue) => issue.code === "player_count")).toBe(true);
  });

  it("拒绝非法 spriteBinding（unknown_sprite_binding）——引用存在素材集才合法", () => {
    const issues = validateWorldCharacters({
      characters: [
        { id: "player_one", name: "玩家", description: "x", control: "player" },
        { id: "a_1", name: "甲", description: "x", control: "npc", spriteBinding: "nonexistent_set" },
      ],
      source: "draft",
      assets: makeAssets(["suyao"]),
    });
    expect(issues.some((issue) => issue.code === "unknown_sprite_binding")).toBe(true);
  });

  it("拒绝动态 ID 与 author 角色表冲突（dynamic_author_conflict，禁止 last-wins）", () => {
    const issues = validateWorldCharacters({
      characters: baseDraft().characters,
      source: "draft",
      authorCharacterIds: ["guest_01", "suyao"],
    });
    expect(issues.some((issue) => issue.code === "dynamic_author_conflict")).toBe(true);
  });

  it("拒绝玩家角色的音频画像（player_voice_design——模型不代玩家发声）", () => {
    const issues = validateWorldCharacters({
      characters: [
        {
          id: "player_one",
          name: "玩家",
          description: "x",
          control: "player",
          voice: { timbre: "年轻", delivery: ["restrained"] },
        },
      ],
      source: "draft",
    });
    expect(issues.some((issue) => issue.code === "player_voice_design")).toBe(true);
  });

  it("canon 侧缺 control 元信息时结构化报缺（missing_control，旧世界可诊断）", () => {
    const issues = validateWorldCharacters({
      characters: [
        { id: "a_1", name: "甲", description: "旧世界角色。" },
      ],
      source: "canon",
    });
    expect(issues.some((issue) => issue.code === "missing_control")).toBe(true);
  });
});

describe("canonCharactersFromDraft — 权威元信息落 canon", () => {
  it("control 与 initialLabel 写入 canon 形状（initialLabel 缺省回落 name）", () => {
    const canonChars = canonCharactersFromDraft(baseDraft());
    expect(canonChars).toHaveLength(2);
    const player = canonChars.find((c) => c.id === "player_one");
    expect(player).toMatchObject({ control: "player", initialLabel: "玩家" });
    const guest = canonChars.find((c) => c.id === "guest_01");
    expect(guest).toMatchObject({ control: "npc", initialLabel: "访客" });
  });

  it("非法 draft 抛 WorldCharacterSetError（不产出半成品 canon）", () => {
    const draft = baseDraft();
    draft.characters = [
      { id: "player_one", name: "玩家", description: "x", control: "player" },
      { id: "player_two", name: "乙", description: "x", control: "player" },
    ];
    expect(() => canonCharactersFromDraft(draft)).toThrow(WorldCharacterSetError);
  });
});

describe("rosterFromCanonCharacters — 生成世界的 registry 真源", () => {
  it("canon 角色 → C2 roster：control/initialLabel/persona 保留，playerId 显式", () => {
    const roster = rosterFromCanonCharacters({
      scopeId: "world:game_x",
      characters: [
        { id: "player_one", name: "玩家", description: "玩家人设。", control: "player", initialLabel: "玩家" },
        { id: "guest_01", name: "访客", description: "神秘访客。", control: "npc", initialLabel: "神秘女子" },
      ],
      assets: makeAssets(),
    });
    expect(roster.schemaVersion).toBe(2);
    expect(roster.scopeId).toBe("world:game_x");
    expect(roster.playerId).toBe("player_one");
    const guest = roster.characters.find((c) => c.id === "guest_01");
    expect(guest).toMatchObject({
      control: "npc",
      initialLabel: "神秘女子",
      persona: "神秘访客。",
    });
    expect(roster.revision).toMatch(/^v2-/);
  });

  it("canon 缺 initialLabel 时回落 name（确定性行为，不猜姓名）", () => {
    const roster = rosterFromCanonCharacters({
      scopeId: "world:game_x",
      characters: [
        { id: "player_one", name: "玩家", description: "x", control: "player" },
      ],
      assets: makeAssets(),
    });
    expect(roster.characters[0]!.initialLabel).toBe("玩家");
  });

  it("canon 缺 control 时抛结构化错误（旧世界显式诊断，不猜测）", () => {
    expect(() =>
      rosterFromCanonCharacters({
        scopeId: "world:game_x",
        characters: [{ id: "a_1", name: "甲", description: "x" }],
        assets: makeAssets(),
      }),
    ).toThrow(/missing_control/);
  });

  it("roster 对键序/列表序稳定（同内容同 revision）", () => {
    const a = rosterFromCanonCharacters({
      scopeId: "world:game_x",
      characters: [
        { id: "player_one", name: "玩家", description: "x", control: "player" },
        { id: "guest_01", name: "访客", description: "y", control: "npc" },
      ],
      assets: makeAssets(),
    });
    const b = rosterFromCanonCharacters({
      scopeId: "world:game_x",
      characters: [
        { id: "guest_01", name: "访客", description: "y", control: "npc" },
        { id: "player_one", name: "玩家", description: "x", control: "player" },
      ],
      assets: makeAssets(),
    });
    expect(b.revision).toBe(a.revision);
  });
});

describe("isRosterCapableCanon / rosterCharacterIds", () => {
  it("只有携带 control 元信息的 canon 才是 v2 世界（旧 canon = legacy）", () => {
    expect(isRosterCapableCanon(canonSnapshot([]))).toBe(false);
    expect(
      isRosterCapableCanon(canonSnapshot([{ id: "a_1", name: "甲", description: "x" }])),
    ).toBe(false);
    expect(
      isRosterCapableCanon(
        canonSnapshot([{ id: "a_1", name: "甲", description: "x", control: "npc" }]),
      ),
    ).toBe(true);
  });

  it("rosterCharacterIds 给出已知角色集（reconcile 过滤/导演 cast 数据源）", () => {
    const roster = rosterFromCanonCharacters({
      scopeId: "world:game_x",
      characters: [
        { id: "player_one", name: "玩家", description: "x", control: "player" },
        { id: "guest_01", name: "访客", description: "y", control: "npc" },
      ],
      assets: makeAssets(),
    });
    expect(rosterCharacterIds(roster).has("guest_01")).toBe(true);
    expect(rosterCharacterIds(roster).has("suyao")).toBe(false);
  });

  it("fallback 与生成世界 roster 不互相掺入（独立身份命名空间）", () => {
    const generated = rosterFromCanonCharacters({
      scopeId: "world:game_x",
      characters: [
        { id: "player_one", name: "玩家", description: "x", control: "player" },
        { id: "guest_01", name: "访客", description: "y", control: "npc" },
      ],
      assets: makeAssets(),
    });
    const ids = rosterCharacterIds(generated);
    // main 静态 fallback cast 不得混入生成世界（player/linche/suyao 三条）。
    expect(ids.has("player")).toBe(false);
    expect(ids.has("linche")).toBe(false);
    expect(ids.has("suyao")).toBe(false);
    expect(generated.scopeId).not.toContain("fallback");
  });
});
