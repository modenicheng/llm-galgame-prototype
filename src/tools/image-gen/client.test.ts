/**
 * Tests for client.ts — fetch / sleep 全部注入，无网络。
 * 覆盖：请求体组装、b64 解码、错误映射、重试、multipart、SSE 流。
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createImageClient, ImageApiError, normalizeBaseUrl } from "./client.js";
import { ImageParamError } from "./validate.js";
import type { ImageFileInput, ImageStreamEvent } from "./types.js";

const B64_HELLO = Buffer.from("hello", "utf8").toString("base64");

function makeImage(name = "a.png", contentType = "image/png"): ImageFileInput {
  return { filename: name, contentType, data: new Uint8Array([1, 2, 3]) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

type FetchCall = { url: string; init: RequestInit };

function recorder(responses: Array<Response | ((call: FetchCall) => Response)>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit = {}): Promise<Response> => {
    const call = { url: String(url), init };
    calls.push(call);
    const response = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return typeof response === "function" ? response(call) : response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(
  fetchImpl: typeof fetch,
  overrides: { maxRetries?: number; baseUrl?: string; apiKey?: string } = {},
) {
  return createImageClient({
    apiKey: overrides.apiKey ?? "test-key",
    baseUrl: overrides.baseUrl ?? "https://relay.test/v1",
    maxRetries: overrides.maxRetries ?? 0,
    fetchImpl,
    sleepImpl: async () => {},
  });
}

describe("normalizeBaseUrl", () => {
  it("去尾斜杠；裸域名补 /v1；非法值报错", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("https://relay.test")).toBe("https://relay.test/v1");
    expect(normalizeBaseUrl("  https://relay.test:8080/api  ")).toBe("https://relay.test:8080/api");
    expect(() => normalizeBaseUrl("")).toThrow(ImageApiError);
    expect(() => normalizeBaseUrl("ftp://x")).toThrow(/http/);
    expect(() => normalizeBaseUrl("not a url")).toThrow(/URL/);
  });
});

describe("generate — 请求体与响应解析", () => {
  it("POST {base}/images/generations，默认参数 + snake_case，Authorization 注入", async () => {
    const { fetchImpl, calls } = recorder([
      jsonResponse({
        created: 1,
        data: [{ b64_json: B64_HELLO, revised_prompt: "更好的提示词" }],
        usage: { input_tokens: 10, output_tokens: 50, total_tokens: 60 },
      }),
    ]);
    const client = makeClient(fetchImpl);
    const result = await client.generate({ prompt: "一只猫" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://relay.test/v1/images/generations");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "gpt-image-2",
      prompt: "一只猫",
      n: 1,
      background: "auto",
      moderation: "auto",
      stream: false,
      size: "auto",
      quality: "auto",
    });

    expect(result.images).toHaveLength(1);
    expect(Buffer.from(result.images[0]!.bytes).toString("utf8")).toBe("hello");
    expect(result.images[0]!.format).toBe("png");
    expect(result.images[0]!.revisedPrompt).toBe("更好的提示词");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 50, totalTokens: 60 });
    expect(result.model).toBe("gpt-image-2");
    expect(result.size).toBe("auto");
  });

  it("非法参数在本地拦截，不发出请求", async () => {
    const { fetchImpl, calls } = recorder([jsonResponse({ data: [] })]);
    const client = makeClient(fetchImpl);
    await expect(client.generate({ prompt: "x", quality: "xhigh" })).rejects.toBeInstanceOf(
      ImageParamError,
    );
    await expect(client.generate({ prompt: "x", response_format: "url" })).rejects.toThrow(
      /response_format/,
    );
    expect(calls).toHaveLength(0);
  });

  it("响应缺少 b64_json 时给出中转提示", async () => {
    const { fetchImpl } = recorder([jsonResponse({ data: [{ url: "https://x/img.png" }] })]);
    const client = makeClient(fetchImpl);
    await expect(client.generate({ prompt: "x" })).rejects.toThrow(/b64_json/);
  });

  it("响应结构异常时报字段信息", async () => {
    const { fetchImpl } = recorder([jsonResponse({ data: [] })]);
    const client = makeClient(fetchImpl);
    await expect(client.generate({ prompt: "x" })).rejects.toThrow(/Images API/);
  });
});

describe("错误映射与重试", () => {
  it("非 2xx 解析服务端 error.message / type 与 x-request-id", async () => {
    const { fetchImpl } = recorder([
      jsonResponse({ error: { message: "账单额度不足", type: "insufficient_quota" } }, 429),
    ]);
    const client = makeClient(fetchImpl);
    const error = await client.generate({ prompt: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageApiError);
    expect((error as ImageApiError).status).toBe(429);
    expect((error as ImageApiError).code).toBe("insufficient_quota");
    expect((error as ImageApiError).message).toContain("账单额度不足");
  });

  it("429 重试后成功（退避 sleep 被调用）", async () => {
    const { fetchImpl, calls } = recorder([
      jsonResponse({ error: { message: "rate limited" } }, 429),
      jsonResponse({ data: [{ b64_json: B64_HELLO }] }),
    ]);
    const sleeps: number[] = [];
    const client = createImageClient({
      apiKey: "k",
      baseUrl: "https://relay.test/v1",
      maxRetries: 2,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await client.generate({ prompt: "x" });
    expect(calls).toHaveLength(2);
    expect(result.images[0]!.bytes.length).toBeGreaterThan(0);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it("重试耗尽后抛出最后一次的错误", async () => {
    const { fetchImpl, calls } = recorder([jsonResponse({ error: { message: "boom" } }, 500)]);
    const client = makeClient(fetchImpl, { maxRetries: 2 });
    const error = await client.generate({ prompt: "x" }).catch((e: unknown) => e);
    expect((error as ImageApiError).status).toBe(500);
    expect(calls).toHaveLength(3);
  });

  it("4xx 业务错误不重试", async () => {
    const { fetchImpl, calls } = recorder([
      jsonResponse({ error: { message: "bad request" } }, 400),
    ]);
    const client = makeClient(fetchImpl, { maxRetries: 3 });
    const error = await client.generate({ prompt: "x" }).catch((e: unknown) => e);
    expect((error as ImageApiError).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("网络失败 → status=0 的 ImageApiError", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl, { maxRetries: 1 });
    const error = await client.generate({ prompt: "x" }).catch((e: unknown) => e);
    expect((error as ImageApiError).status).toBe(0);
    expect((error as ImageApiError).message).toContain("ECONNREFUSED");
  });

  it("apiKey 缺失时构造即报错", () => {
    expect(() => createImageClient({ apiKey: " " })).toThrow(/apiKey/);
  });
});

describe("edit — multipart 请求体", () => {
  it("image[] / mask / input_fidelity / 尺寸字段齐全；不发送未提供的键", async () => {
    const { fetchImpl, calls } = recorder([jsonResponse({ data: [{ b64_json: B64_HELLO }] })]);
    const client = makeClient(fetchImpl);
    await client.edit({
      prompt: "把背景换成黄昏",
      images: [makeImage("a.png"), makeImage("b.webp", "image/webp")],
      mask: makeImage("mask.png"),
      inputFidelity: "high",
      size: "1024x1024",
      quality: "high",
    });

    const form = calls[0]!.init.body as FormData;
    expect(calls[0]!.url).toBe("https://relay.test/v1/images/edits");
    expect(calls[0]!.init.headers).not.toHaveProperty("Content-Type"); // 由 fetch 自动补 boundary
    const images = form.getAll("image[]") as Array<{ name: string; type: string; size: number }>;
    expect(images).toHaveLength(2);
    expect(images[0]!.name).toBe("a.png");
    expect(images[0]!.type).toBe("image/png");
    expect(images[1]!.type).toBe("image/webp");
    const mask = form.get("mask") as { name: string };
    expect(mask.name).toBe("mask.png");
    expect(form.get("input_fidelity")).toBe("high");
    expect(form.get("prompt")).toBe("把背景换成黄昏");
    expect(form.get("size")).toBe("1024x1024");
    expect(form.get("quality")).toBe("high");
    expect(form.has("output_format")).toBe(false);
    expect(form.has("partial_images")).toBe(false);
  });

  it("images 非法（如 17 张）在本地拦截", async () => {
    const { fetchImpl, calls } = recorder([jsonResponse({ data: [] })]);
    const client = makeClient(fetchImpl);
    const tooMany = Array.from({ length: 17 }, () => makeImage());
    await expect(client.edit({ prompt: "x", images: tooMany })).rejects.toThrow(/1~16/);
    expect(calls).toHaveLength(0);
  });
});

describe("SSE 流式", () => {
  const partialAndDone = [
    'data: {"type":"image_generation.partial_image","b64_json":"AAEC","partial_image_index":0}\n\n',
    'data: {"type":"image_generation.partial_image","b64_json":"AAECAw","partial_image_index":1}\n\n',
    `data: {"type":"image_generation.completed","b64_json":"${B64_HELLO}","usage":{"input_tokens":10,"output_tokens":50,"total_tokens":60}}\n\n`,
  ];

  it("generateStream 逐个抛出 partial，completed 收敛为结果", async () => {
    const { fetchImpl, calls } = recorder([sseResponse(partialAndDone)]);
    const client = makeClient(fetchImpl);
    const events: ImageStreamEvent[] = [];
    for await (const event of client.generateStream({ prompt: "x", partialImages: 2 })) {
      events.push(event);
    }
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "partial", index: 0 });
    expect((events[0] as { bytes: Uint8Array }).bytes.length).toBe(3);
    const completed = events[2] as { type: string; result: { usage?: { totalTokens?: number } } };
    expect(completed.type).toBe("completed");
    expect(completed.result.usage?.totalTokens).toBe(60);
    // stream 相关字段确实发给了服务端
    const body = JSON.parse(String(calls[0]!.init.body)) as { stream: boolean; partial_images: number };
    expect(body.stream).toBe(true);
    expect(body.partial_images).toBe(2);
  });

  it("generate({stream:true}) 内部消费 SSE，只返回最终结果", async () => {
    const { fetchImpl } = recorder([sseResponse(partialAndDone)]);
    const client = makeClient(fetchImpl);
    const result = await client.generate({ prompt: "x", stream: true, partialImages: 2 });
    expect(result.images).toHaveLength(1);
    expect(Buffer.from(result.images[0]!.bytes).toString("utf8")).toBe("hello");
  });

  it("SSE error 事件 → ImageApiError", async () => {
    const { fetchImpl } = recorder([
      sseResponse([
        'data: {"type":"error","code":"content_policy_violation","message":"请求被拒绝"}\n\n',
      ]),
    ]);
    const client = makeClient(fetchImpl);
    const error = await client.generateStream({ prompt: "x" }).next().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ImageApiError);
    expect((error as ImageApiError).message).toContain("请求被拒绝");
    expect((error as ImageApiError).code).toBe("content_policy_violation");
  });

  it("流在 completed 前结束 → 报错", async () => {
    const { fetchImpl } = recorder([
      sseResponse(['data: {"type":"image_generation.partial_image","b64_json":"AAEC"}\n\n']),
    ]);
    const client = makeClient(fetchImpl);
    await expect(async () => {
      for await (const _event of client.generateStream({ prompt: "x" })) {
        // 消费直到流结束
      }
    }).rejects.toThrow(/completed/);
  });

  it("SSE 事件非 JSON → sse 报错", async () => {
    const { fetchImpl } = recorder([sseResponse(["data: not-json\n\n"])]);
    const client = makeClient(fetchImpl);
    await expect(async () => {
      for await (const _event of client.generateStream({ prompt: "x" })) {
        // 消费直到报错
      }
    }).rejects.toThrow(/SSE/);
  });
});
