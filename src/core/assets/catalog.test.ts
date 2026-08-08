/**
 * Tests for the pure asset catalog projections (docs §58–§60).
 */

import { describe, expect, it } from "vitest";
import type { AssetCatalog, ModelAssetCatalog } from "./types.js";
import { createAssetResolver, toCharacterRegistry, toModelCatalog } from "./catalog.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const catalog: AssetCatalog = {
  guidance: "测试指引：背景应尽量复用。",
  backgrounds: {
    basement: { id: "basement", src: "backgrounds/basement.webp", description: "昏暗地下设备间。" },
    classroom_day: { id: "classroom_day", src: "backgrounds/classroom_day.webp", description: "白天普通教室。" },
  },
  bgm: {
    mystery: { id: "mystery", src: "audio/bgm/mystery.ogg", description: "轻度悬疑。" },
  },
  soundEffects: {
    terminal_beep: { id: "terminal_beep", src: "audio/se/terminal_beep.ogg", description: "旧终端提示音。" },
  },
  spriteSets: {
    suyao: {
      id: "suyao",
      description: "苏遥正式立绘。",
      variants: {
        normal: { id: "normal", src: "characters/suyao/normal.webp", description: "默认冷静状态。" },
        anxious: { id: "anxious", src: "characters/suyao/anxious.webp" },
      },
    },
    placeholder_char: {
      id: "placeholder_char",
      variants: {
        normal: { id: "normal", src: "characters/placeholder/normal.webp" },
      },
    },
  },
  characters: {
    suyao: {
      characterId: "suyao",
      scriptName: "苏遥",
      displayName: "苏遥",
      spriteSet: "suyao",
      defaultVariant: "normal",
      defaultPosition: "left",
    },
  },
};

// ---------------------------------------------------------------------------
// toModelCatalog
// ---------------------------------------------------------------------------

describe("toModelCatalog", () => {
  it("strips file paths from every section", () => {
    const model = toModelCatalog(catalog);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain(".webp");
    expect(serialized).not.toContain(".ogg");
    expect(serialized).not.toContain("characters/");
    expect(serialized).not.toContain("audio/");
    expect(serialized).not.toContain("backgrounds/");
  });

  it("keeps guidance and descriptions", () => {
    const model = toModelCatalog(catalog);
    expect(model.guidance).toBe("测试指引：背景应尽量复用。");
    expect(model.backgrounds.basement).toEqual({ description: "昏暗地下设备间。" });
    expect(model.bgm.mystery).toEqual({ description: "轻度悬疑。" });
    expect(model.soundEffects.terminal_beep).toEqual({ description: "旧终端提示音。" });
  });

  it("keeps sprite variant ids and descriptions", () => {
    const model = toModelCatalog(catalog);
    expect(model.spriteSets.suyao).toEqual({
      description: "苏遥正式立绘。",
      variants: {
        normal: { description: "默认冷静状态。" },
        anxious: {},
      },
    });
    expect(model.spriteSets.placeholder_char).toEqual({
      variants: { normal: {} },
    });
  });

  it("keeps character bindings", () => {
    const model = toModelCatalog(catalog);
    expect(model.characters.suyao).toEqual({
      scriptName: "苏遥",
      displayName: "苏遥",
      spriteSet: "suyao",
      defaultVariant: "normal",
      defaultPosition: "left",
    });
  });
});

// ---------------------------------------------------------------------------
// toCharacterRegistry
// ---------------------------------------------------------------------------

describe("toCharacterRegistry", () => {
  const registry = toCharacterRegistry(catalog);

  it("resolves a dialogue-header script name", () => {
    expect(registry.resolveByScriptName("苏遥")).toEqual({
      characterId: "suyao",
      scriptName: "苏遥",
      displayName: "苏遥",
      spriteSet: "suyao",
      defaultVariant: "normal",
      defaultPosition: "left",
    });
  });

  it("resolves by internal id", () => {
    expect(registry.resolveById("suyao")?.characterId).toBe("suyao");
  });

  it("resolves by script name via resolveById as a fallback", () => {
    expect(registry.resolveById("苏遥")?.characterId).toBe("suyao");
  });

  it("returns undefined for unknown ids and script names", () => {
    expect(registry.resolveById("ghost")).toBeUndefined();
    expect(registry.resolveByScriptName("幽灵")).toBeUndefined();
  });

  it("lists all entries", () => {
    const entries = registry.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.characterId).toBe("suyao");
    expect(entries[0]?.scriptName).toBe("苏遥");
  });
});

// ---------------------------------------------------------------------------
// createAssetResolver
// ---------------------------------------------------------------------------

describe("createAssetResolver", () => {
  const resolver = createAssetResolver(catalog);

  it("resolves a background to its src", () => {
    expect(resolver.resolveBackground("basement")).toEqual({ src: "backgrounds/basement.webp" });
  });

  it("resolves bgm and sound effects to their src", () => {
    expect(resolver.resolveBgm("mystery")).toEqual({ src: "audio/bgm/mystery.ogg" });
    expect(resolver.resolveSoundEffect("terminal_beep")).toEqual({ src: "audio/se/terminal_beep.ogg" });
  });

  it("resolves a sprite by set + variant", () => {
    expect(resolver.resolveSprite("suyao", "normal")).toEqual({ src: "characters/suyao/normal.webp" });
    expect(resolver.resolveSprite("suyao", "anxious")).toEqual({ src: "characters/suyao/anxious.webp" });
  });

  it("returns undefined for missing assets", () => {
    expect(resolver.resolveBackground("rooftop")).toBeUndefined();
    expect(resolver.resolveBgm("rock")).toBeUndefined();
    expect(resolver.resolveSoundEffect("explosion")).toBeUndefined();
    expect(resolver.resolveSprite("suyao", "happy")).toBeUndefined();
    expect(resolver.resolveSprite("nobody", "normal")).toBeUndefined();
  });
});
