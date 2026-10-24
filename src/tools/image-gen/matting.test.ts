/**
 * Tests for matting.ts — 纯函数（归一化 / 双线性缩放）公式验证；
 * 模型推理不在此测试（由 cutout.test.ts 的注入实现覆盖）。
 */
import { describe, expect, it } from "vitest";
import { bilinearResize, toModelInput } from "./matting.js";

describe("toModelInput", () => {
  it("按 (p-128)/256 归一化，且 RGB 通道分离到三个平面", () => {
    const size = 1024 * 1024;
    const rgba = new Uint8Array(size * 4);
    for (let i = 0; i < size; i++) {
      rgba[i * 4] = 128; // R → 0
      rgba[i * 4 + 1] = 0; // G → -0.5
      rgba[i * 4 + 2] = 255; // B → 127/256
      rgba[i * 4 + 3] = 255; // alpha 不参与
    }
    const input = toModelInput(rgba);
    const stride = 1024 * 1024;
    expect(input.length).toBe(3 * stride);
    expect(input[0]).toBe(0);
    expect(input[stride]).toBe(-0.5);
    expect(input[2 * stride]).toBeCloseTo(127 / 256, 6);
  });
});

describe("bilinearResize", () => {
  it("同尺寸缩放为恒等变换", () => {
    const data = new Uint8Array([1, 2, 3, 4]); // 2x2 单通道
    expect(bilinearResize(data, 2, 2, 1, 2, 2)).toEqual(data);
  });

  it("2x2 同色 → 1x1 仍为该色", () => {
    const data = new Uint8Array([77, 77, 77, 255, 77, 77, 77, 255, 77, 77, 77, 255, 77, 77, 77, 255]);
    expect(bilinearResize(data, 2, 2, 4, 1, 1)).toEqual(new Uint8Array([77, 77, 77, 255]));
  });

  it("1x2 → 1x1 落在左像素（fx=0 处 dx=0）", () => {
    const data = new Uint8Array([0, 10]);
    expect(bilinearResize(data, 2, 1, 1, 1, 1)).toEqual(new Uint8Array([0]));
  });

  it("1x3 → 1x1 落在左像素（fx=0）", () => {
    const data = new Uint8Array([5, 50, 250]);
    expect(bilinearResize(data, 3, 1, 1, 1, 1)).toEqual(new Uint8Array([5]));
  });
});
