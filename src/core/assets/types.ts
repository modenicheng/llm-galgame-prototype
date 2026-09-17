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
 */

export interface BackgroundAsset {
  id: string;
  src: string;
  description: string;
}

/**
 * BGM 播放微调：裁切窗口 + 淡入淡出（秒）。
 * 纯播放表现参数，模型目录不投影（toModelCatalog 只透出 description），
 * 只随公开 manifest 下发到浏览器（docs/asset-management.md「BGM 裁切与淡入淡出」）。
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

export interface BgmAsset {
  id: string;
  src: string;
  description: string;
  /** 已合并 bgm_playback 全局默认的每曲播放参数；无任何配置时缺省。 */
  playback?: BgmPlayback | undefined;
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
  /** 变体级覆写，浅合并到 sprite set 级 presentation 之上。 */
  presentation?: SpritePresentation;
}

/**
 * 立绘呈现参数（docs/asset-management.md「立绘 presentation」一节）。
 *
 * `rotate`/`crop`/`normalize` 触发服务端派生：host 启动时把处理后的
 * PNG 写入派生目录并重写 manifest URL，原始文件永不改动；同一套立绘
 * 的所有变体输出到同一规格画布（差分对齐、规格一致）。
 * `height` 是纯前端展示元数据（舞台高度占比），不触发文件处理。
 */
export interface SpritePresentation {
  /** 顺时针旋转角度（度）；90 的倍数走无损重排，任意角双线性采样。 */
  rotate?: number | undefined;
  /** 旋转后按源图像素硬裁切。 */
  crop?: { left: number; top: number; width: number; height: number } | undefined;
  /** 裁掉透明边并把整套变体归一到统一画布。 */
  normalize?: boolean | undefined;
  /** 舞台显示高度占比（0–1]，缺省由前端样式定（92%）。 */
  height?: number | undefined;
}

export interface SpriteSet {
  id: string;
  description?: string;
  variants: Record<string, SpriteVariant>;
  presentation?: SpritePresentation;
}

export interface CharacterAssetBinding {
  characterId: string;
  scriptName: string;
  displayName: string;
  spriteSet: string;
  defaultVariant: string;
  defaultPosition: CharacterPosition;
  /**
   * Sprite sets the character may use, incl. cross-set outfit swaps
   * (`[spriteSet:variant]` in dialogue). Defaults to [spriteSet] — a
   * character normally only renders with its own art (docs §15).
   */
  allowedSpriteSets: string[];
}

export interface AssetCatalog {
  guidance: string;
  backgrounds: Record<string, BackgroundAsset>;
  bgm: Record<string, BgmAsset>;
  soundEffects: Record<string, SoundEffectAsset>;
  spriteSets: Record<string, SpriteSet>;
  characters: Record<string, CharacterAssetBinding>;
}

/**
 * Model-facing projection: logical ids + descriptions, NO file paths
 * (docs §59). This is what gets serialized into the prompt.
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
  characters: Record<
    string,
    {
      scriptName: string;
      displayName: string;
      spriteSet: string;
      defaultVariant: string;
      defaultPosition: CharacterPosition;
      allowedSpriteSets: string[];
    }
  >;
}

/**
 * Browser-facing projection: logical id → controlled URL (spec §5.2).
 * No filesystem paths are exposed; `url` is always a root-relative
 * path under the /game-assets/ prefix. Sprite sets carrying a
 * `presentation.height` mirror it here so the stage renderer can size
 * figures per set; rotate/crop/normalize are already baked into the
 * served files and never re-applied client-side.
 */
export interface PublicAssetManifest {
  backgrounds: Record<string, { url: string }>;
  bgm: Record<string, { url: string; playback?: BgmPlayback }>;
  soundEffects: Record<string, { url: string }>;
  spriteSets: Record<
    string,
    { variants: Record<string, { url: string }>; presentation?: { height?: number } }
  >;
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
