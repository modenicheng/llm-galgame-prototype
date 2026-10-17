import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import { SceneMusicComposerAdapter } from "./scene-music-composer-adapter.js";

const api: AppConfig["api"] = {
  model: "test-model",
  api_key_env: "TEST_KEY",
  timeout_ms: 1000,
  token_limit_field: "max_tokens",
};

const validScoreJson = JSON.stringify({
  version: 1,
  bpm: 92,
  key: 0,
  mode: "major",
  bars: 16,
  tracks: [
    { instrument: "piano", gain: 0.8, notes: [{ beat: 0, dur: 1, midi: 60, vel: 90 }] },
  ],
});

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

describe("SceneMusicComposerAdapter", () => {
  it("合法 JSON 一次通过", async () => {
    const { adapter, create } = makeAdapter([validScoreJson]);
    const score = await adapter.compose({
      sceneId: "scene_1",
      direction: { mood: "daily", intensity: 1 },
    });
    expect(score).not.toBeNull();
    expect(score!.tracks[0]!.instrument).toBe("piano");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("围栏包裹的 JSON 也能解析", async () => {
    const { adapter } = makeAdapter(["```json\n" + validScoreJson + "\n```"]);
    const score = await adapter.compose({
      sceneId: "scene_1",
      direction: { mood: "daily", intensity: 1 },
    });
    expect(score).not.toBeNull();
  });

  it("首次失败 → 携带 issue 与 assistant 回放修复重试", async () => {
    const { adapter, create } = makeAdapter([
      JSON.stringify({ version: 1, bpm: 999, key: 0, mode: "major", bars: 16, tracks: [] }),
      validScoreJson,
    ]);
    const score = await adapter.compose({
      sceneId: "scene_1",
      direction: { mood: "tense", intensity: 2 },
    });
    expect(score).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
    const secondRequest = create.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const roles = secondRequest.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(secondRequest.messages[3]!.content).toContain("未通过契约校验");
  });

  it("双败返回 null（服务层降级）", async () => {
    const { adapter, create } = makeAdapter(["not json at all", "still not json"]);
    const score = await adapter.compose({
      sceneId: "scene_1",
      direction: { mood: "tense", intensity: 2 },
    });
    expect(score).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });
});
