/**
 * AgentRunner adapter（执行清单 M4.1，决议 D1）——同一 openai-compatible
 * client 上的最小工具循环（步数上限 MAX_AGENT_TOOL_STEPS，超限强制收束）。
 * 与演员/编剧/汇流判定共用一个 client（反重复地图：LLM 调用不建第二套）。
 */

import OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import {
  MAX_AGENT_TOOL_STEPS,
} from "../../core/ports/agent-runner-port.js";
import type {
  AgentRunnerPort,
  AgentTool,
  AgentTurnResult,
} from "../../core/ports/agent-runner-port.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export class AgentRunnerAdapter implements AgentRunnerPort {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: { apiKey: string; api: AppConfig["api"]; client?: OpenAI }) {
    this.client =
      opts.client ??
      new OpenAI({
        apiKey: opts.apiKey,
        ...(opts.api.base_url ? { baseURL: opts.api.base_url } : {}),
        timeout: opts.api.timeout_ms,
      });
    this.model = opts.api.model;
  }

  async runLoop(request: {
    system: string;
    user: string;
    tools: AgentTool[];
    executeTool: (name: string, argumentsJson: string) => Promise<string>;
  }): Promise<{ text: string }> {
    const messages: ChatMessage[] = [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ];
    const tools = request.tools;

    for (let step = 0; step < MAX_AGENT_TOOL_STEPS; step += 1) {
      const turn = await this.complete(messages, tools);
      if (turn.toolCall === undefined) {
        return { text: turn.text };
      }
      // 执行工具并把结果回喂；执行抛错 → 错误文本回喂（模型可自行调整）。
      let toolOutput: string;
      try {
        toolOutput = await request.executeTool(turn.toolCall.name, turn.toolCall.arguments);
      } catch (err) {
        toolOutput = `工具执行失败：${String(err)}`;
      }
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${step}`,
            type: "function",
            function: { name: turn.toolCall.name, arguments: turn.toolCall.arguments },
          },
        ],
      });
      messages.push({
        role: "tool",
        tool_call_id: `call_${step}`,
        content: toolOutput,
      });
    }

    // 步数耗尽：强制收束为最终文本输出（不给工具，模型只能作答）。
    const final = await this.complete(messages, []);
    return { text: final.text };
  }

  /** 单次模型调用（tools 为空数组 = 禁用工具，强制文本收束）。 */
  private async complete(messages: ChatMessage[], tools: AgentTool[]): Promise<AgentTurnResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      ...(tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
    });
    const message = response.choices[0]?.message;
    const toolCall = message?.tool_calls?.[0];
    if (toolCall !== undefined && toolCall.type === "function") {
      return { text: "", toolCall: { name: toolCall.function.name, arguments: toolCall.function.arguments } };
    }
    return { text: message?.content ?? "" };
  }
}
