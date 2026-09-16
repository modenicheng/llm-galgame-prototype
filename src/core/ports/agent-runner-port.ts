/**
 * AgentRunner port（执行清单 M4.1，决议 D1）——导演 agent 的最小工具循环。
 *
 * 不是通用 agent 框架：单轮 system+user 输入、一组确定性工具、步数上限
 * （MAX_AGENT_TOOL_STEPS，默认 6）内循环「模型 → 工具执行 → 回喂结果」；
 * 超限强制做一次无工具的最终问答收束为文本。工具执行由调用方注入——
 * runner 只负责循环与消息序列化，不理解任何具体工具。
 */

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema（OpenAI tool parameters 形状）。 */
  parameters: Record<string, unknown>;
}

/** 单次模型应答：要么给最终文本，要么请求一次工具调用。 */
export interface AgentTurnResult {
  /** 模型给出的最终文本（存在 toolCall 时为空串）。 */
  text: string;
  /** 非空 = 模型请求执行一个工具（一步只一个，保持最小）。 */
  toolCall?: { name: string; arguments: string };
}

export interface AgentRunnerPort {
  /**
   * 执行工具循环直到模型给出最终文本或步数耗尽。`executeTool` 由调用方
   * 提供且必须自行容错（抛错视为工具失败，错误文本回喂模型）。
   */
  runLoop(request: {
    system: string;
    user: string;
    tools: AgentTool[];
    executeTool: (name: string, argumentsJson: string) => Promise<string>;
  }): Promise<{ text: string }>;
}

/** 工具循环步数上限（M4.1：超限强制收束为最终文本输出）。 */
export const MAX_AGENT_TOOL_STEPS = 6;

