import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import { RecapSummarizerAdapter } from "./recap-summarizer-adapter.js";
import type { StoredEvent } from "../../schema.js";
import type {
  ContextLlmRecorder,
  ContextLlmRecorderRequest,
} from "../../core/ports/context-llm-recorder-port.js";

function makeFakeRecorder() {
  return {
    recordContextRequest: vi.fn(
      (_request: unknown, call: () => Promise<unknown>) => call(),
    ),
  };
}

function makeApiConfig(): AppConfig["api"] {
  return {
    model: "test-model",
    base_url: "https://test.example/v1",
    api_key_env: "TEST_KEY",
    timeout_ms: 30000,
    token_limit_field: "max_completion_tokens",
  };
}

function makeFakeClient(content: string): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

function ev(seq: number, partial: Record<string, unknown>): StoredEvent {
  return {
    seq,
    turn: 1,
    timestamp: "2026-09-19T00:00:00.000Z",
    source: "model",
    ...partial,
  } as unknown as StoredEvent;
}

const DIGEST = "树莓娘和许晚晴在北食堂三楼拼桌；约定周六带检修工具；韩澈把错的型号记在了便签上。";

describe("RecapSummarizerAdapter.summarize", () => {
  it("passes events through and returns the cleaned digest", async () => {
    const client = makeFakeClient('```\n' + DIGEST + '\n```');
    const adapter = new RecapSummarizerAdapter({ apiKey: "k", api: makeApiConfig(), client });

    const digest = await adapter.summarize([
      ev(1, { type: "dialogue", speaker: "树莓娘", text: "周六见。" }),
    ]);

    expect(digest).toBe(DIGEST);
    const body = vi.mocked(client.chat.completions.create).mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    const userMessage = (body.messages as Array<{ content: string }>)[1]?.content ?? "";
    expect(userMessage).toContain("周六见");
    expect(userMessage).not.toContain("已有框架内容");
  });

  it("includes the framework digest for dedup when provided", async () => {
    const client = makeFakeClient(DIGEST);
    const adapter = new RecapSummarizerAdapter({ apiKey: "k", api: makeApiConfig(), client });

    await adapter.summarize(
      [ev(1, { type: "narration", text: "两人在食堂。" })],
      { frameworkDigest: "[Canon] 约定=周六检修\n[Recap] 既有梗概。" },
    );

    const body = vi.mocked(client.chat.completions.create).mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    const userMessage = (body.messages as Array<{ content: string }>)[1]?.content ?? "";
    expect(userMessage).toContain("【已有框架内容");
    expect(userMessage).toContain("[Canon] 约定=周六检修");
    expect(userMessage.indexOf("【已有框架内容")).toBeLessThan(userMessage.indexOf("【剧情片段】"));
  });

  it("truncates runaway digests at the cap", async () => {
    const long = "很长的记录".repeat(200);
    const adapter = new RecapSummarizerAdapter({
      apiKey: "k",
      api: makeApiConfig(),
      client: makeFakeClient(long),
    });

    const digest = await adapter.summarize([
      ev(1, { type: "narration", text: "旁白。" }),
    ]);
    expect(digest !== null && digest.length <= 501).toBe(true);
    expect(digest?.endsWith("…")).toBe(true);
  });

  it("returns null for empty input without calling the LLM", async () => {
    const client = makeFakeClient(DIGEST);
    const adapter = new RecapSummarizerAdapter({ apiKey: "k", api: makeApiConfig(), client });

    expect(await adapter.summarize([])).toBeNull();
    expect(vi.mocked(client.chat.completions.create).mock.calls.length).toBe(0);
  });

  it("hands the exact request body to the context recorder (success and failure)", async () => {
    // 成功：recorder 收到的 body 与 create() 收到的完全一致（记录即发送）。
    const client = makeFakeClient(DIGEST);
    const recorder = makeFakeRecorder();
    const adapter = new RecapSummarizerAdapter({
      apiKey: "k",
      api: makeApiConfig(),
      client,
      contextRecorder: recorder as unknown as ContextLlmRecorder,
    });

    await adapter.summarize(
      [ev(1, { type: "narration", text: "两人在食堂。" })],
      { frameworkDigest: "框架" },
    );

    expect(recorder.recordContextRequest).toHaveBeenCalledTimes(1);
    const request = vi.mocked(recorder.recordContextRequest).mock.calls[0]![0] as unknown as ContextLlmRecorderRequest;
    expect(request.taskType).toBe("recap_summarization");
    expect(request.meta).toEqual({ events: 1, framework_digest: true });
    const sentBody = vi.mocked(client.chat.completions.create).mock.calls[0]![0] as unknown;
    expect(request.body).toEqual(sentBody);

    // 失败：recorder 仍被调用（失败请求同样要可审计），适配器语义不变。
    const failing = makeFakeClient("");
    vi.mocked(failing.chat.completions.create).mockRejectedValue(new Error("timeout"));
    const failingRecorder = makeFakeRecorder();
    const failingAdapter = new RecapSummarizerAdapter({
      apiKey: "k",
      api: makeApiConfig(),
      client: failing,
      contextRecorder: failingRecorder as unknown as ContextLlmRecorder,
    });

    expect(
      await failingAdapter.summarize([ev(1, { type: "narration", text: "旁白。" })]),
    ).toBeNull();
    expect(failingRecorder.recordContextRequest).toHaveBeenCalledTimes(1);
  });
});
