/**
 * Tests for env.ts — 传入自定义 env 记录，不读取真实 .env。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_OUTPUT_DIR, loadEnvConfig } from "./env.js";
import { ImageParamError } from "./validate.js";

function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    IMAGE_GEN_BASE_URL: "https://relay.test/v1",
    IMAGE_GEN_API_KEY: "sk-test",
    ...overrides,
  };
}

describe("loadEnvConfig", () => {
  it("读取必填项；可选默认层只收集已配置的键", () => {
    const config = loadEnvConfig(envWith({}));
    expect(config.baseUrl).toBe("https://relay.test/v1");
    expect(config.apiKey).toBe("sk-test");
    expect(config.fallbacks).toEqual({});
    expect(config.outputDir).toBe(DEFAULT_OUTPUT_DIR);
    expect(config.timeoutMs).toBeUndefined();
  });

  it("可选默认值进入 fallback 层", () => {
    const config = loadEnvConfig(
      envWith({
        IMAGE_GEN_MODEL: "gpt-image-2.5-flare",
        IMAGE_GEN_SIZE: "1024x1536",
        IMAGE_GEN_QUALITY: "high",
        IMAGE_GEN_TIMEOUT_MS: "60000",
        IMAGE_GEN_MAX_RETRIES: "0",
        IMAGE_GEN_OUTPUT_DIR: "custom-out",
      }),
    );
    expect(config.fallbacks).toEqual({
      model: "gpt-image-2.5-flare",
      size: "1024x1536",
      quality: "high",
    });
    expect(config.timeoutMs).toBe(60000);
    expect(config.maxRetries).toBe(0);
    expect(config.outputDir).toBe("custom-out");
  });

  it("空字符串可选项视同未配置", () => {
    const config = loadEnvConfig(
      envWith({ IMAGE_GEN_MODEL: "", IMAGE_GEN_SIZE: "  ", IMAGE_GEN_QUALITY: "" }),
    );
    expect(config.fallbacks).toEqual({});
  });

  it("必填缺失一次报全", () => {
    try {
      loadEnvConfig({});
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ImageParamError);
      expect((error as Error).message).toContain("IMAGE_GEN_BASE_URL");
      expect((error as Error).message).toContain("IMAGE_GEN_API_KEY");
    }
  });

  it("可选项非法时报字段名", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ IMAGE_GEN_MODEL: "dall-e-3" }, "IMAGE_GEN_MODEL"],
      [{ IMAGE_GEN_SIZE: "1000x1000" }, "IMAGE_GEN_SIZE"],
      [{ IMAGE_GEN_QUALITY: "ultra" }, "IMAGE_GEN_QUALITY"],
      [{ IMAGE_GEN_TIMEOUT_MS: "-5" }, "IMAGE_GEN_TIMEOUT_MS"],
      [{ IMAGE_GEN_MAX_RETRIES: "x" }, "IMAGE_GEN_MAX_RETRIES"],
    ];
    for (const [overrides, key] of cases) {
      try {
        loadEnvConfig(envWith(overrides));
        expect.unreachable(`${key} should throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(ImageParamError);
        expect((error as Error).message).toContain(key);
      }
    }
  });
});
