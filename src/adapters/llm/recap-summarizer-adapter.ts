import OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import type { RecapSummarizerPort } from "../../core/ports/recap-summarizer-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { StoredEvent } from "../../schema.js";
import { serializeStoryContext } from "../../story/context-builder.js";
import type { Metrics } from "../../runtime/metrics.js";
import { parseLLMUsage } from "./llm-usage.js";

const SYSTEM_PROMPT =
  "你是文字冒险游戏的剧情记录员。把用户给出的剧情片段压缩成不超过 3 句的中文事实记录：" +
  "只记录已确认发生的事实、玩家做出的选择或输入、人物之间关系的明确变化。" +
  "不得推测，不得补充片段之外的信息，不得评价或展望。" +
  "各要点用分号连接，直接输出记录文本，不要任何前后缀和解释。";

/** 单条 digest 的长度上限——防止模型失控写长。 */
const DIGEST_MAX_CHARS = 240;

export class RecapSummarizerAdapter implements RecapSummarizerPort {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly diagnostics: DiagnosticSink;
  private readonly metrics: Metrics | undefined;
  private readonly maxTokens: number;
  private readonly tokenLimitField: AppConfig["api"]["token_limit_field"];

  constructor(opts: {
    apiKey: string;
    api: AppConfig["api"];
    diagnostics?: DiagnosticSink;
    metrics?: Metrics;
    client?: OpenAI;
  }) {
    this.client =
      opts.client ??
      new OpenAI({
        apiKey: opts.apiKey,
        ...(opts.api.base_url ? { baseURL: opts.api.base_url } : {}),
        timeout: opts.api.timeout_ms,
      });
    this.model = opts.api.model;
    this.diagnostics = opts.diagnostics ?? silentDiagnosticSink;
    this.metrics = opts.metrics;
    this.maxTokens = 300;
    this.tokenLimitField = opts.api.token_limit_field;
  }

  async summarize(events: readonly StoredEvent[]): Promise<string | null> {
    if (events.length === 0) return null;
    const userMessage = serializeStoryContext([...events]);
    if (userMessage.trim() === "") return null;

    const callStart = Date.now();
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.3,
        ...(this.tokenLimitField === "max_tokens"
          ? { max_tokens: this.maxTokens }
          : { max_completion_tokens: this.maxTokens }),
        // DeepSeek reasoning models：顶层关闭思考（与生成器一致）。
        ...(({ thinking: { type: "disabled" } }) as unknown as Record<
          string,
          unknown
        >),
      });

      const raw = (response.choices[0]?.message?.content ?? "").trim();
      this.metrics?.recordLLMRequest(
        "recap_summarization",
        parseLLMUsage(response.usage) ?? {
          input: 0,
          output: Math.ceil(raw.length / 4),
        },
        Date.now() - callStart,
      );

      // 容错清理：剥掉可能出现的代码围栏/引号包裹，限长。
      const cleaned = raw
        .replace(/^```[a-z]*\s*/i, "")
        .replace(/```\s*$/i, "")
        .replace(/^["“」『]+|["”「』]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned === "") return null;
      return cleaned.length > DIGEST_MAX_CHARS
        ? `${cleaned.slice(0, DIGEST_MAX_CHARS)}…`
        : cleaned;
    } catch (error) {
      this.metrics?.recordLLMRequest(
        "recap_summarization",
        { input: 0, output: 0 },
        Date.now() - callStart,
      );
      this.diagnostics.warn(
        "RecapSummarizer",
        `前情压缩失败，回退确定性摘要：${String(error)}`,
      );
      return null;
    }
  }
}
