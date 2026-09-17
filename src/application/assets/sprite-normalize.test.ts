/**
 * Tests for the sprite presentation derivation pipeline
 * (rotate → crop → alpha trim → per-set union canvas, with disk cache).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import {
  alphaBBox,
  composeVariantCanvases,
  cropImage,
  effectivePresentation,
  normalizeSprites,
  rotateImage,
  type RGBAImage,
} from "./sprite-normalize.js";
import type { AssetCatalog, SpriteSet } from "../../core/assets/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sprite-normalize-"));
  tempDirs.push(dir);
  return dir;
}

function makeImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
): RGBAImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

function toPngBuffer(image: RGBAImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

function fromPngBuffer(buffer: Buffer): RGBAImage {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/**
 * 一套合成"立绘"：身体固定在 (3..6, 4..9)，头 2×2 在 y 0..1、随 headX
 * 变化且始终落在身体左右两侧之外 —— 保证不同变体的 bbox 真的不同。
 */
function variantImage(headX: number, headColor: [number, number, number]): RGBAImage {
  return makeImage(10, 12, (x, y) => {
    if (y >= 4 && y <= 9 && x >= 3 && x <= 6) return [200, 100, 50, 255];
    if (y <= 1 && x >= headX && x <= headX + 1) return [...headColor, 255] as [number, number, number, number];
    return [0, 0, 0, 0];
  });
}

function makeCatalog(spriteSets: Record<string, SpriteSet>): AssetCatalog {
  return {
    guidance: "",
    backgrounds: {},
    bgm: {},
    soundEffects: {},
    spriteSets,
    characters: {},
  };
}

async function writeSet(
  assetRoot: string,
  setId: string,
  variants: Record<string, RGBAImage>,
): Promise<void> {
  for (const [variantId, image] of Object.entries(variants)) {
    const file = path.join(assetRoot, "characters", setId, `${variantId}.png`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, toPngBuffer(image));
  }
}

const URL_PREFIX = "/game-assets/__derived__/";

// ---------------------------------------------------------------------------
// 纯图像运算
// ---------------------------------------------------------------------------

describe("rotateImage", () => {
  it("90° 顺时针：尺寸互换 + 像素重排", () => {
    const image = makeImage(3, 2, (x, y) => [x, y, 0, 255]);
    const out = rotateImage(image, 90);
    expect(out.width).toBe(2);
    expect(out.height).toBe(3);
    // (x,y) → (H-1-y, x)
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        const dx = 2 - 1 - y;
        const dy = x;
        const i = (dy * out.width + dx) * 4;
        expect([out.data[i], out.data[i + 1]]).toEqual([x, y]);
      }
    }
  });

  it("180° 与 360°：可预测结果", () => {
    const image = makeImage(2, 2, (x, y) => [x + 10 * y, 0, 0, 255]);
    const half = rotateImage(image, 180);
    expect(half.data[0]).toBe(11); // (1,1) 转到 (0,0)
    expect(rotateImage(image, 360)).toEqual(image);
  });

  it("45°：输出外接矩形 + 中心保持不透明", () => {
    const image = makeImage(8, 8, (x, y) =>
      x >= 2 && x <= 5 && y >= 2 && y <= 5 ? [255, 0, 0, 255] : [0, 0, 0, 0],
    );
    const out = rotateImage(image, 45);
    expect(out.width).toBe(Math.ceil(8 * Math.SQRT2));
    expect(out.height).toBe(Math.ceil(8 * Math.SQRT2));
    const c = Math.floor(out.width / 2);
    const i = (c * out.width + c) * 4;
    expect(out.data[i + 3]).toBeGreaterThan(200);
    expect(out.data[i]).toBeGreaterThan(200);
  });
});

describe("alphaBBox + cropImage", () => {
  it("bbox 收紧到非透明区域，全透明返回 undefined", () => {
    const image = variantImage(1, [10, 200, 10]);
    // 头 (1..2, 0..1) + 身体 (3..6, 4..9)。
    expect(alphaBBox(image)).toEqual({ x: 1, y: 0, width: 6, height: 10 });
    const empty = makeImage(4, 4, () => [0, 0, 0, 0]);
    expect(alphaBBox(empty)).toBeUndefined();
  });

  it("crop 硬裁切，越界补透明", () => {
    const image = makeImage(4, 4, (x, y) => [x, y, 0, 255]);
    const out = cropImage(image, { left: 2, top: 2, width: 4, height: 4 });
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    expect(out.data[3]).toBe(255); // (0,0) ← 源 (2,2) 不透明
    expect(out.data[(3 * 4 + 3) * 4 + 3]).toBe(0); // 右下角越界 → 透明
  });
});

describe("composeVariantCanvases", () => {
  it("同套统一画布：union 尺寸一致 + 差分相对位置对齐", () => {
    // 左头（x1..2）与右头（x7..8）→ 变体 bbox 分别 x1..6 / x3..8。
    const a = variantImage(1, [255, 0, 0]);
    const b = variantImage(7, [0, 0, 255]);
    const { canvas, outputs, offsets } = composeVariantCanvases([a, b]);
    expect(canvas).toEqual({ width: 8, height: 10 });
    for (const out of outputs) {
      expect(out.width).toBe(canvas.width);
      expect(out.height).toBe(canvas.height);
    }
    expect(offsets).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
    ]);
    // 差分对齐：身体像素 (3,4) 落在同一 union 坐标 (2,4)。
    const bodyUnion = (4 * canvas.width + 2) * 4;
    expect(outputs[0]!.data[bodyUnion + 3]).toBe(255);
    expect(outputs[1]!.data[bodyUnion + 3]).toBe(255);
    // 红头在 union (0,0)；蓝头在 union (6,0)。
    expect(outputs[0]!.data[0]).toBe(255);
    const blueHead = (0 * canvas.width + 6) * 4;
    expect(outputs[1]!.data[blueHead]).toBe(0);
    expect(outputs[1]!.data[blueHead + 2]).toBe(255);
  });

  it("全透明变体抛错", () => {
    const empty = makeImage(4, 4, () => [0, 0, 0, 0]);
    expect(() => composeVariantCanvases([empty])).toThrow(/整图透明/);
  });
});

// ---------------------------------------------------------------------------
// 文件系统管线
// ---------------------------------------------------------------------------

describe("normalizeSprites", () => {
  it("未配置 presentation 的 set 不处理、不出现在结果", async () => {
    const assetRoot = await makeTempDir();
    const derivedRoot = await makeTempDir();
    await writeSet(assetRoot, "plain", { base: variantImage(1, [255, 0, 0]) });
    const catalog = makeCatalog({
      plain: { id: "plain", variants: { base: { id: "base", src: "characters/plain/base.png" } } },
    });
    const result = await normalizeSprites(catalog, { assetRoot, derivedRoot, urlPrefix: URL_PREFIX });
    expect(result.urls.plain).toBeUndefined();
    expect(result.specs.plain).toBeUndefined();
    expect(existsSync(path.join(derivedRoot, "plain"))).toBe(false);
  });

  it("normalize 触发裁边 + 同套统一画布，URL 指向派生文件", async () => {
    const assetRoot = await makeTempDir();
    const derivedRoot = await makeTempDir();
    await writeSet(assetRoot, "hero", {
      base: variantImage(1, [255, 0, 0]),
      alt: variantImage(7, [0, 0, 255]),
    });
    const catalog = makeCatalog({
      hero: {
        id: "hero",
        presentation: { normalize: true },
        variants: {
          base: { id: "base", src: "characters/hero/base.png" },
          alt: { id: "alt", src: "characters/hero/alt.png" },
        },
      },
    });
    const result = await normalizeSprites(catalog, { assetRoot, derivedRoot, urlPrefix: URL_PREFIX });
    expect(result.urls.hero?.base).toBe("/game-assets/__derived__/hero/base.png");
    expect(result.specs.hero).toEqual({ width: 8, height: 10 });
    const base = fromPngBuffer(await readFile(path.join(derivedRoot, "hero", "base.png")));
    const alt = fromPngBuffer(await readFile(path.join(derivedRoot, "hero", "alt.png")));
    expect(base.width).toBe(alt.width);
    expect(base.height).toBe(alt.height);
    // 红头落在 union (0,0)；蓝头落在 union (6,0)。
    expect(base.data[0]).toBe(255);
    expect(alt.data[6 * 4 + 2]).toBe(255);
  });

  it("rotate + crop 组合按顺序生效", async () => {
    const assetRoot = await makeTempDir();
    const derivedRoot = await makeTempDir();
    await writeSet(assetRoot, "turn", {
      // 6×4 画布，图形在 (2..3, 1..2)。
      base: makeImage(6, 4, (x, y) =>
        x >= 2 && x <= 3 && y >= 1 && y <= 2 ? [255, 128, 0, 255] : [0, 0, 0, 0],
      ),
    });
    const catalog = makeCatalog({
      turn: {
        id: "turn",
        presentation: { rotate: 90, crop: { left: 1, top: 2, width: 2, height: 2 } },
        variants: { base: { id: "base", src: "characters/turn/base.png" } },
      },
    });
    const result = await normalizeSprites(catalog, { assetRoot, derivedRoot, urlPrefix: URL_PREFIX });
    // 旋转 90° 后图形位于 (1..2, 2..3)；裁切 (1,2) 起 2×2 正好框住它。
    expect(result.specs.turn).toEqual({ width: 2, height: 2 });
    const out = fromPngBuffer(await readFile(path.join(derivedRoot, "turn", "base.png")));
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(out.data[3]).toBe(255);
  });

  it("纯 height 配置投影高度但不触发文件处理", async () => {
    const assetRoot = await makeTempDir();
    const derivedRoot = await makeTempDir();
    await writeSet(assetRoot, "meta", { base: variantImage(1, [255, 0, 0]) });
    const catalog = makeCatalog({
      meta: {
        id: "meta",
        presentation: { height: 0.85 },
        variants: { base: { id: "base", src: "characters/meta/base.png" } },
      },
    });
    const result = await normalizeSprites(catalog, { assetRoot, derivedRoot, urlPrefix: URL_PREFIX });
    expect(result.heights.meta).toBe(0.85);
    expect(result.urls.meta).toBeUndefined();
    expect(existsSync(path.join(derivedRoot, "meta"))).toBe(false);
  });

  it("缓存命中不重写派生文件；源文件变化后重derive", async () => {
    const assetRoot = await makeTempDir();
    const derivedRoot = await makeTempDir();
    await writeSet(assetRoot, "cache", { base: variantImage(1, [255, 0, 0]) });
    const catalog = makeCatalog({
      cache: {
        id: "cache",
        presentation: { normalize: true },
        variants: { base: { id: "base", src: "characters/cache/base.png" } },
      },
    });
    const options = { assetRoot, derivedRoot, urlPrefix: URL_PREFIX };
    await normalizeSprites(catalog, options);
    const derivedFile = path.join(derivedRoot, "cache", "base.png");
    const first = await readFile(derivedFile);

    await normalizeSprites(catalog, options);
    expect(await readFile(derivedFile)).toEqual(first); // 命中缓存，内容一致

    // 源重绘（头移位变色）+ 显式推进 mtime → 失效重derive。
    await writeSet(assetRoot, "cache", { base: variantImage(7, [0, 255, 0]) });
    await utimes(path.join(assetRoot, "characters", "cache", "base.png"), 2000, 2000);
    const second = await normalizeSprites(catalog, options);
    // 单变体 union = 自身 bbox（头 x7..8 + 身体 x3..6 → 6×10）。
    expect(second.specs.cache).toEqual({ width: 6, height: 10 });
    const renewed = fromPngBuffer(await readFile(derivedFile));
    // union (0,0) 现在透明（红头没了）；绿头在 union (4,0)。
    expect(renewed.data[3]).toBe(0);
    expect(renewed.data[4 * 4 + 1]).toBe(255);
  });

  it("effectivePresentation：变体级浅合并覆写 set 级", () => {
    const set: SpriteSet = {
      id: "mix",
      presentation: { normalize: true, rotate: 90 },
      variants: {
        base: { id: "base", src: "characters/mix/base.png" },
        alt: {
          id: "alt",
          src: "characters/mix/alt.png",
          presentation: { rotate: 180 },
        },
      },
    };
    expect(effectivePresentation(set, "base")).toEqual({ normalize: true, rotate: 90 });
    expect(effectivePresentation(set, "alt")).toEqual({ normalize: true, rotate: 180 });
  });

  it("全透明变体抛出可定位的错误", async () => {
    const assetRoot = await makeTempDir();
    const derivedRoot = await makeTempDir();
    await writeSet(assetRoot, "ghost", {
      base: makeImage(4, 4, () => [0, 0, 0, 0]),
    });
    const catalog = makeCatalog({
      ghost: {
        id: "ghost",
        presentation: { normalize: true },
        variants: { base: { id: "base", src: "characters/ghost/base.png" } },
      },
    });
    await expect(
      normalizeSprites(catalog, { assetRoot, derivedRoot, urlPrefix: URL_PREFIX }),
    ).rejects.toThrow(/整图透明/);
  });

  it("损坏的 PNG 抛出带 set/variant 定位的错误", async () => {
    const assetRoot = await makeTempDir();
    const derivedRoot = await makeTempDir();
    const file = path.join(assetRoot, "characters", "broken", "base.png");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from("not-a-png"));
    const catalog = makeCatalog({
      broken: {
        id: "broken",
        presentation: { normalize: true },
        variants: { base: { id: "base", src: "characters/broken/base.png" } },
      },
    });
    await expect(
      normalizeSprites(catalog, { assetRoot, derivedRoot, urlPrefix: URL_PREFIX }),
    ).rejects.toThrow(/broken/);
  });
});
