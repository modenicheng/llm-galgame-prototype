/**
 * AgentRunnerAdapter tests（执行清单 M4.1 验收）：
 * fake client 工具调用 → 执行 → 二轮文本；超步数强制收束。
 */

import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import { AgentRunnerAdapter } from "./agent-runner-adapter.js";
import { MAX_AGENT_TOOL_STEPS } from "../../core/ports/agent-runner-port.js";

function makeApiConfig(): AppConfig["api"] {
  return {
    model: "test-model",
    base_url: "https://api.example.com",
    api_key_env: "UNUSED_KEY",
    timeout_ms: 1000,
    token_limit_field: "max_completion_tokens",
  };
}

/** 依次回放预设应答的 fake client。 */
function makeScriptedClient(turns: Array<{
  toolCall?: { name: string; arguments: string };
  text?: string;
}>): OpenAI {
  let index = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const turn = turns[Math.min(index, turns.length - 1)]!;
          index += 1;
          if (turn.toolCall !== undefined) {
            return {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        type: "function",
                        function: {
                          name: turn.toolCall.name,
                          arguments: turn.toolCall.arguments,
                        },
                      },
                    ],
                  },
                },
              ],
            };
          }
          return { choices: [{ message: { content: turn.text ?? "" } }] };
        }),
      },
    },
  } as unknown as OpenAI;
}

const TOOLS = [
  {
    name: "readSceneHistory",
    description: "读场景历史",
    parameters: { type: "object", properties: { sceneId: { type: "string" } }, required: ["sceneId"] },
  },
];

describe("AgentRunnerAdapter", () => {
  it("runs the tool loop: tool call → execute → second round text", async () => {
    const client = makeScriptedClient([
      { toolCall: { name: "readSceneHistory", arguments: '{"sceneId":"旧校舍"}' } },
      { text: "最终指令文本" },
    ]);
    const runner = new AgentRunnerAdapter({ apiKey: "k", api: makeApiConfig(), client });
    const executeTool = vi.fn(async () => "场景历史文本");
    const result = await runner.runLoop({
      system: "system prompt",
      user: "user prompt",
      tools: TOOLS,
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledWith("readSceneHistory", '{"sceneId":"旧校舍"}');
    expect(result.text).toBe("最终指令文本");
    // 三次模型调用：首次（要工具）→ 工具结果回喂 → 最终文本
    expect(vi.mocked(client.chat.completions.create).mock.calls).toHaveLength(2);
  });

  it("force-finishes with a tool-free final call when the step cap is exceeded", async () => {
    const alwaysTool = Array.from({ length: MAX_AGENT_TOOL_STEPS + 2 }, () => ({
      toolCall: { name: "readSceneHistory", arguments: "{}" },
    }));
    const client = makeScriptedClient(alwaysTool);
    const runner = new AgentRunnerAdapter({ apiKey: "k", api: makeApiConfig(), client });
    const executeTool = vi.fn(async () => "结果");

    const result = await runner.runLoop({
      system: "s",
      user: "u",
      tools: TOOLS,
      executeTool,
    });

    expect(result.text).toBe(""); // 最终无工具调用的收束轮返回空文本（fake 末项无 text）
    // 恰好 MAX 步带工具 + 1 次强制收束
    expect(vi.mocked(client.chat.completions.create).mock.calls).toHaveLength(
      MAX_AGENT_TOOL_STEPS + 1,
    );
  });

  it("feeds tool execution errors back to the model instead of throwing", async () => {
    const client = makeScriptedClient([
      { toolCall: { name: "readSceneHistory", arguments: "not-json" } },
      { text: "已忽略工具失败" },
    ]);
    const runner = new AgentRunnerAdapter({ apiKey: "k", api: makeApiConfig(), client });
    const executeTool = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await runner.runLoop({
      system: "s",
      user: "u",
      tools: TOOLS,
      executeTool,
    });
    expect(executeTool).toHaveBeenCalled();
    expect(result.text).toBe("已忽略工具失败");
  });
});
