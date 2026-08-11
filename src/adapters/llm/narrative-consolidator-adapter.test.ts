import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { StoredEvent } from "../../schema.js";
import type { PlotThread, SetupPayoff } from "../../core/narrative/memory-types.js";
import type { ConsolidationRequest } from "../../application/narrative/memory-consolidator.js";
import { NarrativeConsolidatorAdapter } from "./narrative-consolidator-adapter.js";

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

function makeFakeClient(opts?: {
  content?: string;
}): OpenAI {
  const content =
    opts?.content ??
    JSON.stringify({
      episode: {
        summary: "测试摘要",
        characters: ["char1"],
        locations: ["loc1"],
        threads: ["t1"],
        setups: ["s1"],
        importance: "normal",
      },
      threadOps: [],
      setupOps: [],
    });

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

function makeFakeEvents(): StoredEvent[] {
  return [
    {
      seq: 1,
      turn: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "model",
      type: "narration",
      text: "测试叙述文本。",
    } as StoredEvent,
  ];
}

function makeFakeThreads(): PlotThread[] {
  return [
    {
      id: "t1",
      kind: "main",
      summary: "主线剧情A",
      status: "open",
      importance: "major",
      introducedAtCheckpoint: 0,
      lastTouchedAtCheckpoint: 0,
      source: "author",
    },
    {
      id: "t2",
      kind: "mystery",
      summary: "谜团线索B",
      status: "developing",
      importance: "minor",
      introducedAtCheckpoint: 1,
      lastTouchedAtCheckpoint: 1,
      source: "author",
    },
  ];
}

function makeFakeSetups(): SetupPayoff[] {
  return [
    {
      id: "s1",
      kind: "foreshadow",
      setup: "窗外黑影闪过",
      status: "seeded",
      reinforcementCount: 0,
      prerequisites: [],
      source: "author",
    },
  ];
}

function makeFakeRequest(): ConsolidationRequest {
  return {
    events: makeFakeEvents(),
    threads: makeFakeThreads(),
    setups: makeFakeSetups(),
    stateLocation: "教室",
    stateCharacters: ["char1"],
  };
}

function makeFakeDiagnostics(): DiagnosticSink {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NarrativeConsolidatorAdapter", () => {
  it("issues a correctly-shaped chat completion request", async () => {
    const fakeClient = makeFakeClient();
    const adapter = new NarrativeConsolidatorAdapter({
      apiKey: "key",
      api: makeApiConfig(),
      config: DEFAULT_NARRATIVE_CONFIG,
      client: fakeClient,
    });

    await adapter.consolidate(makeFakeRequest());

    expect(fakeClient.chat.completions.create).toHaveBeenCalledOnce();

    const callArgs = (fakeClient.chat.completions.create as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [Record<string, unknown>, unknown?];
    const params = callArgs[0];

    expect(params.model).toBe("test-model");
    expect(params.temperature).toBe(0.3);
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.messages).toHaveLength(2);
    // messages are { role, content } objects
    const messages = params.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");

    // System prompt contains key instructions (Chinese)
    const sysContent = messages[0]!.content;
    expect(sysContent).toContain("剧情记忆整理器");
    expect(sysContent).toContain("只整理事实");
    expect(sysContent).toContain("summary 不超过");

    // User message contains thread/setup ids in the right format
    const userContent = messages[1]!.content;
    expect(userContent).toContain("===== 剧情事件 =====");
    expect(userContent).toContain("===== 当前剧情线 =====");
    expect(userContent).toContain("===== 当前伏笔 =====");
    // Thread line: "- t1（open）：主线剧情A"
    expect(userContent).toContain("- t1（open）：主线剧情A");
    expect(userContent).toContain("- t2（developing）：谜团线索B");
    // Setup line: "- s1（seeded）：窗外黑影闪过"
    expect(userContent).toContain("- s1（seeded）：窗外黑影闪过");
    // Event content appears
    expect(userContent).toContain("测试叙述文本");
  });

  it("embeds canonical character/location ids into the user message", async () => {
    const fakeClient = makeFakeClient({
      content: JSON.stringify({
        episode: {
          summary: "摘要",
          characters: ["suyao"],
          locations: ["clubroom"],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
      }),
    });
    const adapter = new NarrativeConsolidatorAdapter({
      apiKey: "k",
      api: makeApiConfig(),
      config: DEFAULT_NARRATIVE_CONFIG,
      client: fakeClient,
    });

    await adapter.consolidate({
      events: [],
      threads: [],
      setups: [],
      stateLocation: "clubroom",
      stateCharacters: ["suyao", "linche"],
    });

    const callArgs = (fakeClient.chat.completions.create as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [Record<string, unknown>, unknown?];
    const messages = callArgs[0].messages as Array<{ role: string; content: string }>;
    const userContent = messages[1]!.content;
    expect(userContent).toContain("suyao");
    expect(userContent).toContain("clubroom");
  });

  it("parses a valid JSON response into ConsolidationResult", async () => {
    const episodeJson = {
      summary: "测试摘要",
      characters: ["char1"],
      locations: ["loc1"],
      threads: ["t1"],
      setups: ["s1"],
      importance: "normal" as const,
    };
    const threadOp = { type: "touch" as const, id: "t1", progress: "推进了" };
    const setupOp = { type: "reinforce" as const, id: "s1" };
    const fakeClient = makeFakeClient({
      content: JSON.stringify({
        episode: episodeJson,
        threadOps: [threadOp],
        setupOps: [setupOp],
      }),
    });
    const adapter = new NarrativeConsolidatorAdapter({
      apiKey: "key",
      api: makeApiConfig(),
      config: DEFAULT_NARRATIVE_CONFIG,
      client: fakeClient,
    });

    const result = await adapter.consolidate(makeFakeRequest());

    expect(result.episode).toEqual(episodeJson);
    expect(result.threadOps).toEqual([threadOp]);
    expect(result.setupOps).toEqual([setupOp]);
  });

  it("throws when the JSON response is not valid JSON", async () => {
    const diagnostics = makeFakeDiagnostics();
    const fakeClient = makeFakeClient({ content: "not valid json {" });
    const adapter = new NarrativeConsolidatorAdapter({
      apiKey: "key",
      api: makeApiConfig(),
      config: DEFAULT_NARRATIVE_CONFIG,
      diagnostics,
      client: fakeClient,
    });

    await expect(adapter.consolidate(makeFakeRequest())).rejects.toThrow(
      "consolidator 输出解析失败",
    );
    expect(diagnostics.warn).toHaveBeenCalledWith(
      "NarrativeConsolidator",
      expect.stringContaining("JSON 解析失败"),
    );
  });

  it("throws when the JSON is valid but misses required fields (schema failure)", async () => {
    const diagnostics = makeFakeDiagnostics();
    const fakeClient = makeFakeClient({
      // missing threadOps and setupOps
      content: JSON.stringify({
        episode: {
          summary: "",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
      }),
    });
    const adapter = new NarrativeConsolidatorAdapter({
      apiKey: "key",
      api: makeApiConfig(),
      config: DEFAULT_NARRATIVE_CONFIG,
      diagnostics,
      client: fakeClient,
    });

    await expect(adapter.consolidate(makeFakeRequest())).rejects.toThrow(
      "consolidator 输出解析失败",
    );
    expect(diagnostics.warn).toHaveBeenCalledWith(
      "NarrativeConsolidator",
      expect.stringContaining("输出校验失败"),
    );
  });

  it("handles a response with empty ops arrays (minimal valid response)", async () => {
    const fakeClient = makeFakeClient({
      content: JSON.stringify({
        episode: {
          summary: "最小摘要",
          characters: [],
          locations: [],
          threads: [],
          setups: [],
          importance: "normal",
        },
        threadOps: [],
        setupOps: [],
      }),
    });
    const adapter = new NarrativeConsolidatorAdapter({
      apiKey: "key",
      api: makeApiConfig(),
      config: DEFAULT_NARRATIVE_CONFIG,
      client: fakeClient,
    });

    const result = await adapter.consolidate(makeFakeRequest());

    expect(result.episode.summary).toBe("最小摘要");
    expect(result.threadOps).toEqual([]);
    expect(result.setupOps).toEqual([]);
  });
});
