import type {
  CharacterPosition,
  CharacterRegistry,
  CharacterRegistryEntry,
} from "../presentation/types.js";

/**
 * Asset catalog types (docs §57–§60).
 *
 * The full catalog carries real file paths (`src`); the model-facing
 * projection strips them and keeps only logical ids + descriptions (§59).
 *
 * C7：角色身份不再随资源目录携带——`characters` 兼容形状已移除，身份
 * 真源是 C2 CharacterRoster（characters.yaml / canon），消费方一律注入
 * registry。
 */

export interface BackgroundAsset {
  id: string;
  src: string;
  description: string;
}

export interface BgmAsset {
  id: string;
  src: string;
  description: string;
  /** 已合并 bgm_playback 全局默认的每曲播放参数；无任何配置时缺省。 */
  playback?: BgmPlayback | undefined;
}

/**
 * BGM 播放微调：裁切窗口 + 淡入淡出（秒）。
 * 纯播放表现参数，模型目录不投影（toModelCatalog 只透出 description），
 * 只随公开 manifest 下发到浏览器。
 */
export interface BgmPlayback {
  /** 循环窗口起点（秒，含）。缺省 0。 */
  start?: number | undefined;
  /** 循环窗口终点（秒，含尾）；播放到达即回卷 start。缺省播到文件末尾。 */
  end?: number | undefined;
  /** 曲目开始时的淡入时长（秒）。0/缺省 = 立即全量音量。 */
  fadeIn?: number | undefined;
  /** 切歌/停止前的淡出时长（秒）。0/缺省 = 立即切换。 */
  fadeOut?: number | undefined;
}

export interface SoundEffectAsset {
  id: string;
  src: string;
  description: string;
}

export interface SpriteVariant {
  id: string;
  src: string;
  description?: string;
}

export interface SpriteSet {
  id: string;
  description?: string;
  variants: Record<string, SpriteVariant>;
}

export interface AssetCatalog {
  guidance: string;
  backgrounds: Record<string, BackgroundAsset>;
  bgm: Record<string, BgmAsset>;
  soundEffects: Record<string, SoundEffectAsset>;
  spriteSets: Record<string, SpriteSet>;
}

/**
 * Model-facing projection: logical ids + descriptions, NO file paths
 * (docs §59). This is what gets serialized into the prompt. 人物身份/外观
 * 按角色列 look 的渲染由 roster 承担（C6 §5.4）；本投影不再携带
 * characters 段（C7）。
 */
export interface ModelAssetCatalog {
  guidance: string;
  backgrounds: Record<string, { description: string }>;
  bgm: Record<string, { description: string }>;
  soundEffects: Record<string, { description: string }>;
  spriteSets: Record<
    string,
    { description?: string; variants: Record<string, { description?: string }> }
  >;
}

/**
 * Browser-facing projection: logical id → controlled URL (spec §5.2).
 * No filesystem paths are exposed; `url` is always a root-relative
 * path under the /game-assets/ prefix.
 */
export interface PublicAssetManifest {
  backgrounds: Record<string, { url: string }>;
  bgm: Record<string, { url: string; playback?: BgmPlayback }>;
  soundEffects: Record<string, { url: string }>;
  spriteSets: Record<string, { variants: Record<string, { url: string }> }>;
}

export interface AssetResolver {
  resolveBackground(id: string): { src: string } | undefined;
  resolveBgm(id: string): { src: string } | undefined;
  resolveSoundEffect(id: string): { src: string } | undefined;
  resolveSprite(spriteSet: string, variant: string): { src: string } | undefined;
}

// Re-exported for convenience so asset consumers do not need to reach
// into ../presentation for the registry types they build catalogs from.
export type { CharacterPosition, CharacterRegistry, CharacterRegistryEntry };
