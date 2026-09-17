/**
 * Wire-local mirror of the core stage visual state (docs
 * llm-outputs-refactor.md §52, §86 web, §107).
 *
 * The values arrive from Node as plain JSON (RuntimeOutput.presentation /
 * UiProjection.visualState), so this module re-declares the shape
 * structurally instead of importing from `src/core` — the browser never
 * depends on the core package. The two shapes are structurally identical,
 * which keeps the assignment in GameViewModel trivially compatible.
 */

/** Discrete character slots (§9); the renderer owns pixel coordinates. */
export type StagePosition = "far_left" | "left" | "center" | "right" | "far_right";

/** One character currently on stage. */
export interface StageCharacterState {
  spriteSet: string;
  variant: string;
  position: StagePosition;
  displayName: string;
  visible: boolean;
}

/** The authoritative stage picture: what is (or will be) on stage (§52). */
export interface StageVisualState {
  background?: string;
  bgm?: string;
  characters: Record<string, StageCharacterState>;
}

/** BGM 播放微调（秒）；core BgmPlayback 的 wire 镜像。 */
export interface BgmPlayback {
  /** 循环窗口起点（秒，含）。缺省 0。 */
  start?: number;
  /** 循环窗口终点（秒，含尾）；到达即回卷 start。缺省播到文件末尾。 */
  end?: number;
  /** 曲目开始时的淡入时长（秒）。 */
  fadeIn?: number;
  /** 切歌/停止前的淡出时长（秒）。 */
  fadeOut?: number;
}

/** Wire mirror of the core PublicAssetManifest (spec §5.2). */
export interface PublicAssetManifest {
  backgrounds: Record<string, { url: string }>;
  bgm: Record<string, { url: string; playback?: BgmPlayback }>;
  soundEffects: Record<string, { url: string }>;
  spriteSets: Record<
    string,
    {
      variants: Record<string, { url: string }>;
      /** 舞台显示高度占比（0–1]；缺省用样式默认值 0.92。 */
      presentation?: { height?: number };
    }
  >;
}

/** 瞬态演出 cue 的 wire 镜像（spec §6.4）；SE 是瞬时效果，不入 VisualState。 */
export type StageCueWire =
  | { type: "background"; assetId: string }
  | { type: "bgm"; assetId: string }
  | { type: "sound_effect"; assetId: string }
  | { type: "character_patch"; character: string; [key: string]: unknown };
