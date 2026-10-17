import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import type { ThemeCatalogEntry } from "../../shared/music/theme.js";
import { SceneMusicComposerAdapter } from "./scene-music-composer-adapter.js";

const api: AppConfig["api"] = {
  model: "test-model",
  api_key_env: "TEST_KEY",
  timeout_ms: 1000,
  token_limit_field: "max_tokens",
};

const validScoreJson = {
  version: 1,
  bpm: 92,
  key: 0,
  mode: "major",
  bars: 16,
  tracks: [
    { instrument: "piano", gain: 0.8, notes: [{ beat: 0, dur: 1, midi: 60, vel: 90 }] },
  ],
};

const reuseJson = JSON.stringify({
  action: "reuse",
  themeId: "fortress-echo",
  reason: "同一堡垒区域",
});

const composeJson = JSON.stringify({
  action: "compose",
  theme: { id: "market-dawn", title: "晨市", concept: "港口晨市" },
  score: validScoreJson,
  reason: "新区域",
});

const catalog: ThemeCatalogEntry[] = [
  {
    meta: {
      id: "fortress-echo",
      title: "堡垒回响",
      concept: "地下堡垒——压抑的机械回响",
      motifHint: "60,64,67,72",
    },
    stats: {
      bpm: 92,
      key: 9,
      mode: "minor",
      bars: 16,
      instruments: ["piano"],
      noteCount: 40,
      loopSeconds: 41.7,
    },
  },
];

function reply(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

function makeAdapter(responses: string[]): {
  adapter: SceneMusicComposerAdapter;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn();
  for (const content of responses) {
    create.mockResolvedValueOnce(reply(content));
  }
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { adapter: new SceneMusicComposerAdapter({ apiKey: "k", api, client }), create };
}

const input = {
  brief: {
    sceneId: "scene_1",
    sceneGoal: "地下堡垒夜巡",
    mood: "tense" as const,
    intensity: 2 as const,
    note: "金属回响，压抑",
  },
  catalog,
  sessionTurns: [
    { role: "user" as const, content: '{"sceneId":"scene_0","mood":"daily"}' },
    { role: "assistant" as const, content: '{"action":"compose","themeId":"fortress-echo"}' },
  ],
};

describe("SceneMusicComposerAdapter（V2 决策形态）", () => {
  it("合法 reuse JSON 一次通过", async () => {
    const { adapter, create } = makeAdapter([reuseJson]);
    const decision = await adapter.decide(input);
    expect(decision).toEqual({
      action: "reuse",
      themeId: "fortress-echo",
      reason: "同一堡垒区域",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("合法 compose JSON 一次通过", async () => {
    const { adapter } = makeAdapter([composeJson]);
    const decision = await adapter.decide({ ...input, catalog: [] });
    expect(decision!.action).toBe("compose");
    if (decision!.action === "compose") {
      expect(decision!.theme.id).toBe("market-dawn");
      expect(decision!.score.tracks[0]!.instrument).toBe("piano");
    }
  });

  it("system prompt 注入作曲 skill 关键禁令与复用纪律", async () => {
    const { adapter, create } = makeAdapter([reuseJson]);
    await adapter.decide(input);
    const system = (create.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> })
      .messages[0]!.content;
    expect(system).toContain("小二度");
    expect(system).toContain("三全音");
    expect(system).toContain("非和弦音");
    expect(system).toContain("平行五度");
    expect(system).toContain("复用纪律");
    expect(system).toContain("5~15");
    expect(system).toContain("east-asia");
  });

  it("messages = system + 会话历史 + 本轮 user；user 携带 brief 与目录统计", async () => {
    const { adapter, create } = makeAdapter([reuseJson]);
    await adapter.decide(input);
    const request = create.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    const user = request.messages[3]!.content;
    expect(user).toContain("scene_1");
    expect(user).toContain("fortress-echo");
    expect(user).toContain("动机：60,64,67,72");
    expect(user).toContain("40音");
  });

  it("目录为空 → user 明示必须 compose 首个主题", async () => {
    const { adapter, create } = makeAdapter([composeJson]);
    await adapter.decide({ ...input, catalog: [] });
    const user = (create.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> })
      .messages[3]!.content;
    expect(user).toContain("目录（空——必须 compose");
  });

  it("预算参数：max_tokens 16000；thinking disabled", async () => {
    const { adapter, create } = makeAdapter([reuseJson]);
    await adapter.decide(input);
    const request = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.max_tokens).toBe(16_000);
    expect((request as { thinking?: { type: string } }).thinking?.type).toBe("disabled");
  });

  it("首次失败 → 携带 issue 与 assistant 回放修复重试；双败 null", async () => {
    const { adapter, create } = makeAdapter([
      JSON.stringify({ action: "remix" }),
      reuseJson,
    ]);
    const decision = await adapter.decide(input);
    expect(decision!.action).toBe("reuse");
    expect(create).toHaveBeenCalledTimes(2);
    const secondRequest = create.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondRequest.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(secondRequest.messages[5]!.content).toContain("未通过契约校验");

    const doomed = makeAdapter(["not json", "still not json"]);
    await expect(doomed.adapter.decide(input)).resolves.toBeNull();
  });

  it("围栏包裹的 JSON 也能解析", async () => {
    const { adapter } = makeAdapter(["```json\n" + reuseJson + "\n```"]);
    const decision = await adapter.decide(input);
    expect(decision!.action).toBe("reuse");
  });

  it("LLM 在 compose.theme 里写 motifHint 被拒（防幻觉，服务层提取）", async () => {
    const hallucinated = JSON.stringify({
      action: "compose",
      theme: { id: "x", title: "X", concept: "c", motifHint: "1,2,3,4" },
      score: validScoreJson,
      reason: "r",
    });
    const { adapter, create } = makeAdapter([hallucinated, composeJson]);
    const decision = await adapter.decide({ ...input, catalog: [] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(decision!.action).toBe("compose");
  });
});
