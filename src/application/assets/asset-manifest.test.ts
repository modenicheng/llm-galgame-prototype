import { describe, expect, it } from "vitest";
import { buildPublicAssetManifest } from "./asset-manifest.js";
import { makeAssetCatalog } from "./asset-manifest.fixtures.js";

describe("buildPublicAssetManifest", () => {
  const catalog = makeAssetCatalog();

  it("把 src 投影为带前缀的受控 URL，且不泄露绝对路径", () => {
    const manifest = buildPublicAssetManifest(catalog, "/game-assets/");
    expect(manifest.backgrounds.basement!.url).toBe("/game-assets/backgrounds/basement.jpg");
    expect(manifest.spriteSets.suyao!.variants.anxious!.url).toBe(
      "/game-assets/characters/suyao/anxious.png",
    );
    expect(manifest.bgm.mystery!.url).toBe("/game-assets/audio/bgm/mystery.mp3");
    expect(manifest.soundEffects.beep!.url).toBe("/game-assets/audio/beep.wav");
    // 序列化结果不含绝对路径（不以 / 开头）或路径回溯（../）。
    expect(JSON.stringify(manifest)).not.toMatch(/^\/|\.\.\//);
  });

  it("把反斜杠 src 归一为正斜杠（跨平台素材路径）", () => {
    const catalogWithBackslashes = makeAssetCatalog();
    catalogWithBackslashes.backgrounds.basement!.src = "backgrounds\\basement.jpg";
    const manifest = buildPublicAssetManifest(catalogWithBackslashes, "/game-assets/");
    expect(manifest.backgrounds.basement!.url).toBe("/game-assets/backgrounds/basement.jpg");
  });

  it("空分类保留为空对象", () => {
    const empty = buildPublicAssetManifest({ ...makeAssetCatalog(), bgm: {} }, "/game-assets/");
    expect(empty.bgm).toEqual({});
  });
});
