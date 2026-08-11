import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import { DEFAULT_NARRATIVE_CONFIG, type AppConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { NarrativeMemoryState } from "../../core/narrative/memory-types.js";
import { PlotPlannerAdapter } from "./plot-planner-adapter.js";
import type { PlotPlannerRequest } from "../../application/narrative/plot-planner.js";

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
      phase: "development",
      currentGoal: "推进玩家对苏遥的怀疑",
      beats: [{ purpose: "给一个侧面证据" }],
      focusThreads: ["terminal_origin"],
      revealLocks: ["suyao_memory_origin"],
      anchorOps: [{ type: "reach", id: "doubt_suyao_identity" }],
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

function makeFakeDiagnostics(): DiagnosticSink {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeFakeRequest(): PlotPlannerRequest {
  const memory: NarrativeMemoryState = {
    revision: 0,
    consolidatedThroughEventSeq: 0,
    checkpointCount: 0,
    threads: {},
    setups: {},
    anchors: {
      doubt_suyao_identity: {
        id: "doubt_suyao_identity",
        purpose: "让玩家开始怀疑苏遥的身份",
        prerequisites: [],
        required: true,
        status: "pending",
      },
    },
    recentEpisodeIds: [],
  };
  return {
    events: [],
    memory,
    currentPlan: undefined,
    location: "教室",
    characters: ["char1"],
  };
}

const VALID_JSON = JSON.stringify({
  phase: "development",
  currentGoal: "推进玩家对苏遥的怀疑",
  beats: [{ purpose: "给一个侧面证据" }],
  focusThreads: ["terminal_origin"],
  revealLocks: ["suyao_memory_origin"],
  anchorOps: [{ type: "reach", id: "doubt_suyao_identity" }],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlotPlannerAdapter", () => {
  it("sends system+user messages with anchors, threads and budget constraints", async () => {
    const client = makeFakeClient({ content: VALID_JSON });
    const adapter = new PlotPlannerAdapter({ apiKey: "k", api: makeApiConfig(), config: DEFAULT_NARRATIVE_CONFIG, client });
    await adapter.plan(makeFakeRequest());
    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.model).toBe("test-model");
    expect(call.response_format).toEqual({ type: "json_object" });
    const userMessage = call.messages[1]!.content as string;
    expect(userMessage).toContain("作者锚点");
    expect(userMessage).toContain("doubt_suyao_identity");
    expect(userMessage).toContain("max_major_active");
    expect(userMessage).toContain("horizon_checkpoints");
  });

  it("parses a valid JSON proposal", async () => {
    const adapter = new PlotPlannerAdapter({ apiKey: "k", api: makeApiConfig(), config: DEFAULT_NARRATIVE_CONFIG, client: makeFakeClient({ content: VALID_JSON }) });
    const proposal = await adapter.plan(makeFakeRequest());
    expect(proposal.phase).toBe("development");
    expect(proposal.beats).toEqual([{ purpose: "给一个侧面证据" }]);
    expect(proposal.anchorOps).toEqual([{ type: "reach", id: "doubt_suyao_identity" }]);
  });

  it("throws a clear error on bad JSON and on schema failure", async () => {
    const bad = new PlotPlannerAdapter({ apiKey: "k", api: makeApiConfig(), config: DEFAULT_NARRATIVE_CONFIG, client: makeFakeClient({ content: "not json" }) });
    await expect(bad.plan(makeFakeRequest())).rejects.toThrow("planner 输出解析失败");
    const schemaBad = new PlotPlannerAdapter({ apiKey: "k", api: makeApiConfig(), config: DEFAULT_NARRATIVE_CONFIG, client: makeFakeClient({ content: JSON.stringify({ ...JSON.parse(VALID_JSON), beats: [] }) }) });
    await expect(schemaBad.plan(makeFakeRequest())).rejects.toThrow("planner 输出解析失败");
  });
});
