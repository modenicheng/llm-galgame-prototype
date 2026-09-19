/**
 * CharacterRegistry 构造与稳定 revision（C2 §3.1/§3.2）。
 *
 * 钉住的契约：ID 唯一（姓名可重复 → 仍两个身份）；恰好一个玩家控制角色
 * 且 playerId 指向它；无素材 NPC 合法；资源绑定（looks → spriteSet/variant）
 * 必须真实存在；revision 对键序稳定、对名字/控制类型/look/profile 绑定
 * 变化敏感，且不含时间戳或绝对路径。
 */
import { describe, expect, it } from "vitest";
import type { AssetCatalog } from "../assets/types.js";
import type { CharacterDefinition, CharacterRoster } from "./types.js";
import {
  CharacterRosterError,
  UnknownCharacterError,
  buildCharacterRoster,
  computeRosterRevision,
  createCharacterRegistry,
  validateCharacterRoster,
} from "./registry.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSETS: AssetCatalog = {
  guidance: "测试目录",
  backgrounds: {},
  bgm: {},
  soundEffects: {},
  spriteSets: {
    female_A: {
      id: "female_A",
      variants: {
        base: { id: "base", src: "characters/female_A/base.png" },
        smile: { id: "smile", src: "characters/female_A/smile.png" },
      },
    },
    female_B: {
      id: "female_B",
      variants: {
        base: { id: "base", src: "characters/female_B/base.png" },
      },
    },
  },
};

function playerDef(id = "player_one"): CharacterDefinition {
  return {
    id,
    name: "玩家",
    control: "player",
    initialLabel: "你",
    persona: "玩家本人，话语由运行时创建。",
  };
}

function xuwanqingDef(): CharacterDefinition {
  return {
    id: "female_A",
    name: "许晚晴",
    control: "npc",
    initialLabel: "许晚晴",
    persona: "温柔娴静的学姐。",
    presentation: {
      defaultLook: "base",
      defaultPosition: "right",
      looks: {
        base: { spriteSet: "female_A", variant: "base" },
        smile: { spriteSet: "female_A", variant: "smile" },
      },
    },
    voiceProfileId: "xuwanqing_main",
  };
}

function linXiaomanDef(): CharacterDefinition {
  return {
    id: "female_B",
    name: "林小满",
    control: "npc",
    initialLabel: "林小满",
    persona: "活泼的同级生。",
    presentation: {
      defaultLook: "base",
      defaultPosition: "left",
      looks: { base: { spriteSet: "female_B", variant: "base" } },
    },
  };
}

function rosterDraft(
  characters: readonly CharacterDefinition[],
  playerId = "player_one",
): Omit<CharacterRoster, "revision"> {
  return { schemaVersion: 2, scopeId: "campus-ops/2026-09", playerId, characters };
}

// ---------------------------------------------------------------------------
// ID 唯一性 / 同名身份
// ---------------------------------------------------------------------------
describe("createCharacterRegistry — 唯一性与同名", () => {
  it("同名角色仍是两个 ID：两条定义都注册且互不合并", () => {
    const twinA: CharacterDefinition = { ...linXiaomanDef(), name: "林小满" };
    const twinB: CharacterDefinition = {
      id: "female_C",
      name: "林小满",
      control: "npc",
      initialLabel: "林小满",
      persona: "同名但不同身份的另一位角色。",
    };
    const registry = createCharacterRegistry(
      buildCharacterRoster(rosterDraft([playerDef(), twinA, twinB])),
      ASSETS,
    );
    expect(registry.get("female_B")?.name).toBe("林小满");
    expect(registry.get("female_C")?.name).toBe("林小满");
    expect(registry.get("female_B")).not.toEqual(registry.get("female_C"));
  });

  it("重复 ID 被拒绝并给出结构化诊断", () => {
    const draft = rosterDraft([playerDef(), xuwanqingDef(), { ...xuwanqingDef(), name: "重名角色" }]);
    expect(() => createCharacterRegistry(buildCharacterRoster(draft), ASSETS)).toThrow(CharacterRosterError);
    try {
      createCharacterRegistry(buildCharacterRoster(draft), ASSETS);
    } catch (error) {
      expect(error).toBeInstanceOf(CharacterRosterError);
      const issues = (error as CharacterRosterError).issues;
      expect(issues.some((issue) => issue.code === "duplicate_character_id")).toBe(true);
    }
  });

  it("危险键 ID（prototype 等）被拒绝", () => {
    const draft = rosterDraft([
      playerDef(),
      { ...xuwanqingDef(), id: "prototype" },
    ]);
    expect(() => buildCharacterRoster(draft)).toThrow(/prototype/);
  });

  it("validateCharacterRoster 返回命名问题列表而不是抛字符串", () => {
    const roster = buildCharacterRoster(rosterDraft([playerDef(), xuwanqingDef()]));
    const issues = validateCharacterRoster(
      { ...roster, revision: "tampered" },
      ASSETS,
    );
    // revision 被手工篡改 → 结构化报告 revision_mismatch
    expect(issues.some((issue) => issue.code === "revision_mismatch")).toBe(true);
    for (const issue of issues) {
      expect(typeof issue.code).toBe("string");
      expect(typeof issue.path).toBe("string");
      expect(typeof issue.message).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// 玩家控制
// ---------------------------------------------------------------------------
describe("createCharacterRegistry — 玩家控制", () => {
  it("恰好一个玩家控制角色且 playerId 指向它", () => {
    const registry = createCharacterRegistry(
      buildCharacterRoster(rosterDraft([playerDef(), xuwanqingDef()])),
      ASSETS,
    );
    expect(registry.roster.playerId).toBe("player_one");
    expect(registry.require("player_one").control).toBe("player");
  });

  it("零个玩家角色被拒绝", () => {
    const draft = rosterDraft([xuwanqingDef(), linXiaomanDef()], "female_A");
    expect(() => buildCharacterRoster(draft)).toThrow(/player/);
  });

  it("多个玩家角色被拒绝", () => {
    const draft = rosterDraft([
      playerDef("player_one"),
      { ...xuwanqingDef(), control: "player" },
    ]);
    expect(() => buildCharacterRoster(draft)).toThrow(/player/);
  });

  it("playerId 指向 NPC 被拒绝", () => {
    const draft = rosterDraft([playerDef("player_one"), xuwanqingDef()], "female_A");
    expect(() => buildCharacterRoster(draft)).toThrow(/playerId/);
  });

  it("playerId 指向不存在的 ID 被拒绝", () => {
    const draft = rosterDraft([playerDef("player_one")], "ghost");
    expect(() => buildCharacterRoster(draft)).toThrow(/playerId/);
  });
});

// ---------------------------------------------------------------------------
// 无素材 NPC / 资源绑定
// ---------------------------------------------------------------------------
describe("createCharacterRegistry — 资源绑定", () => {
  it("无立绘、无音色的 NPC 合法：可说话、可进记忆", () => {
    const artless: CharacterDefinition = {
      id: "npc_caller",
      name: "未知来电者",
      control: "npc",
      initialLabel: "神秘女子",
      persona: "只在电话里出现。",
    };
    const registry = createCharacterRegistry(
      buildCharacterRoster(rosterDraft([playerDef(), artless])),
      ASSETS,
    );
    expect(registry.require("npc_caller").initialLabel).toBe("神秘女子");
  });

  it("look 引用不存在的 spriteSet 被拒绝", () => {
    const bad = {
      ...xuwanqingDef(),
      presentation: {
        defaultLook: "base",
        defaultPosition: "right" as const,
        looks: { base: { spriteSet: "female_Z", variant: "base" } },
      },
    };
    expect(() => createCharacterRegistry(buildCharacterRoster(rosterDraft([playerDef(), bad])), ASSETS)).toThrow(
      /female_Z/,
    );
  });

  it("look 引用不存在的 variant 被拒绝", () => {
    const bad = {
      ...xuwanqingDef(),
      presentation: {
        defaultLook: "base",
        defaultPosition: "right" as const,
        looks: { base: { spriteSet: "female_A", variant: "nonexistent" } },
      },
    };
    expect(() => createCharacterRegistry(buildCharacterRoster(rosterDraft([playerDef(), bad])), ASSETS)).toThrow(
      /nonexistent/,
    );
  });

  it("spriteSet 存在性检查不走原型链（toString 不是素材集）", () => {
    const bad = {
      ...xuwanqingDef(),
      presentation: {
        defaultLook: "base",
        defaultPosition: "right" as const,
        looks: { base: { spriteSet: "toString", variant: "base" } },
      },
    };
    expect(() => createCharacterRegistry(buildCharacterRoster(rosterDraft([playerDef(), bad])), ASSETS)).toThrow(
      CharacterRosterError,
    );
  });

  it("角色可共享素材：两个 ID 绑定同一 spriteSet 不合并身份", () => {
    const sharer: CharacterDefinition = {
      ...linXiaomanDef(),
      presentation: {
        defaultLook: "base",
        defaultPosition: "left",
        looks: { base: { spriteSet: "female_A", variant: "base" } },
      },
    };
    const registry = createCharacterRegistry(
      buildCharacterRoster(rosterDraft([playerDef(), xuwanqingDef(), sharer])),
      ASSETS,
    );
    expect(registry.require("female_B").presentation?.looks.base?.spriteSet).toBe("female_A");
    expect(registry.require("female_A").id).not.toBe(registry.require("female_B").id);
  });
});

// ---------------------------------------------------------------------------
// get / require
// ---------------------------------------------------------------------------
describe("CharacterRegistry 查询", () => {
  const registry = createCharacterRegistry(
    buildCharacterRoster(rosterDraft([playerDef(), xuwanqingDef()])),
    ASSETS,
  );

  it("get 未注册 ID 返回 undefined", () => {
    expect(registry.get("ghost")).toBeUndefined();
    expect(registry.get("许晚晴")).toBeUndefined(); // 显示名不是机器键
  });

  it("require 未注册 ID 抛出命名错误（不许静默新建身份）", () => {
    expect(() => registry.require("ghost")).toThrow(UnknownCharacterError);
    try {
      registry.require("ghost");
    } catch (error) {
      expect((error as UnknownCharacterError).characterId).toBe("ghost");
      expect((error as UnknownCharacterError).scopeId).toBe("campus-ops/2026-09");
    }
  });

  it("注册表持有一致的 roster 快照", () => {
    expect(registry.roster.characters).toHaveLength(2);
    expect(registry.roster.schemaVersion).toBe(2);
    expect(typeof registry.roster.revision).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 稳定 revision
// ---------------------------------------------------------------------------
describe("computeRosterRevision — 稳定摘要", () => {
  it("对键排序稳定：looks 键序、角色顺序不同 → 同一 revision", () => {
    const a = computeRosterRevision(
      rosterDraft([playerDef(), xuwanqingDef(), linXiaomanDef()]),
    );
    const b = computeRosterRevision(
      rosterDraft([
        linXiaomanDef(),
        {
          ...xuwanqingDef(),
          presentation: {
            defaultLook: "base",
            defaultPosition: "right",
            looks: {
              smile: { spriteSet: "female_A", variant: "smile" },
              base: { spriteSet: "female_A", variant: "base" },
            },
          },
        },
        playerDef(),
      ]),
    );
    expect(a).toBe(b);
  });

  it("对姓名变化敏感", () => {
    const base = computeRosterRevision(rosterDraft([playerDef(), xuwanqingDef()]));
    const renamed = computeRosterRevision(
      rosterDraft([playerDef(), { ...xuwanqingDef(), name: "许晚晴（转学生）" }]),
    );
    expect(base).not.toBe(renamed);
  });

  it("对控制类型变化敏感（player ↔ npc）", () => {
    const base = computeRosterRevision(rosterDraft([playerDef("female_A"), xuwanqingDef()], "female_A"));
    const swapped = computeRosterRevision(
      rosterDraft(
        [
          { ...playerDef("female_A"), control: "npc" },
          { ...xuwanqingDef(), control: "player" },
        ],
        "female_A",
      ),
    );
    expect(base).not.toBe(swapped);
  });

  it("对 look 绑定变化敏感（换装映射 = 另一个 look）", () => {
    const base = computeRosterRevision(rosterDraft([playerDef(), xuwanqingDef()]));
    const changed = computeRosterRevision(
      rosterDraft([
        playerDef(),
        {
          ...xuwanqingDef(),
          presentation: {
            defaultLook: "base",
            defaultPosition: "right",
            looks: {
              base: { spriteSet: "female_A", variant: "base" },
              smile: { spriteSet: "female_A", variant: "joyful" },
            },
          },
        },
      ]),
    );
    expect(base).not.toBe(changed);
  });

  it("对 profile 绑定（voiceProfileId）与人设（persona）变化敏感", () => {
    const base = computeRosterRevision(rosterDraft([playerDef(), xuwanqingDef()]));
    const voiceChanged = computeRosterRevision(
      rosterDraft([playerDef(), { ...xuwanqingDef(), voiceProfileId: "xuwanqing_alt" }]),
    );
    const personaChanged = computeRosterRevision(
      rosterDraft([playerDef(), { ...xuwanqingDef(), persona: "冷淡的转学生。" }]),
    );
    expect(base).not.toBe(voiceChanged);
    expect(base).not.toBe(personaChanged);
  });

  it("对名牌（initialLabel）与 scopeId 变化敏感", () => {
    const base = computeRosterRevision(rosterDraft([playerDef(), xuwanqingDef()]));
    expect(base).not.toBe(
      computeRosterRevision(rosterDraft([playerDef(), { ...xuwanqingDef(), initialLabel: "神秘女子" }])),
    );
    expect(base).not.toBe(
      computeRosterRevision({ ...rosterDraft([playerDef(), xuwanqingDef()]), scopeId: "main-fallback/2026-09" }),
    );
  });

  it("确定性：重复计算结果一致，格式稳定（无时间戳/路径成分）", () => {
    const first = computeRosterRevision(rosterDraft([playerDef(), xuwanqingDef()]));
    const second = computeRosterRevision(rosterDraft([playerDef(), xuwanqingDef()]));
    expect(first).toBe(second);
    expect(first).toMatch(/^v2-[0-9a-f]{16}$/);
    expect(first).not.toMatch(/[\\/]/);
  });

  it("revision 被篡改的 roster 在注册时被拒绝（摘要完整性）", () => {
    const draft = rosterDraft([playerDef(), xuwanqingDef()]);
    const roster: CharacterRoster = { ...draft, revision: "deadbeef" };
    expect(() => createCharacterRegistry(roster, ASSETS)).toThrow(/revision/);
  });
});
