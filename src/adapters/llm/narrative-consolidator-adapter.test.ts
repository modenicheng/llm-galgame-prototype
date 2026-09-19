import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { StoredEvent } from "../../schema.js";
import type { PlotThread, SetupPayoff } from "../../core/narrative/memory-types.js";
import type { CharacterRegistry } from "../../core/characters/types.js";
import type { ConsolidationRequest } from "../../application/narrative/memory-consolidator.js";
import type { MemoryIdentityView } from "../../application/narrative/memory-validator.js";
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
    expect(sysContent).toContain("kind∈{main,character,mystery,relationship,promise}");
    expect(sysContent).toContain("importance∈{major,minor}");

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

  it("parses MA-B extended output (factOps/beliefOps/findings) with tolerance for omission", async () => {
    const content = JSON.stringify({
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
      factOps: [
        {
          type: "establish",
          content: "终端会对苏遥的指纹反应",
          evidenceEventSeqs: [1, 2],
          importance: "major",
        },
      ],
      beliefOps: [
        {
          type: "believe",
          characterId: "char1",
          content: "char1 相信终端需要钥匙",
          evidenceEventSeqs: [1],
        },
      ],
      findings: [
        {
          dimension: "fact-conflict",
          severity: "major",
          content: "与既有事实矛盾",
          evidenceEventSeqs: [2],
        },
      ],
    });
    const adapter = new NarrativeConsolidatorAdapter({
      apiKey: "key",
      api: makeApiConfig(),
      config: DEFAULT_NARRATIVE_CONFIG,
      client: makeFakeClient({ content }),
    });
    const result = await adapter.consolidate({
      events: makeFakeEvents(),
      threads: [],
      setups: [],
      stateLocation: "loc1",
      stateCharacters: ["char1"],
    });
    expect(result.factOps).toHaveLength(1);
    expect(result.factOps[0]!.content).toContain("指纹");
    expect(result.beliefOps).toHaveLength(1);
    expect(result.beliefOps[0]!.type).toBe("believe");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe("major");

    // 旧输出（缺 MA-B 段）容错为空数组
    const legacy = await new NarrativeConsolidatorAdapter({
      apiKey: "key",
      api: makeApiConfig(),
      config: DEFAULT_NARRATIVE_CONFIG,
      client: makeFakeClient(),
    }).consolidate({
      events: makeFakeEvents(),
      threads: [],
      setups: [],
      stateLocation: "loc1",
      stateCharacters: ["char1"],
    });
    expect(legacy.factOps).toEqual([]);
    expect(legacy.beliefOps).toEqual([]);
    expect(legacy.findings).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // C8 §6.2 — main 接线：请求携带身份视图与证据投影（campus 在 adapter
  // 构造后随 ConsolidationResult 回传；main 按 §6.2 请求侧携带）。adapter
  // 只消费同一视图渲染权威 ID 段——模型被告知的权威与提案校验同源。
  // -----------------------------------------------------------------------
  describe("request-carried identity view (C8)", () => {
    /** Hand-rolled MemoryIdentityView（视图构造本身在 consolidator 测试钉）。 */
    function makeIdentityView(
      overrides: Partial<MemoryIdentityView> = {},
    ): MemoryIdentityView {
      return {
        rosterRevision: "v2-testrev",
        knownCharacterIds: new Set(["player", "suyao", "linche", "twin_ayaka", "twin_aoi"]),
        charactersByDisplayName: new Map([
          ["苏遥", ["suyao"]],
          ["绫香", ["twin_ayaka", "twin_aoi"]],
        ]),
        allowedCharacterIds: new Set(["suyao", "linche"]),
        evidenceCharacterIds: new Set(["suyao"]),
        evidenceSeqRange: { min: 1, max: 2 },
        canonicalLocations: new Set(["clubroom"]),
        ...overrides,
      };
    }

    /** Minimal hand-rolled CharacterRegistry（只覆盖 C5 回退投影读取的面）。 */
    function makeRegistry(
      characters: Array<{ id: string; name: string; initialLabel?: string }>,
    ): CharacterRegistry {
      const definitions = characters.map((c) => ({
        id: c.id,
        name: c.name,
        control: "npc" as const,
        initialLabel: c.initialLabel ?? c.name,
        persona: `persona of ${c.id}`,
      }));
      const byId = new Map(definitions.map((d) => [d.id, d] as const));
      return {
        roster: {
          schemaVersion: 2,
          scopeId: "test-scope",
          revision: "v2-testrev",
          playerId: "player",
          characters: definitions,
        },
        get: (id: string) => byId.get(id),
        require: (id: string) => {
          const found = byId.get(id);
          if (found === undefined) {
            throw new Error(`角色 ${id} 未注册`);
          }
          return found;
        },
      };
    }

    function makeDialogueEvent(
      seq: number,
      characterId: string,
      text: string,
    ): StoredEvent {
      return {
        seq,
        turn: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "model",
        type: "dialogue",
        speaker: characterId,
        characterId,
        text,
      } as unknown as StoredEvent;
    }

    function lastUserContent(fakeClient: OpenAI): string {
      const callArgs = (fakeClient.chat.completions.create as ReturnType<typeof vi.fn>)
        .mock.calls[0] as [Record<string, unknown>, unknown?];
      const messages = callArgs[0].messages as Array<{ role: string; content: string }>;
      return messages[1]!.content;
    }

    it("renders the authoritative stable-ID section (with roster revision) from the request's identity view", async () => {
      const fakeClient = makeFakeClient();
      const adapter = new NarrativeConsolidatorAdapter({
        apiKey: "key",
        api: makeApiConfig(),
        config: DEFAULT_NARRATIVE_CONFIG,
        client: fakeClient,
      });

      await adapter.consolidate({
        events: [makeDialogueEvent(1, "suyao", "开始吧。")],
        threads: [],
        setups: [],
        stateLocation: "clubroom",
        stateCharacters: ["suyao", "linche"],
        identity: makeIdentityView(),
        evidenceEvents: [],
      });

      const userContent = lastUserContent(fakeClient);
      expect(userContent).toContain("权威角色 ID");
      expect(userContent).toContain("v2-testrev");
      // 允许集合整体渲染（suyao、linche 并列，绝不合并显示名）。
      expect(userContent).toContain("suyao");
      expect(userContent).toContain("linche");
      expect(userContent).toContain("绝不合并");
      // 地点权威段：其他地点标签将被拒绝。
      expect(userContent).toContain("clubroom");
      expect(userContent).toContain("其他地点标签将被拒绝");
    });

    it("renders the strict-empty instruction when the request's allowed set is empty", async () => {
      const fakeClient = makeFakeClient();
      const adapter = new NarrativeConsolidatorAdapter({
        apiKey: "key",
        api: makeApiConfig(),
        config: DEFAULT_NARRATIVE_CONFIG,
        client: fakeClient,
      });

      await adapter.consolidate({
        // 纯旁白批次：无 characterId 证据；场景名单为空。
        events: makeFakeEvents(),
        threads: [],
        setups: [],
        stateLocation: "",
        stateCharacters: [],
        identity: makeIdentityView({
          allowedCharacterIds: new Set(),
          evidenceCharacterIds: new Set(),
          canonicalLocations: undefined,
        }),
        evidenceEvents: [],
      });

      // 空允许集合严格为空——明确告知必须输出空数组，不退化为不限。
      const userContent = lastUserContent(fakeClient);
      expect(userContent).toContain("必须");
      expect(userContent).toContain("空数组");
      expect(userContent).not.toContain("当前地点 ID");
    });

    it("lists same-name twins as distinct stable IDs (never merged)", async () => {
      const fakeClient = makeFakeClient();
      const adapter = new NarrativeConsolidatorAdapter({
        apiKey: "key",
        api: makeApiConfig(),
        config: DEFAULT_NARRATIVE_CONFIG,
        client: fakeClient,
      });

      await adapter.consolidate({
        events: [
          makeDialogueEvent(1, "twin_ayaka", "姐姐。"),
          makeDialogueEvent(2, "twin_aoi", "妹妹。"),
        ],
        threads: [],
        setups: [],
        stateLocation: "",
        stateCharacters: [],
        identity: makeIdentityView({
          allowedCharacterIds: new Set(["twin_ayaka", "twin_aoi"]),
          evidenceCharacterIds: new Set(["twin_ayaka", "twin_aoi"]),
        }),
        evidenceEvents: [],
      });

      // 允许清单里两个稳定 ID 并列，互不合并。
      const userContent = lastUserContent(fakeClient);
      expect(userContent).toContain("twin_ayaka");
      expect(userContent).toContain("twin_aoi");
    });

    it("renders the request-carried evidenceEvents (identity-stable JSONL) instead of legacy serialization", async () => {
      const fakeClient = makeFakeClient();
      const adapter = new NarrativeConsolidatorAdapter({
        apiKey: "key",
        api: makeApiConfig(),
        config: DEFAULT_NARRATIVE_CONFIG,
        client: fakeClient,
      });

      await adapter.consolidate({
        events: [makeDialogueEvent(1, "suyao", "这条线索不对劲。")],
        threads: [],
        setups: [],
        stateLocation: "",
        stateCharacters: [],
        identity: makeIdentityView(),
        evidenceEvents: [
          {
            eventRef: "event:1",
            seq: 1,
            type: "dialogue",
            source: "model",
            characterId: "suyao",
          },
        ],
      });

      const userContent = lastUserContent(fakeClient);
      // 投影 JSONL：eventRef 首位 + 稳定 characterId（非 legacy `speaker: text`）。
      expect(userContent).toContain(`"eventRef":"event:1"`);
      expect(userContent).toContain(`"characterId":"suyao"`);
      expect(userContent).not.toContain("suyao: 这条线索不对劲。");
    });

    it("keeps the C5 fallback: projects events with its own registry when the request carries no evidence", async () => {
      const registry = makeRegistry([{ id: "player", name: "玩家" }, { id: "suyao", name: "苏遥" }]);
      const fakeClient = makeFakeClient();
      const adapter = new NarrativeConsolidatorAdapter({
        apiKey: "key",
        api: makeApiConfig(),
        config: DEFAULT_NARRATIVE_CONFIG,
        // exactOptionalPropertyTypes：缺席时不传键（undefined 不是可选值）。
        ...(registry !== undefined ? { registry } : {}),
        client: fakeClient,
      });

      // 旧式请求（无 identity/evidenceEvents）：C5 行为——adapter 自带
      // registry 投影 + 冻结 legacy 权威段渲染，不携带身份权威。
      await adapter.consolidate({
        events: [makeDialogueEvent(1, "suyao", "旧式直连调用。")],
        threads: [],
        setups: [],
        stateLocation: "",
        stateCharacters: [],
      });

      const userContent = lastUserContent(fakeClient);
      expect(userContent).toContain(`"characterId":"suyao"`);
      expect(userContent).not.toContain("（roster");
      expect(userContent).not.toContain("绝不合并");
    });

    it("legacy request (no view, no registry): frozen legacy rendering, no identity section markers", async () => {
      const fakeClient = makeFakeClient();
      const adapter = new NarrativeConsolidatorAdapter({
        apiKey: "key",
        api: makeApiConfig(),
        config: DEFAULT_NARRATIVE_CONFIG,
        client: fakeClient,
      });

      await adapter.consolidate(makeFakeRequest());

      const userContent = lastUserContent(fakeClient);
      // legacy 渲染冻结：无 roster 版本段、无稳定 ID 纪律句、无投影 JSONL。
      expect(userContent).not.toContain("（roster");
      expect(userContent).not.toContain("绝不合并");
      expect(userContent).not.toContain(`"eventRef"`);
      expect(userContent).toContain("测试叙述文本");
    });
  });
});
