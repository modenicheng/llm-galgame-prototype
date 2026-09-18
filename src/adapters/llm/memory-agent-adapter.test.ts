import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { createInitialState } from "../../story/state.js";
import { MemoryAgentAdapter, extractJson, rawOutputExcerpt } from "./memory-agent-adapter.js";
import type { StoredEvent } from "../../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeFakeDiagnostics(): DiagnosticSink {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
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

const VALID_PROPOSAL_JSON = JSON.stringify({
  characters: { raspberry: { emotion: "开心", current_goal: "整理线索" } },
  canon: { 约定: "周六一起查设备" },
  open_threads: [{ id: "terminal_origin", summary: "值班记录里的异常行", status: "active" }],
});

// ---------------------------------------------------------------------------
// extractJson — 解析加固
// ---------------------------------------------------------------------------

describe("extractJson", () => {
  it("parses a plain JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON wrapped in code fences and prose", () => {
    expect(extractJson('好的，结果如下：\n```json\n{"a":1}\n```\n以上。')).toEqual({ a: 1 });
  });

  it("ignores pseudo-JSON inside a closed <think> block", () => {
    const raw =
      '<think>先想想要提取什么，比如 {"emotion": "这一段要不要写呢"} 这样。</think>\n' +
      VALID_PROPOSAL_JSON;
    expect(extractJson(raw)).toEqual(JSON.parse(VALID_PROPOSAL_JSON));
  });

  it("prefers the last balanced object when prose contains braces", () => {
    const raw = '候选 {"wrong": true}，最终答案：{"right": 1}。';
    expect(extractJson(raw)).toEqual({ right: 1 });
  });

  it("tolerates trailing commas as a fallback", () => {
    expect(extractJson('{"characters": {"raspberry": {"emotion": "开心",}},}')).toEqual({
      characters: { raspberry: { emotion: "开心" } },
    });
  });

  it("keeps braces inside string values balanced", () => {
    expect(extractJson('{"canon": {"备注": "格式 {a} 示例 \\" 引号"}}')).toEqual({
      canon: { 备注: '格式 {a} 示例 " 引号' },
    });
  });

  it("returns undefined for non-JSON output", () => {
    expect(extractJson("抱歉，我无法按要求输出。")).toBeUndefined();
    expect(extractJson('{"truncated')).toBeUndefined();
  });
});

describe("rawOutputExcerpt", () => {
  it("flattens whitespace and truncates with an ellipsis", () => {
    expect(rawOutputExcerpt("a\n b")).toBe("a b");
    expect(rawOutputExcerpt("x".repeat(300)).length).toBe(201);
    expect(rawOutputExcerpt("x".repeat(300)).endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MemoryAgentAdapter.derive
// ---------------------------------------------------------------------------

describe("MemoryAgentAdapter.derive", () => {
  it("extracts a valid proposal from clean JSON", async () => {
    const client = makeFakeClient(VALID_PROPOSAL_JSON);
    const adapter = new MemoryAgentAdapter({
      apiKey: "k",
      api: makeApiConfig(),
      client,
    });

    const proposal = await adapter.derive(
      [ev(1, { type: "dialogue", speaker: "树莓娘", text: "那就周六一起查。" })],
      createInitialState(),
    );

    expect(proposal).not.toBeNull();
    expect(proposal?.characters?.raspberry?.emotion).toBe("开心");
    expect(proposal?.canon?.["约定"]).toBe("周六一起查设备");
    expect(proposal?.open_threads?.[0]?.id).toBe("terminal_origin");
  });

  it("recovers when reasoning noise precedes the answer", async () => {
    const raw = `<think>状态提取要点 {"emotion": "要不要枚举呢"} ……</think>\n${VALID_PROPOSAL_JSON}`;
    const adapter = new MemoryAgentAdapter({
      apiKey: "k",
      api: makeApiConfig(),
      client: makeFakeClient(raw),
    });

    const proposal = await adapter.derive(
      [ev(1, { type: "narration", text: "两人约好周末。" })],
      createInitialState(),
    );

    expect(proposal?.characters?.raspberry?.emotion).toBe("开心");
  });

  it("logs a raw-output excerpt when parsing fails", async () => {
    const diagnostics = makeFakeDiagnostics();
    const raw = "  这一段我需要更多上下文才能判断，请补充剧情。  ";
    const adapter = new MemoryAgentAdapter({
      apiKey: "k",
      api: makeApiConfig(),
      client: makeFakeClient(raw),
      diagnostics,
    });

    const proposal = await adapter.derive(
      [ev(1, { type: "narration", text: "旁白。" })],
      createInitialState(),
    );

    expect(proposal).toBeNull();
    expect(diagnostics.warn).toHaveBeenCalledTimes(1);
    const message = vi.mocked(diagnostics.warn).mock.calls[0]?.[1] ?? "";
    expect(message).toContain("无法解析为有效提案");
    expect(message).toContain("test-model");
    expect(message).toContain("这一段我需要更多上下文");
  });

  it("returns null without calling the LLM for empty batches", async () => {
    const client = makeFakeClient(VALID_PROPOSAL_JSON);
    const adapter = new MemoryAgentAdapter({ apiKey: "k", api: makeApiConfig(), client });

    expect(await adapter.derive([], createInitialState())).toBeNull();
    expect(vi.mocked(client.chat.completions.create).mock.calls.length).toBe(0);
  });

  it("forwards thinking and token budget options into the request body", async () => {
    const client = makeFakeClient(VALID_PROPOSAL_JSON);
    const adapter = new MemoryAgentAdapter({
      apiKey: "k",
      api: makeApiConfig(),
      client,
      thinking: { type: "enabled", effort: "max" },
      maxTokens: 4000,
    });

    await adapter.derive(
      [ev(1, { type: "narration", text: "旁白。" })],
      createInitialState(),
    );

    const body = vi.mocked(client.chat.completions.create).mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("max");
    expect(body.max_completion_tokens).toBe(4000);
  });

  it("defaults to thinking disabled and the built-in token budget", async () => {
    const client = makeFakeClient(VALID_PROPOSAL_JSON);
    const adapter = new MemoryAgentAdapter({ apiKey: "k", api: makeApiConfig(), client });

    await adapter.derive(
      [ev(1, { type: "narration", text: "旁白。" })],
      createInitialState(),
    );

    const body = vi.mocked(client.chat.completions.create).mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_completion_tokens).toBe(1200);
  });
});
