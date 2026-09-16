/**
 * ConfluenceJudgeAdapter 专项测试（执行清单 M2.1）。
 *
 * 配 fake OpenAI client 验证：双方快照都进入 user 消息、判定词与次要依据
 * 的指引在 system 提示中、合法 JSON 解析为 ConfluenceJudgment（judgedBy
 * 报模型名）、坏 JSON / schema 不合时大声抛错。
 */
import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import { createInitialState } from "../../story/state.js";
import type { StateSnapshot } from "../../core/graph/types.js";
import { EMPTY_MEMORY_DIGEST } from "../../core/graph/memory-digest.js";
import { ConfluenceJudgeAdapter } from "./confluence-judge-adapter.js";

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

function makeSnapshot(overrides?: {
  location?: string;
  recentSummary?: string;
  goal?: string;
}): StateSnapshot {
  const storyState = createInitialState({
    ...(overrides?.location ? { scene: { ...createInitialState().scene, location: overrides.location } } : {}),
    ...(overrides?.recentSummary ? { recent_summary: overrides.recentSummary } : {}),
    ...(overrides?.goal
      ? { characters: { su_yao: { location: "教室" } } }
      : {}),
  });
  return {
    snapshotVersion: 3,
    storyState,
    visualState: { characters: {} },
    memoryDigest: EMPTY_MEMORY_DIGEST,
    outlineRevision: 0,
  };
}

const VALID_JSON = JSON.stringify({
  equivalent: true,
  confidence: 0.82,
  rationale: "地点与在场人物一致，苏遥的目标未变，剧情线索走向相同。",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConfluenceJudgeAdapter", () => {
  it("sends both snapshots in the user message with the judging guidance in system", async () => {
    const client = makeFakeClient(VALID_JSON);
    const adapter = new ConfluenceJudgeAdapter({ apiKey: "k", api: makeApiConfig(), client });
    await adapter.judge({
      endState: makeSnapshot({ location: "旧校舍", recentSummary: "玩家在旧校舍发现了日记。" }),
      candidateEntry: makeSnapshot({ location: "旧校舍", recentSummary: "候选节点从日记的发现开始。" }),
    });

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.model).toBe("test-model");
    expect(call.response_format).toEqual({ type: "json_object" });
    const system = call.messages[0]!.content as string;
    const user = call.messages[1]!.content as string;
    expect(system).toContain("故事是否会走成同一条路");
    expect(system).toContain("次要依据");
    expect(user).toContain("状态甲（新路径末态）");
    expect(user).toContain("状态乙（候选后继节点入口态）");
    expect(user).toContain("旧校舍");
    expect(user).toContain("玩家在旧校舍发现了日记。");
    expect(user).toContain("候选节点从日记的发现开始。");
  });

  it("parses a valid judgment and stamps judgedBy with the model name", async () => {
    const adapter = new ConfluenceJudgeAdapter({
      apiKey: "k",
      api: makeApiConfig(),
      client: makeFakeClient(VALID_JSON),
    });
    const judgment = await adapter.judge({
      endState: makeSnapshot(),
      candidateEntry: makeSnapshot(),
    });
    expect(judgment).toEqual({
      equivalent: true,
      confidence: 0.82,
      rationale: "地点与在场人物一致，苏遥的目标未变，剧情线索走向相同。",
      judgedBy: "llm:test-model",
    });
  });

  it("throws a clear error on bad JSON and on schema failure", async () => {
    const bad = new ConfluenceJudgeAdapter({ apiKey: "k", api: makeApiConfig(), client: makeFakeClient("not json") });
    await expect(
      bad.judge({ endState: makeSnapshot(), candidateEntry: makeSnapshot() }),
    ).rejects.toThrow("汇流判定输出解析失败");

    const schemaBad = new ConfluenceJudgeAdapter({
      apiKey: "k",
      api: makeApiConfig(),
      client: makeFakeClient(JSON.stringify({ equivalent: "yes", confidence: 0.9, rationale: "x" })),
    });
    await expect(
      schemaBad.judge({ endState: makeSnapshot(), candidateEntry: makeSnapshot() }),
    ).rejects.toThrow("汇流判定输出解析失败");
  });
});
