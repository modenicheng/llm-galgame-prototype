import type { AssetCatalog, PublicAssetManifest } from "../../core/assets/types.js";

/**
 * id → 受控 URL 投影（spec §5.2）。`src` 视为相对素材根，反斜杠归一
 * （Windows 素材路径），投影结果永远不包含绝对路径或回溯段。
 */
export function buildPublicAssetManifest(
  catalog: AssetCatalog,
  urlPrefix: string,
): PublicAssetManifest {
  const url = (src: string): string => `${urlPrefix}${src.replace(/\\/g, "/")}`;
  const backgrounds: PublicAssetManifest["backgrounds"] = {};
  for (const [id, asset] of Object.entries(catalog.backgrounds)) {
    backgrounds[id] = { url: url(asset.src) };
  }
  const bgm: PublicAssetManifest["bgm"] = {};
  for (const [id, asset] of Object.entries(catalog.bgm)) {
    bgm[id] = { url: url(asset.src) };
  }
  const soundEffects: PublicAssetManifest["soundEffects"] = {};
  for (const [id, asset] of Object.entries(catalog.soundEffects)) {
    soundEffects[id] = { url: url(asset.src) };
  }
  const spriteSets: PublicAssetManifest["spriteSets"] = {};
  for (const [id, set] of Object.entries(catalog.spriteSets)) {
    const variants: Record<string, { url: string }> = {};
    for (const [variantId, variant] of Object.entries(set.variants)) {
      variants[variantId] = { url: url(variant.src) };
    }
    spriteSets[id] = { variants };
  }
  return { backgrounds, bgm, soundEffects, spriteSets };
}
