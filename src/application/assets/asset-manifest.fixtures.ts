import type { AssetCatalog } from "../../core/assets/types.js";

/**
 * Minimal in-memory AssetCatalog for manifest/host tests. `src` values are
 * relative to the asset root and deliberately contain no leading slash or
 * ".." so the projection assertions can prove no absolute paths leak.
 */
export function makeAssetCatalog(): AssetCatalog {
  return {
    guidance: "test catalog",
    backgrounds: {
      basement: { id: "basement", src: "backgrounds/basement.jpg", description: "地下室" },
    },
    bgm: {
      mystery: { id: "mystery", src: "audio/bgm/mystery.mp3", description: "悬疑 BGM" },
    },
    soundEffects: {
      beep: { id: "beep", src: "audio/beep.wav", description: "提示音" },
    },
    spriteSets: {
      suyao: {
        id: "suyao",
        description: "苏瑶",
        variants: {
          anxious: { id: "anxious", src: "characters/suyao/anxious.png", description: "不安" },
        },
      },
    },
    characters: {},
  };
}
