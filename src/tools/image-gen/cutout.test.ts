/**
 * Tests for cutout.ts — 合成 PNG 验证透明检测、连通性抠图与 cutout 决策。
 */
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  cutoutBackground,
  processForCutout,
  transparentRatio,
  withCutoutPromptHint,
  CUTOUT_PROMPT_HINT,
} from "./cutout.js";
import type { GeneratedImage } from "./types.js";

type RGBA = readonly [number, number, number, number];

function makePng(width: number, height: number, paint: (x: number, y: number) => RGBA): Uint8Array {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const index = (png.width * y + x) << 2;
      png.data[index] = r;
      png.data[index + 1] = g;
      png.data[index + 2] = b;
      png.data[index + 3] = a;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

function readPixel(bytes: Uint8Array, x: number, y: number): RGBA {
  const png = PNG.sync.read(Buffer.from(bytes));
  const index = (png.width * y + x) << 2;
  return [png.data[index]!, png.data[index + 1]!, png.data[index + 2]!, png.data[index + 3]!];
}

const WHITE: RGBA = [255, 255, 255, 255];
const RED: RGBA = [200, 30, 30, 255];

function makeImage(bytes: Uint8Array): GeneratedImage {
  return { bytes, format: "png" };
}

describe("transparentRatio", () => {
  it("全不透明为 0；半透明像素（alpha≥8）不算透明", () => {
    expect(transparentRatio(makePng(4, 4, () => WHITE))).toBe(0);
    const semi = makePng(4, 4, () => [255, 255, 255, 20]);
    expect(transparentRatio(semi)).toBe(0);
  });

  it("统计 alpha<8 的像素占比", () => {
    const half = makePng(4, 4, (x) => (x < 2 ? [0, 0, 0, 0] : WHITE));
    expect(transparentRatio(half)).toBeCloseTo(0.5);
  });

  it("非 PNG 数据返回 null", () => {
    expect(transparentRatio(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe("cutoutBackground — 连通性", () => {
  it("与边界连通的白色背景被移除，中心主体保留", () => {
    // 16x16：白色背景 + 中心 8x8 红色主体
    const png = makePng(16, 16, (x, y) =>
      x >= 4 && x < 12 && y >= 4 && y < 12 ? RED : WHITE,
    );
    const result = cutoutBackground(png);
    expect(result).not.toBeNull();
    expect(result!.removedRatio).toBeCloseTo((256 - 64) / 256, 5);
    expect(readPixel(result!.png, 0, 0)[3]).toBe(0);
    expect(readPixel(result!.png, 15, 15)[3]).toBe(0);
    expect(readPixel(result!.png, 8, 8)).toEqual([200, 30, 30, 255]);
  });

  it("不与边界连通的大块白色区域不会被误抠", () => {
    // 红色背景 + 中央白色方块（16x16=256px，占 25%，超过封闭清除阈值）
    const png = makePng(16, 16, (x, y) =>
      x >= 6 && x < 10 && y >= 6 && y < 10 ? WHITE : RED,
    );
    const result = cutoutBackground(png);
    expect(result!.removedRatio).toBe(0);
    expect(readPixel(result!.png, 8, 8)[3]).toBe(255);
  });

  it("默认不清除封闭白缝（保证不误伤角色内部）", () => {
    // 中央 4x4 白缝（约 0.4%，不与边界连通）→ 默认保留
    const png = makePng(32, 32, (x, y) =>
      x >= 14 && x < 18 && y >= 14 && y < 18 ? WHITE : RED,
    );
    const result = cutoutBackground(png);
    expect(result!.removedRatio).toBe(0);
    expect(readPixel(result!.png, 15, 15)[3]).toBe(255);
  });

  it("cleanEnclosed：小面积深描边白缝被清除，大面积白色区域保留", () => {
    // 红色 32x32：中央 2x2 白缝（4px ≈ 0.4%，红边为深描边）+ 偏左 10x10 白块（≈9.8%）
    const png = makePng(32, 32, (x, y) => {
      if (x >= 15 && x < 17 && y >= 15 && y < 17) return WHITE; // 小缝
      if (x >= 2 && x < 12 && y >= 2 && y < 12) return WHITE; // 大块
      return RED;
    });
    const result = cutoutBackground(png, { cleanEnclosed: true });
    expect(result!.removedRatio).toBeCloseTo(4 / 1024, 5);
    expect(readPixel(result!.png, 16, 16)[3]).toBe(0); // 小缝已清
    expect(readPixel(result!.png, 7, 7)[3]).toBe(255); // 大块保留
  });

  it("cleanEnclosed：浅色边界包围的白缝保留（如皮肤/衣物高光）", () => {
    const LIGHT: RGBA = [235, 225, 205, 255]; // 浅米色（亮度 ≈ 223）
    const png = makePng(32, 32, (x, y) =>
      x >= 14 && x < 18 && y >= 14 && y < 18 ? WHITE : LIGHT,
    );
    const result = cutoutBackground(png, { cleanEnclosed: true });
    expect(result!.removedRatio).toBe(0);
    expect(readPixel(result!.png, 15, 15)[3]).toBe(255);
  });

  it("浅灰色背景（容差内）同样被移除", () => {
    const png = makePng(8, 8, (x, y) => (x >= 3 && x < 5 && y >= 3 && y < 5 ? RED : [230, 230, 230, 255]));
    const result = cutoutBackground(png);
    expect(result!.removedRatio).toBeCloseTo((64 - 4) / 64, 5);
  });

  it("已透明像素直接并入背景", () => {
    const png = makePng(4, 4, (x) => (x < 2 ? [0, 0, 0, 0] : WHITE));
    const result = cutoutBackground(png);
    // removedRatio 只统计算法置透明的像素（14/16）：内部 2 个原本已透明的像素
    // 不参与泛洪（非近白），输出图像仍为全透明。
    expect(result!.removedRatio).toBeCloseTo(14 / 16, 5);
    expect(readPixel(result!.png, 1, 1)[3]).toBe(0);
    expect(readPixel(result!.png, 3, 3)[3]).toBe(0);
  });

  it("非 PNG 数据返回 null", () => {
    expect(cutoutBackground(new Uint8Array([9, 9, 9]))).toBeNull();
  });
});

describe("withCutoutPromptHint", () => {
  it("为普通提示词追加白底片段", () => {
    expect(withCutoutPromptHint("大学生立绘")).toBe(`大学生立绘${CUTOUT_PROMPT_HINT}`);
  });

  it("已含白底关键词时不重复注入", () => {
    expect(withCutoutPromptHint("大学生立绘，纯白背景")).toBe("大学生立绘，纯白背景");
    expect(withCutoutPromptHint("大学生立绘，白底")).toBe("大学生立绘，白底");
    expect(withCutoutPromptHint("portrait, white background")).toBe(
      "portrait, white background",
    );
  });
});

describe("processForCutout — 决策", () => {
  const RED_CENTER_PNG = () =>
    makePng(16, 16, (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? RED : WHITE));

  it("已有真透明 → kept-alpha，不调用 AI", async () => {
    let aiCalled = false;
    const impl = async (bytes: Uint8Array) => {
      aiCalled = true;
      return bytes;
    };
    const half = makePng(4, 4, (x) => (x < 2 ? [0, 0, 0, 0] : WHITE));
    const outcome = await processForCutout(makeImage(half), { aiMattingImpl: impl });
    expect(outcome.action).toBe("kept-alpha");
    expect(aiCalled).toBe(false);
  });

  it("默认引擎 ai：注入实现生效，结果为透明图", async () => {
    const impl = async (): Promise<Uint8Array> =>
      makePng(16, 16, (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? RED : [0, 0, 0, 0]));
    const outcome = await processForCutout(makeImage(RED_CENTER_PNG()), { aiMattingImpl: impl });
    expect(outcome.action).toBe("ai-matting");
    expect(outcome.engine).toBe("ai");
    expect(outcome.fallbackFromAi).toBeUndefined();
    expect(outcome.removedRatio).toBeCloseTo(0.75, 5);
    expect(readPixel(outcome.image.bytes, 0, 0)[3]).toBe(0);
  });

  it("AI 结果无透明 → 自动回退 flood", async () => {
    const impl = async (bytes: Uint8Array): Promise<Uint8Array> => bytes;
    const outcome = await processForCutout(makeImage(RED_CENTER_PNG()), { aiMattingImpl: impl });
    expect(outcome.action).toBe("cutout");
    expect(outcome.engine).toBe("flood");
    expect(outcome.fallbackFromAi).toBe(true);
    expect(readPixel(outcome.image.bytes, 0, 0)[3]).toBe(0);
  });

  it("AI 抛错 → 自动回退 flood", async () => {
    const impl = async (): Promise<Uint8Array> => {
      throw new Error("model offline");
    };
    const outcome = await processForCutout(makeImage(RED_CENTER_PNG()), { aiMattingImpl: impl });
    expect(outcome.action).toBe("cutout");
    expect(outcome.engine).toBe("flood");
    expect(outcome.fallbackFromAi).toBe(true);
    expect(readPixel(outcome.image.bytes, 0, 0)[3]).toBe(0);
  });

  it("engine=flood：不调用 AI，直接几何抠图", async () => {
    let aiCalled = false;
    const impl = async (bytes: Uint8Array) => {
      aiCalled = true;
      return bytes;
    };
    const outcome = await processForCutout(makeImage(RED_CENTER_PNG()), {
      engine: "flood",
      aiMattingImpl: impl,
    });
    expect(outcome.action).toBe("cutout");
    expect(outcome.engine).toBe("flood");
    expect(outcome.fallbackFromAi).toBeUndefined();
    expect(outcome.removedRatio).toBeCloseTo((256 - 64) / 256, 5);
    expect(aiCalled).toBe(false);
  });

  it("深色背景 → no-background，保留原图（flood 与 AI 回退皆同）", async () => {
    const png = makePng(8, 8, () => RED);
    const floodOutcome = await processForCutout(makeImage(png), { engine: "flood" });
    expect(floodOutcome.action).toBe("no-background");
    expect(floodOutcome.image.bytes).toBe(png);
  });

  it("解析失败 → opaque-skip", async () => {
    expect((await processForCutout(makeImage(new Uint8Array([1, 1, 1])))).action).toBe(
      "opaque-skip",
    );
    expect(
      (await processForCutout({ bytes: new Uint8Array([1, 1, 1]), format: "jpeg" })).action,
    ).toBe("opaque-skip");
  });
});
