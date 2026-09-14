/**
 * Tests for files.ts — 使用系统临时目录做真实读写往返。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultBasename,
  extForFormat,
  loadImageFile,
  saveImages,
  savePartialImages,
} from "./files.js";
import { ImageParamError } from "./validate.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "image-gen-test-"));
}

describe("files", () => {
  it("extForFormat：jpeg → jpg", () => {
    expect(extForFormat("png")).toBe("png");
    expect(extForFormat("jpeg")).toBe("jpg");
    expect(extForFormat("webp")).toBe("webp");
  });

  it("loadImageFile 按扩展名识别 MIME 并读出内容", async () => {
    const dir = await makeTempDir();
    try {
      const filePath = path.join(dir, "a.png");
      await writeFile(filePath, Buffer.from([1, 2, 3]));
      const image = await loadImageFile(filePath);
      expect(image.filename).toBe("a.png");
      expect(image.contentType).toBe("image/png");
      expect([...image.data]).toEqual([1, 2, 3]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadImageFile 拒绝不支持格式与缺失文件", async () => {
    const dir = await makeTempDir();
    try {
      await expect(loadImageFile(path.join(dir, "a.gif"))).rejects.toBeInstanceOf(ImageParamError);
      await expect(loadImageFile(path.join(dir, "missing.png"))).rejects.toBeInstanceOf(
        ImageParamError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saveImages 按 format 决定扩展名并写出 bytes", async () => {
    const dir = await makeTempDir();
    try {
      const paths = await saveImages(
        [
          { bytes: new Uint8Array([9, 9]), format: "jpeg" },
          { bytes: new Uint8Array([7]), format: "png" },
        ],
        dir,
        "base",
      );
      expect(paths).toEqual([path.join(dir, "base-01.jpg"), path.join(dir, "base-02.png")]);
      expect(await readFile(paths[0]!)).toEqual(Buffer.from([9, 9]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("savePartialImages 写出 partial 序号文件", async () => {
    const dir = await makeTempDir();
    try {
      const paths = await savePartialImages(
        [new Uint8Array([1]), new Uint8Array([2])],
        dir,
        "base",
      );
      expect(paths).toEqual([
        path.join(dir, "base-partial01.png"),
        path.join(dir, "base-partial02.png"),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defaultBasename 使用本地时间戳 + model + size", () => {
    const name = defaultBasename(
      "gpt-image-2",
      { width: 1024, height: 1536 },
      new Date(2026, 8, 14, 10, 30, 45),
    );
    expect(name).toBe("20260914-103045-gpt-image-2-1024x1536");
    expect(defaultBasename("gpt-image-2", "auto")).toMatch(/^\d{8}-\d{6}-gpt-image-2-auto$/);
  });
});
