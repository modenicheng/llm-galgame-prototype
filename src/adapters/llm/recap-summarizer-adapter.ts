import OpenAI from "openai";
import type { AppConfig } from "../../config.js";
import type {
  RecapSummarizerPort,
  RecapSummarizeContext,
} from "../../core/ports/recap-summarizer-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { StoredEvent } from "../../schema.js";
import { serializeStoryContext } from "../../story/context-builder.js";
import type { Metrics } from "../../runtime/metrics.js";
import { parseLLMUsage } from "./llm-usage.js";
import { thinkingRequestBody } from "./openai-compatible-generator.js";

const SYSTEM_PROMPT =
  "你是文字冒险游戏的剧情记录员。模型已经永远看不到你手上的剧情片段了，你的记录是这段剧情唯一的留存，" +
  "所以要把细节留住，不要压缩成干瘪的一句话概括：" +
  "按顺序记下确认发生过的事——谁在哪做了什么、玩家做出的选择和输入、达成的约定或交易、" +
  "出现过的物品/金额/数量/时间等具体数字、剧情转折与揭示；关键台词可以用极短直接引语保留。" +
  "禁止推测、禁止补写片段之外的信息、禁止评价或展望。" +
  "查重：人物情绪/目标/关系、世界事实台账、线索推进状态由另一套状态系统维护并已常驻提示词，" +
  "用户消息里的【已有框架内容】同样不要复述；只记叙事事实本身。" +
  "把要点用分号连接成单行记录，总共 4~8 个要点，直接输出记录文本，不要任何前后缀和解释。";

/** 单条 digest 的长度上限——防止模型失控写长（2026-09-19 从 240 放宽）。 */
const DIGEST_MAX_CHARS = 500;

export class RecapSummarizerAdapter implements RecapSummarizerPort {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly diagnostics: DiagnosticSink;
  private readonly metrics: Metrics | undefined;
  private readonly maxTokens: number;
  private readonly thinking: AppConfig["generation"]["thinking"] | undefined;
  private readonly tokenLimitField: AppConfig["api"]["token_limit_field"];

  constructor(opts: {
    apiKey: string;
    api: AppConfig["api"];
    /** 思考链开关（agents.recap.thinking 覆盖）；缺省关闭。 */
    thinking?: AppConfig["generation"]["thinking"];
    /** 输出 token 预算（agents.recap.max_tokens 覆盖）；开思考时须给足。 */
    maxTokens?: number;
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
    this.maxTokens = opts.maxTokens ?? 900;
    this.thinking = opts.thinking;
    this.tokenLimitField = opts.api.token_limit_field;
  }

  async summarize(
    events: readonly StoredEvent[],
    context?: RecapSummarizeContext,
  ): Promise<string | null> {
    if (events.length === 0) return null;
    const userMessage = serializeStoryContext([...events]);
    if (userMessage.trim() === "") return null;
    const framework = context?.frameworkDigest?.trim();
    const fullMessage =
      framework !== undefined && framework !== ""
        ? `【已有框架内容（状态台账与既有梗概，一律不要复述其中条目）】\n${framework}\n\n【剧情片段】\n${userMessage}`
        : userMessage;

    const callStart = Date.now();
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: fullMessage },
        ],
        temperature: 0.3,
        ...(this.tokenLimitField === "max_tokens"
          ? { max_tokens: this.maxTokens }
          : { max_completion_tokens: this.maxTokens }),
        // DeepSeek thinking 顶层开关（+ reasoning_effort），与主写手同一
        // 形态；agents.recap.thinking 未配置时保持关闭。
        ...thinkingRequestBody(this.thinking),
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
