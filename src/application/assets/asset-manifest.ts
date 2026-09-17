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
    // playback（裁切窗口/淡入淡出）与 height 同理：纯展示参数随 manifest 下发，
    // 不改文件、不进模型目录。
    bgm[id] = {
      url: url(asset.src),
      ...(asset.playback !== undefined ? { playback: asset.playback } : {}),
    };
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
    // 只有 height 需要到达浏览器（舞台显示占比）；rotate/crop/normalize
    // 由 host 派生时烘焙进文件，浏览器不重复处理。
    const height = set.presentation?.height;
    spriteSets[id] = {
      variants,
      ...(height !== undefined ? { presentation: { height } } : {}),
    };
  }
  return { backgrounds, bgm, soundEffects, spriteSets };
}
