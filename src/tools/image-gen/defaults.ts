/**
 * image-gen — 内置默认参数（默认回退链的最后一层）。
 *
 * 回退顺序：显式参数 > 中间默认层（.env 可选默认值，见 env.ts）> 本文件。
 */

import type { ImageBackground, ImageQuality, ModerationLevel } from "./types.js";
import type { GptImageModelId } from "./types.js";

/** 参数层默认值：resolveGenerationParams / resolveEditParams 合并的兜底层。 */
export const GENERATION_DEFAULTS: {
  readonly model: GptImageModelId;
  readonly size: "auto";
  readonly quality: ImageQuality;
  readonly n: number;
  readonly background: ImageBackground;
  readonly moderation: ModerationLevel;
  readonly stream: boolean;
} = {
  model: "gpt-image-2",
  size: "auto",
  quality: "auto",
  n: 1,
  background: "auto",
  moderation: "auto",
  stream: false,
};
