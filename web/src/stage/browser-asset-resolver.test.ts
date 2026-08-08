import { describe, expect, it } from "vitest";
import { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { PublicAssetManifest } from "./stage-types.js";

const manifest: PublicAssetManifest = {
  backgrounds: { basement: { url: "/game-assets/backgrounds/basement.jpg" } },
  bgm: { mystery: { url: "/game-assets/audio/bgm/mystery.mp3" } },
  soundEffects: { beep: { url: "/game-assets/audio/se/beep.ogg" } },
  spriteSets: { suyao: { variants: { anxious: { url: "/game-assets/characters/suyao/anxious.png" } } } },
};

describe("BrowserAssetResolver", () => {
  it("按逻辑 id 解析受控 URL", () => {
    const r = new BrowserAssetResolver(manifest);
    expect(r.resolveBackground("basement")).toBe("/game-assets/backgrounds/basement.jpg");
    expect(r.resolveBgm("mystery")).toBe("/game-assets/audio/bgm/mystery.mp3");
    expect(r.resolveSoundEffect("beep")).toBe("/game-assets/audio/se/beep.ogg");
    expect(r.resolveSprite("suyao", "anxious")).toBe("/game-assets/characters/suyao/anxious.png");
  });

  it("未知 id 返回 undefined", () => {
    const r = new BrowserAssetResolver(manifest);
    expect(r.resolveBackground("nope")).toBeUndefined();
    expect(r.resolveSprite("suyao", "nope")).toBeUndefined();
  });

  it("无 manifest 时全部 undefined", () => {
    const r = new BrowserAssetResolver(null);
    expect(r.resolveBackground("basement")).toBeUndefined();
  });
});
