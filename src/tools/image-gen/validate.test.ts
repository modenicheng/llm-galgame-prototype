/**
 * Tests for validate.ts — 参数归一化、默认回退与校验矩阵（纯函数，无网络无 IO）。
 */
import { describe, expect, it } from "vitest";
import {
  ImageParamError,
  isKnownModel,
  isValidSize,
  resolveEditParams,
  resolveGenerationParams,
  toGenerationRequestBody,
} from "./validate.js";
import type { ImageFileInput } from "./types.js";

function makeImage(name: string, contentType = "image/png"): ImageFileInput {
  return { filename: name, contentType, data: new Uint8Array([1, 2, 3]) };
}

/** 断言 fn 抛出 ImageParamError，且 message 依次包含给定片段。 */
function expectIssues(fn: () => unknown, ...substrings: string[]): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ImageParamError);
  const message = (error as Error).message;
  for (const substring of substrings) {
    expect(message).toContain(substring);
  }
}

describe("resolveGenerationParams — 默认回退", () => {
  it("未提供时应用全部内置默认值", () => {
    const resolved = resolveGenerationParams({ prompt: "一只猫" });
    expect(resolved).toMatchObject({
      prompt: "一只猫",
      model: "gpt-image-2",
      size: "auto",
      quality: "auto",
      n: 1,
      background: "auto",
      moderation: "auto",
      stream: false,
    });
    expect(resolved.outputFormat).toBeUndefined();
    expect(resolved.outputCompression).toBeUndefined();
    expect(resolved.partialImages).toBeUndefined();
    expect(resolved.user).toBeUndefined();
  });

  it("回退顺序：显式参数 > fallback 层 > 内置默认", () => {
    const resolved = resolveGenerationParams(
      { prompt: "x", size: "2048x1024" },
      { model: "gpt-image-2.5-flare", size: "1024x1536", quality: "high" },
    );
    expect(resolved.model).toBe("gpt-image-2.5-flare");
    expect(resolved.size).toEqual({ width: 2048, height: 1024 });
    expect(resolved.quality).toBe("high");
  });

  it("接受 snake_case 别名与字符串数字", () => {
    const resolved = resolveGenerationParams({
      prompt: "x",
      output_format: "webp",
      output_compression: "80",
      n: "3",
      stream: "true",
      partial_images: "2",
    });
    expect(resolved.outputFormat).toBe("webp");
    expect(resolved.outputCompression).toBe(80);
    expect(resolved.n).toBe(3);
    expect(resolved.stream).toBe(true);
    expect(resolved.partialImages).toBe(2);
  });

  it("显式 undefined 的键视同未提供", () => {
    const resolved = resolveGenerationParams({ prompt: "x", model: undefined });
    expect(resolved.model).toBe("gpt-image-2");
  });
});

describe("resolveGenerationParams — 未知 / 禁用参数", () => {
  it("拒绝未知参数", () => {
    expectIssues(
      () => resolveGenerationParams({ prompt: "x", foo: 1 }),
      "未知参数",
      "foo",
    );
  });

  it("拒绝 response_format（gpt-image 固定返回 b64_json）", () => {
    expectIssues(
      () => resolveGenerationParams({ prompt: "x", response_format: "url" }),
      "response_format",
      "b64_json",
    );
  });

  it("拒绝 style（dall-e-3 专属）", () => {
    expectIssues(() => resolveGenerationParams({ prompt: "x", style: "vivid" }), "dall-e-3");
  });

  it("同名参数两种写法同时提供视为冲突", () => {
    expectIssues(
      () => resolveGenerationParams({ prompt: "x", outputFormat: "png", output_format: "webp" }),
      "重复提供",
    );
  });
});

describe("resolveGenerationParams — prompt / model / quality / n", () => {
  it("prompt 必填、非空白、受 32000 上限", () => {
    expectIssues(() => resolveGenerationParams({}), "prompt", "必填");
    expectIssues(() => resolveGenerationParams({ prompt: "   " }), "prompt", "空白");
    expectIssues(
      () => resolveGenerationParams({ prompt: "a".repeat(32_001) }),
      "32000",
    );
  });

  it("model 严格枚举", () => {
    expectIssues(
      () => resolveGenerationParams({ prompt: "x", model: "gpt-image-9" }),
      "gpt-image-9",
      "gpt-image-2",
    );
    expect(resolveGenerationParams({ prompt: "x", model: "gpt-image-2.5-sunburst-2026-09-08" }).model).toBe(
      "gpt-image-2.5-sunburst-2026-09-08",
    );
  });

  it("xhigh/max 仅 2.5 系列", () => {
    expectIssues(
      () => resolveGenerationParams({ prompt: "x", quality: "xhigh" }),
      "xhigh",
      "gpt-image-2.5",
    );
    const ok = resolveGenerationParams({
      prompt: "x",
      model: "gpt-image-2.5-flare",
      quality: "max",
    });
    expect(ok.quality).toBe("max");
    expectIssues(
      () => resolveGenerationParams({ prompt: "x", quality: "hd" }),
      "quality",
    );
  });

  it("n 为 1~10 整数", () => {
    expectIssues(() => resolveGenerationParams({ prompt: "x", n: 0 }), "n", "1~10");
    expectIssues(() => resolveGenerationParams({ prompt: "x", n: 11 }), "n");
    expectIssues(() => resolveGenerationParams({ prompt: "x", n: 2.5 }), "n");
    expect(resolveGenerationParams({ prompt: "x", n: "10" }).n).toBe(10);
  });
});

describe("resolveGenerationParams — size 规则", () => {
  it("接受 auto、标准档与合法任意尺寸", () => {
    expect(resolveGenerationParams({ prompt: "x", size: "auto" }).size).toBe("auto");
    expect(resolveGenerationParams({ prompt: "x", size: "1024x1536" }).size).toEqual({
      width: 1024,
      height: 1536,
    });
    expect(resolveGenerationParams({ prompt: "x", size: "3840x2160" }).size).toEqual({
      width: 3840,
      height: 2160,
    });
  });

  it("拒绝非 16 倍数、过小、超上限与非法宽高比", () => {
    expectIssues(() => resolveGenerationParams({ prompt: "x", size: "1000x1000" }), "16");
    expectIssues(() => resolveGenerationParams({ prompt: "x", size: "240x256" }), "256");
    expectIssues(() => resolveGenerationParams({ prompt: "x", size: "4096x2304" }), "3840x2160");
    expectIssues(() => resolveGenerationParams({ prompt: "x", size: "4096x384" }), "宽高比");
    expectIssues(() => resolveGenerationParams({ prompt: "x", size: "big" }), "size");
    expectIssues(() => resolveGenerationParams({ prompt: "x", size: "1024" }), "size");
  });
});

describe("resolveGenerationParams — 跨字段规则", () => {
  it("transparent 不支持 jpeg 输出", () => {
    expectIssues(
      () => resolveGenerationParams({ prompt: "x", background: "transparent", outputFormat: "jpeg" }),
      "transparent",
      "jpeg",
    );
    expect(
      resolveGenerationParams({ prompt: "x", background: "transparent", outputFormat: "webp" })
        .outputFormat,
    ).toBe("webp");
  });

  it("outputCompression 仅 jpeg/webp 有效", () => {
    expectIssues(
      () => resolveGenerationParams({ prompt: "x", outputFormat: "png", outputCompression: 80 }),
      "outputCompression",
      "jpeg/webp",
    );
    expectIssues(
      () => resolveGenerationParams({ prompt: "x", outputCompression: 80 }),
      "outputCompression",
      "png",
    );
    const ok = resolveGenerationParams({ prompt: "x", outputFormat: "jpeg", outputCompression: "0" });
    expect(ok.outputCompression).toBe(0);
    expectIssues(
      () => resolveGenerationParams({ prompt: "x", outputCompression: 101 }),
      "0~100",
    );
  });

  it("partialImages 必须配合 stream", () => {
    expectIssues(
      () => resolveGenerationParams({ prompt: "x", partialImages: 2 }),
      "partialImages",
      "stream",
    );
    const ok = resolveGenerationParams({ prompt: "x", stream: true, partialImages: 3 });
    expect(ok.partialImages).toBe(3);
  });

  it("一次报告全部问题而非首个", () => {
    expectIssues(
      () => resolveGenerationParams({ prompt: "", n: 99, model: "nope" }),
      "prompt",
      "n",
      "model",
    );
  });
});

describe("resolveEditParams", () => {
  it("images 必填且 1~16 张，校验图片对象结构", () => {
    expectIssues(() => resolveEditParams({ prompt: "x" }), "images", "必填");
    expectIssues(() => resolveEditParams({ prompt: "x", images: "a.png" }), "images");
    const tooMany = Array.from({ length: 17 }, () => makeImage("a.png"));
    expectIssues(() => resolveEditParams({ prompt: "x", images: tooMany }), "1~16");
    expectIssues(
      () => resolveEditParams({ prompt: "x", images: [{ filename: "a.png" }] }),
      "images[0]",
    );
    const resolved = resolveEditParams({ prompt: "x", images: [makeImage("a.png")] });
    expect(resolved.images).toHaveLength(1);
  });

  it("接受 mask 与 inputFidelity", () => {
    const resolved = resolveEditParams({
      prompt: "x",
      images: [makeImage("a.png")],
      mask: makeImage("mask.png"),
      input_fidelity: "high",
    });
    expect(resolved.mask?.filename).toBe("mask.png");
    expect(resolved.inputFidelity).toBe("high");
    expectIssues(
      () =>
        resolveEditParams({
          prompt: "x",
          images: [makeImage("a.png")],
          inputFidelity: "medium",
        }),
      "inputFidelity",
    );
  });

  it("同样继承文生图参数校验（含禁用参数）", () => {
    expectIssues(
      () => resolveEditParams({ prompt: "x", images: [makeImage("a.png")], responseFormat: "url" }),
      "response_format",
    );
    expectIssues(
      () => resolveEditParams({ prompt: "x", images: [makeImage("a.png")], size: "1000x1000" }),
      "16",
    );
  });
});

describe("辅助预检与请求体映射", () => {
  it("isKnownModel / isValidSize", () => {
    expect(isKnownModel("gpt-image-2")).toBe(true);
    expect(isKnownModel("dall-e-3")).toBe(false);
    expect(isValidSize("1024x1536")).toBe(true);
    expect(isValidSize("1000x1000")).toBe(false);
  });

  it("toGenerationRequestBody 输出 snake_case 且缺省键不发送", () => {
    const body = toGenerationRequestBody(
      resolveGenerationParams({ prompt: "x", outputFormat: "webp", user: "u1", stream: false }),
    );
    expect(body).toEqual({
      model: "gpt-image-2",
      prompt: "x",
      n: 1,
      background: "auto",
      moderation: "auto",
      stream: false,
      size: "auto",
      quality: "auto",
      output_format: "webp",
      user: "u1",
    });
    expect(body).not.toHaveProperty("partial_images");
    expect(body).not.toHaveProperty("output_compression");

    const streaming = toGenerationRequestBody(
      resolveGenerationParams({ prompt: "x", stream: true, partialImages: 2, outputCompression: 90, outputFormat: "jpeg" }),
    );
    expect(streaming.partial_images).toBe(2);
    expect(streaming.output_compression).toBe(90);
    expect(streaming.size).toBe("auto");
  });
});
