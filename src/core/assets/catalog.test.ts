/**
 * Tests for the pure asset catalog projections (docs §58–§60).
 */

import { describe, expect, it } from "vitest";
import type { AssetCatalog, ModelAssetCatalog } from "./types.js";
import { createAssetResolver, toCharacterRegistry, toModelCatalog } from "./catalog.js";

// ---------------------------------------------------------------------------
// Fixture (mirrors the real assets/resources.yaml shape)
// ---------------------------------------------------------------------------

const catalog: AssetCatalog = {
  guidance: "测试指引：背景应尽量复用。",
  backgrounds: {
    hideout_on: { id: "hideout_on", src: "backgrounds/hideout_on.jpg", description: "地下据点照明开启。" },
    hallway_day: { id: "hallway_day", src: "backgrounds/hallway_day.jpg", description: "校园走廊白天。" },
  },
  bgm: {
    relax: { id: "relax", src: "audio/bgm/relax.mp3", description: "来源：andriig-relax。" },
  },
  soundEffects: {
    terminal_beep: { id: "terminal_beep", src: "audio/se/terminal_beep.ogg", description: "旧终端提示音。" },
  },
  spriteSets: {
    suyao: {
      id: "suyao",
      description: "苏遥正式立绘。",
      variants: {
        neutral: { id: "neutral", src: "characters/suyao/neutral.png", description: "双眼睁开，接近平静常态。" },
        speaking_smile: { id: "speaking_smile", src: "characters/suyao/speaking_smile.png" },
      },
    },
    mysterious_woman: {
      id: "mysterious_woman",
      variants: {
        gentle_smile: { id: "gentle_smile", src: "characters/mysterious_woman/gentle_smile.png" },
      },
    },
  },
  characters: {
    suyao: {
      characterId: "suyao",
      scriptName: "苏遥",
      displayName: "苏遥",
      spriteSet: "suyao",
      defaultVariant: "neutral",
      defaultPosition: "left",
    },
    mysterious_woman: {
      characterId: "mysterious_woman",
      scriptName: "神秘女子",
      displayName: "神秘女子",
      spriteSet: "mysterious_woman",
      defaultVariant: "gentle_smile",
      defaultPosition: "right",
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
    expect(serialized).not.toContain(".png");
    expect(serialized).not.toContain(".jpg");
    expect(serialized).not.toContain(".ogg");
    expect(serialized).not.toContain(".mp3");
    expect(serialized).not.toContain("characters/");
    expect(serialized).not.toContain("audio/");
    expect(serialized).not.toContain("backgrounds/");
  });

  it("keeps guidance and descriptions", () => {
    const model = toModelCatalog(catalog);
    expect(model.guidance).toBe("测试指引：背景应尽量复用。");
    expect(model.backgrounds.hideout_on).toEqual({ description: "地下据点照明开启。" });
    expect(model.bgm.relax).toEqual({ description: "来源：andriig-relax。" });
    expect(model.soundEffects.terminal_beep).toEqual({ description: "旧终端提示音。" });
  });

  it("keeps sprite variant ids and descriptions", () => {
    const model = toModelCatalog(catalog);
    expect(model.spriteSets.suyao).toEqual({
      description: "苏遥正式立绘。",
      variants: {
        neutral: { description: "双眼睁开，接近平静常态。" },
        speaking_smile: {},
      },
    });
    expect(model.spriteSets.mysterious_woman).toEqual({
      variants: { gentle_smile: {} },
    });
  });

  it("keeps character bindings", () => {
    const model = toModelCatalog(catalog);
    expect(model.characters.suyao).toEqual({
      scriptName: "苏遥",
      displayName: "苏遥",
      spriteSet: "suyao",
      defaultVariant: "neutral",
      defaultPosition: "left",
    });
    expect(model.characters.mysterious_woman).toEqual({
      scriptName: "神秘女子",
      displayName: "神秘女子",
      spriteSet: "mysterious_woman",
      defaultVariant: "gentle_smile",
      defaultPosition: "right",
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
      defaultVariant: "neutral",
      defaultPosition: "left",
    });
  });

  it("resolves by internal id", () => {
    expect(registry.resolveById("suyao")?.characterId).toBe("suyao");
    expect(registry.resolveById("mysterious_woman")?.characterId).toBe("mysterious_woman");
  });

  it("resolves by script name via resolveById as a fallback", () => {
    expect(registry.resolveById("苏遥")?.characterId).toBe("suyao");
    expect(registry.resolveById("神秘女子")?.characterId).toBe("mysterious_woman");
  });

  it("returns undefined for unknown ids and script names", () => {
    expect(registry.resolveById("ghost")).toBeUndefined();
    expect(registry.resolveByScriptName("幽灵")).toBeUndefined();
  });

  it("lists all entries", () => {
    const entries = registry.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.characterId).toBe("suyao");
    expect(entries[0]?.scriptName).toBe("苏遥");
    expect(entries[1]?.characterId).toBe("mysterious_woman");
    expect(entries[1]?.scriptName).toBe("神秘女子");
  });
});

// ---------------------------------------------------------------------------
// createAssetResolver
// ---------------------------------------------------------------------------

describe("createAssetResolver", () => {
  const resolver = createAssetResolver(catalog);

  it("resolves a background to its src", () => {
    expect(resolver.resolveBackground("hideout_on")).toEqual({ src: "backgrounds/hideout_on.jpg" });
    expect(resolver.resolveBackground("hallway_day")).toEqual({ src: "backgrounds/hallway_day.jpg" });
  });

  it("resolves bgm and sound effects to their src", () => {
    expect(resolver.resolveBgm("relax")).toEqual({ src: "audio/bgm/relax.mp3" });
    expect(resolver.resolveSoundEffect("terminal_beep")).toEqual({ src: "audio/se/terminal_beep.ogg" });
  });

  it("resolves a sprite by set + variant", () => {
    expect(resolver.resolveSprite("suyao", "neutral")).toEqual({ src: "characters/suyao/neutral.png" });
    expect(resolver.resolveSprite("suyao", "speaking_smile")).toEqual({ src: "characters/suyao/speaking_smile.png" });
    expect(resolver.resolveSprite("mysterious_woman", "gentle_smile")).toEqual({
      src: "characters/mysterious_woman/gentle_smile.png",
    });
  });

  it("returns undefined for missing assets", () => {
    expect(resolver.resolveBackground("rooftop")).toBeUndefined();
    expect(resolver.resolveBgm("rock")).toBeUndefined();
    expect(resolver.resolveSoundEffect("explosion")).toBeUndefined();
    expect(resolver.resolveSprite("suyao", "happy")).toBeUndefined();
    expect(resolver.resolveSprite("nobody", "neutral")).toBeUndefined();
  });
});
