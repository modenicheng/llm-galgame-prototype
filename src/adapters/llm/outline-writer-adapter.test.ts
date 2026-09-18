/**
 * OutlineWriterAdapter tests（执行清单 M3.2 验收，形态同
 * plot-planner-adapter.test.ts）：合法解析 / 非 JSON / schema 拒绝。
 */

import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import { OutlineWriterAdapter } from "./outline-writer-adapter.js";

function makeApiConfig(): AppConfig["api"] {
  return {
    model: "test-model",
    base_url: "https://api.example.com",
    api_key_env: "UNUSED_KEY",
    timeout_ms: 1000,
    token_limit_field: "max_completion_tokens",
  };
}

function makeFakeClient(opts?: { content?: string }): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: opts?.content ?? "" } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

const VALID_JSON = JSON.stringify({
  worldSetting: "平行世界的学园都市，超能力与日常交织。",
  characters: [
    { id: "su_yao", name: "苏遥", description: "转学生，随身带着旧终端。", spriteBinding: "suyao" },
    { id: "lin_che", name: "林澈", description: "主人公，好奇心旺盛。" },
  ],
  outline: [
    { id: "ol_act_1", purpose: "转学生登场，旧终端首次异动", kind: "act", status: "planned", location: "教室" },
    { id: "ol_act_2", purpose: "放学后共同调查终端来历", kind: "act", status: "planned", location: "旧校舍" },
    { id: "ol_end_true", purpose: "知晓终端真相并接纳彼此", kind: "ending", status: "planned", location: "旧校舍" },
    { id: "ol_end_void", purpose: "终端沉默，关系回到原点", kind: "ending", status: "planned" },
  ],
});

function makeAdapter(content: string): OutlineWriterAdapter {
  return new OutlineWriterAdapter({
    apiKey: "key",
    api: makeApiConfig(),
    client: makeFakeClient({ content }),
  });
}

describe("OutlineWriterAdapter", () => {
  it("parses a valid world draft (act chain + 1-2 endings, all planned)", async () => {
    const draft = await makeAdapter(VALID_JSON).writeOutline({
      userText: "学园都市题材，双结局。",
    });
    expect(draft.worldSetting).toContain("学园都市");
    expect(draft.characters).toHaveLength(2);
    expect(draft.characters[0]!.spriteBinding).toBe("suyao");
    expect(draft.outline.map((n) => n.kind)).toEqual(["act", "act", "ending", "ending"]);
    expect(draft.outline.every((n) => n.status === "planned")).toBe(true);
  });

  it("throws a clear error on non-JSON output", async () => {
    await expect(
      makeAdapter("not json at all").writeOutline({ userText: "任意描述" }),
    ).rejects.toThrow("outline 输出解析失败");
  });

  it("throws a clear error when the schema rejects the draft", async () => {
    const missingEndings = JSON.stringify({
      worldSetting: "设定。",
      characters: [{ id: "a", name: "A", description: "角色描述。" }],
      outline: [
        { id: "ol_act_1", purpose: "幕一", kind: "act", status: "planned" },
        { id: "ol_act_2", purpose: "幕二", kind: "act", status: "planned" },
      ],
    });
    await expect(
      makeAdapter(missingEndings).writeOutline({ userText: "任意描述" }),
    ).rejects.toThrow("outline 输出解析失败");

    // 空剧情：同 schema 拒绝
    const emptyActs = JSON.stringify({
      worldSetting: "设定。",
      characters: [{ id: "a", name: "A", description: "角色描述。" }],
      outline: [{ id: "ol_end_x", purpose: "唯一节点", kind: "ending", status: "planned" }],
    });
    await expect(
      makeAdapter(emptyActs).writeOutline({ userText: "任意描述" }),
    ).rejects.toThrow("outline 输出解析失败");
  });
});

describe("OutlineWriterAdapter — 编剧音频画像（V2）", () => {
  it("passes the voice design through to the draft character", async () => {
    const withVoice = JSON.parse(VALID_JSON);
    withVoice.characters[0].voice = {
      timbre: "年轻女性，清亮偏冷",
      delivery: ["restrained", "firm"],
      avoid: ["playful"],
      baseline: { pace: "slow", volume: "soft" },
    };
    const draft = await makeAdapter(JSON.stringify(withVoice)).writeOutline({
      userText: "任意描述",
    });
    expect(draft.characters[0]?.voice).toEqual({
      timbre: "年轻女性，清亮偏冷",
      delivery: ["restrained", "firm"],
      avoid: ["playful"],
      baseline: { pace: "slow", volume: "soft" },
    });
    expect(draft.characters[1]?.voice).toBeUndefined();
  });

  it("rejects a voice design with empty timbre or unknown baseline values", async () => {
    const bad = [
      { timbre: "", delivery: ["restrained"] },
      { timbre: "声音", delivery: [] },
      { timbre: "声音", delivery: ["restrained"], baseline: { pace: "warp" } },
    ];
    for (const voice of bad) {
      const payload = JSON.parse(VALID_JSON);
      payload.characters[0].voice = voice;
      await expect(
        makeAdapter(JSON.stringify(payload)).writeOutline({ userText: "任意描述" }),
      ).rejects.toThrow("outline 输出解析失败");
    }
  });
});
