/**
 * image-gen — 自动抠图（--cutout 模式的核心实现）。
 *
 * 背景：gpt-image 系列原生支持 `background: "transparent"`（须输出 png/webp），
 * 但实际遵从度并非 100% —— 模型偶发渲染白底/棋盘格，走中转时参数也可能被丢弃。
 * 因此 cutout 模式采取「双保险」：
 *   1. 请求侧自动注入透明参数与提示词（纯白背景、无阴影、边缘清晰）；
 *   2. 结果侧检测 alpha：已有真透明则直接采用；否则做白底抠图兜底。
 *
 * 抠图引擎（processForCutout）：
 *   - ai（默认）：matting.ts 的 ISNet 模型推理，软边 alpha，发丝友好；
 *   - flood：本模块的几何泛洪（离线零模型，AI 失败时的自动兜底）——
 *     第一遍从边界连通移除近白背景，绝不误伤角色内部白色区域；第二遍
 *     （cleanEnclosed，opt-in）清除被深色描边包围的小面积封闭白缝。
 *     棋盘格假透明与深色背景不属于近白纯色，无法由此算法移除（见 README）。
 *
 * PNG 编解码使用 pngjs（纯 JS）；cutout 模式强制输出 png，因此无需其他格式解码。
 */

import { PNG } from "pngjs";
import { aiMatting, type AiMattingFn, type MattingDevice } from "./matting.js";
import type { GeneratedImage } from "./types.js";

/** 近白判定：每个通道与 255 的距离不超过该值（0~255）。 */
export const DEFAULT_TOLERANCE = 40;
/** 透明像素占比达到该值即认为「已有真透明」，跳过抠图。 */
export const ALPHA_SKIP_RATIO = 0.01;
/** 抠图移除占比低于该值视为「没有可抠的浅色背景」，保留原图。 */
export const CUTOUT_MIN_REMOVED = 0.01;
/**
 * 封闭近白区域的清除上限（占全图像素比）：小于该值的封闭白缝才可能被
 * cleanEnclosed 清除；更大的白色区域（衣物、高光）一律保留。
 * 依据实测立绘调整：白T恤约 1.1%，发丝/领口缝隙 ≤0.17%，取 0.5% 居中分隔。
 */
export const DEFAULT_MAX_ENCLOSED_RATIO = 0.005;
/**
 * cleanEnclosed 的深色描边判定：分量边界 1px 内最小亮度不超过该值才清除。
 * 发丝/领口缝被深色头发与衣线包围（实测 32~66）；皮肤、开衫褶皱高光的边界
 * 是浅色（实测 ≥110），得以保留。注意：帆布鞋等「深描边浅色物件」同样满足
 * 该条件，cleanEnclosed 可能在其上产生破洞——属已知取舍（见 README）。
 */
export const DEFAULT_DARK_BOUNDARY_LUM = 100;

/** 自动注入到提示词末尾的抠图友好片段（已含关键词时不重复注入）。 */
export const CUTOUT_PROMPT_HINT = "，纯白色背景，主体完整，边缘清晰锐利，无阴影，无渐变，无杂物";

export function withCutoutPromptHint(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.includes("纯白背景") || trimmed.includes("白底") || /white\s*background/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}${CUTOUT_PROMPT_HINT}`;
}

/** 读取 PNG 的透明像素占比（0~1）；非 PNG 或解析失败返回 null。 */
export function transparentRatio(bytes: Uint8Array): number | null {
  let image: PNG;
  try {
    image = PNG.sync.read(Buffer.from(bytes));
  } catch {
    return null;
  }
  const data = image.data;
  const total = image.width * image.height;
  if (total === 0) return null;
  let transparent = 0;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset]! < 8) transparent += 1;
  }
  return transparent / total;
}

export interface CutoutOptions {
  /** 近白判定容差（每通道 0~255）。默认 40。 */
  tolerance?: number;
  /**
   * 清除被主体包围的小面积白缝（发丝间、领口等，需被深色描边包围）。
   * 默认关闭——只做边界连通抠图，保证绝不误伤角色内部区域。
   */
  cleanEnclosed?: boolean;
  /** 封闭白缝的清除上限（占全图比例）。默认 0.005，仅 cleanEnclosed 时生效。 */
  maxEnclosedRatio?: number;
  /** 深色描边判定亮度上限。默认 100，仅 cleanEnclosed 时生效。 */
  darkBoundaryLum?: number;
}

export interface CutoutResult {
  png: Uint8Array;
  /** 被移除（置为全透明）的像素占比。 */
  removedRatio: number;
}

/**
 * 白底抠图：从边界连通泛洪移除近白背景。
 * 返回 null 表示 PNG 解析失败；removedRatio 极低通常意味着背景不是浅色。
 */
export function cutoutBackground(bytes: Uint8Array, options: CutoutOptions = {}): CutoutResult | null {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  let image: PNG;
  try {
    image = PNG.sync.read(Buffer.from(bytes));
  } catch {
    return null;
  }
  const { width, height, data } = image;
  const total = width * height;
  const isBackground = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const isNearWhite = (index: number): boolean => {
    const offset = index * 4;
    return (
      255 - data[offset]! <= tolerance &&
      255 - data[offset + 1]! <= tolerance &&
      255 - data[offset + 2]! <= tolerance
    );
  };
  const trySeed = (index: number): void => {
    if (isBackground[index] === 1) return;
    const transparent = data[index * 4 + 3]! < 8;
    if (transparent || isNearWhite(index)) {
      isBackground[index] = 1;
      queue[tail] = index;
      tail += 1;
    }
  };

  for (let x = 0; x < width; x++) {
    trySeed(x);
    trySeed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    trySeed(y * width);
    trySeed(y * width + width - 1);
  }

  while (head < tail) {
    const index = queue[head]!;
    head += 1;
    const x = index % width;
    const y = (index - x) / width;
    const neighbors = [
      x > 0 ? index - 1 : -1,
      x < width - 1 ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y < height - 1 ? index + width : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || isBackground[neighbor] === 1) continue;
      if (!isNearWhite(neighbor)) continue;
      isBackground[neighbor] = 1;
      queue[tail] = neighbor;
      tail += 1;
    }
  }

  // 第二遍（可选，cleanEnclosed）：清除被主体包围的小面积白缝（发丝间、领口
  // 等——不与边界连通，第一遍够不到）。判据双保险：面积 ≤ maxEnclosedRatio
  // 且边界 1px 内存在深色描边（最小亮度 ≤ darkBoundaryLum）。皮肤、衣物褶皱
  // 等高光的边界是浅色，得以保留；帆布鞋类深描边浅色物件有误伤风险（见 README）。
  if (options.cleanEnclosed === true) {
    const maxEnclosed = Math.max(
      1,
      Math.floor(total * (options.maxEnclosedRatio ?? DEFAULT_MAX_ENCLOSED_RATIO)),
    );
    const darkLum = options.darkBoundaryLum ?? DEFAULT_DARK_BOUNDARY_LUM;
    const visited = new Uint8Array(total);
    const component = new Int32Array(total);
    for (let start = 0; start < total; start++) {
      if (isBackground[start] === 1 || visited[start] === 1 || !isNearWhite(start)) continue;
      let head = 0;
      let tail = 0;
      let borderMinLum = 255;
      component[tail] = start;
      tail += 1;
      visited[start] = 1;
      while (head < tail) {
        const index = component[head]!;
        head += 1;
        const x = index % width;
        const y = (index - x) / width;
        const neighbors = [
          x > 0 ? index - 1 : -1,
          x < width - 1 ? index + 1 : -1,
          y > 0 ? index - width : -1,
          y < height - 1 ? index + width : -1,
        ];
        for (const neighbor of neighbors) {
          if (neighbor < 0) continue;
          if (visited[neighbor] === 1) continue;
          if (isBackground[neighbor] === 0 && isNearWhite(neighbor)) {
            visited[neighbor] = 1;
            component[tail] = neighbor;
            tail += 1;
            continue;
          }
          const o = neighbor * 4;
          const l = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
          if (l < borderMinLum) borderMinLum = l;
        }
      }
      if (tail <= maxEnclosed && borderMinLum <= darkLum) {
        for (let i = 0; i < tail; i++) isBackground[component[i]!] = 1;
      }
    }
  }

  let removed = 0;
  for (let index = 0; index < total; index++) {
    if (isBackground[index] !== 1) continue;
    data[index * 4 + 3] = 0;
    removed += 1;
  }
  return { png: new Uint8Array(PNG.sync.write(image)), removedRatio: removed / total };
}

/** 单张结果图的 cutout 处理决策。 */
export type CutoutAction =
  | "kept-alpha" /** 已有真透明，无需处理 */
  | "ai-matting" /** AI 模型抠图（ISNet，软边发丝） */
  | "cutout" /** 白底几何抠图 */
  | "no-background" /** 背景不是浅色，无法抠图，保留原图 */
  | "opaque-skip"; /** 非 png 或解析失败，保留原图 */

export type CutoutEngine = "ai" | "flood";

export interface CutoutProcessOptions {
  /** 抠图引擎：ai（默认，ISNet 软边）或 flood（纯几何，离线兜底）。 */
  engine?: CutoutEngine;
  /** flood 引擎可选：清除被深色描边包围的小面积封闭白缝。 */
  cleanEnclosed?: boolean;
  /** flood 近白判定容差（每通道 0~255）。默认 40。 */
  tolerance?: number;
  /** flood 封闭白缝清除上限（占全图比例）。默认 0.005。 */
  maxEnclosedRatio?: number;
  /** flood 深色描边判定亮度上限。默认 100。 */
  darkBoundaryLum?: number;
  /** AI 模型资源目录或镜像地址（缺省用包内本地资源）。 */
  /** 执行设备：cpu（默认）或 dml（DirectML，批处理推荐）。 */
  device?: MattingDevice;
  /** 独立 .onnx 模型文件路径；缺省从 imgly 包资源拼装。 */
  modelPath?: string;
  /** 注入 AI 抠图实现，测试用。 */
  aiMattingImpl?: AiMattingFn;
}

export interface CutoutProcessResult {
  image: GeneratedImage;
  action: CutoutAction;
  /** 实际生效的引擎（engine=ai 但回退时为 flood）。 */
  engine?: CutoutEngine;
  /** action=ai-matting 时为结果的透明占比；action=cutout 时为移除占比。 */
  removedRatio?: number;
  /** engine=ai 但 AI 失败、已回退 flood。 */
  fallbackFromAi?: boolean;
}

interface FloodOptions {
  cleanEnclosed?: boolean;
  tolerance?: number;
  maxEnclosedRatio?: number;
  darkBoundaryLum?: number;
}

/** flood 引擎决策（cutoutBackground + 阈值判定）。null = PNG 解析失败。 */
function floodCutout(image: GeneratedImage, options: FloodOptions): CutoutProcessResult | null {
  const cut = cutoutBackground(image.bytes, {
    ...(options.cleanEnclosed !== undefined ? { cleanEnclosed: options.cleanEnclosed } : {}),
    ...(options.tolerance !== undefined ? { tolerance: options.tolerance } : {}),
    ...(options.maxEnclosedRatio !== undefined ? { maxEnclosedRatio: options.maxEnclosedRatio } : {}),
    ...(options.darkBoundaryLum !== undefined ? { darkBoundaryLum: options.darkBoundaryLum } : {}),
  });
  if (cut === null) return null;
  if (cut.removedRatio < CUTOUT_MIN_REMOVED) return { image, action: "no-background" };
  return {
    image: { ...image, bytes: cut.png },
    action: "cutout",
    removedRatio: cut.removedRatio,
  };
}

/**
 * 对一张生成结果执行 cutout 决策（检测 alpha → 引擎抠图）。
 * 默认引擎 ai：ISNet 模型输出软边 alpha（发丝友好）；模型失败或结果异常时
 * 自动回退 flood 并标记 fallbackFromAi。engine=flood 则直接走几何抠图。
 */
export async function processForCutout(
  image: GeneratedImage,
  options: CutoutProcessOptions = {},
): Promise<CutoutProcessResult> {
  if (image.format !== "png") return { image, action: "opaque-skip" };
  const ratio = transparentRatio(image.bytes);
  if (ratio === null) return { image, action: "opaque-skip" };
  if (ratio >= ALPHA_SKIP_RATIO) return { image, action: "kept-alpha" };

  if ((options.engine ?? "ai") === "ai") {
    try {
      const matted = await aiMatting(image.bytes, {
        ...(options.device !== undefined ? { device: options.device } : {}),
        ...(options.modelPath !== undefined ? { modelPath: options.modelPath } : {}),
        ...(options.aiMattingImpl !== undefined ? { impl: options.aiMattingImpl } : {}),
      });
      const mattedRatio = transparentRatio(matted);
      if (mattedRatio !== null && mattedRatio >= ALPHA_SKIP_RATIO) {
        return {
          image: { ...image, bytes: matted },
          action: "ai-matting",
          engine: "ai",
          removedRatio: mattedRatio,
        };
      }
      // AI 结果不是合法 PNG 或几乎无透明：按失败处理，走 flood 回退
    } catch {
      // 模型加载/推理失败：走 flood 回退
    }
    const flood = floodCutout(image, options);
    if (flood === null) return { image, action: "opaque-skip", engine: "flood", fallbackFromAi: true };
    return { ...flood, engine: "flood", fallbackFromAi: true };
  }

  const flood = floodCutout(image, options);
  if (flood === null) return { image, action: "opaque-skip" };
  return { ...flood, engine: "flood" };
}
