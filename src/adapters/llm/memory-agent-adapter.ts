import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type {
  MemoryAgentProposal,
  SessionMemoryAgentPort,
} from "../../core/ports/session-memory-agent-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { StoredEvent } from "../../schema.js";
import { serializeStoryContext } from "../../story/context-builder.js";
import { summarizeState } from "../../story/state.js";
import type { StoryState } from "../../story/types.js";
import type { Metrics } from "../../runtime/metrics.js";
import { parseLLMUsage } from "./llm-usage.js";

const SYSTEM_PROMPT =
  "你是互动视觉小说的状态投影器。根据剧情片段，提取人物状态与世界事实的**增量**更新。" +
  "只记录片段中已确认发生的事实，不得推测、不得补写剧情、不得评价。" +
  "人物 emotion 用一个词（如 开心/委屈/得意/尴尬）；current_goal 与 relationship_to_player 用短语。" +
  "canon 只记会影响后续理解的世界事实（谁欠谁什么、约了什么、哪台设备什么状态），键和值都用短中文。" +
  "open_threads 只登记新出现的待办/悬念，或明确推进的既有线索；没有变化就不要输出。" +
  "一切没有变化的字段一律省略。输出严格 JSON，格式：" +
  '{"characters":{"角色id":{"emotion":"…","current_goal":"…","relationship_to_player":"…"}},' +
  '"canon":{"键":"值"},"open_threads":[{"id":"…","summary":"…","status":"new|active|ready|resolved|abandoned"}]}。' +
  "不要输出 JSON 之外的任何文字。";

/** 结构校验：多余字段丢弃，字段值必须是字符串。长度由合并层裁剪。 */
const ProposalSchema = z.object({
  characters: z
    .record(
      z.string(),
      z
        .object({
          emotion: z.string().optional(),
          current_goal: z.string().optional(),
          relationship_to_player: z.string().optional(),
        })
        .optional(),
    )
    .optional(),
  canon: z.record(z.string(), z.string()).optional(),
  open_threads: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().optional(),
        status: z.enum(["new", "active", "ready", "resolved", "abandoned"]).optional(),
      }),
    )
    .optional(),
});

/** 从模型原文里抠出 JSON（容忍 ```json 围栏与前后杂文字）。 */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export class MemoryAgentAdapter implements SessionMemoryAgentPort {
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
    this.maxTokens = 400;
    this.tokenLimitField = opts.api.token_limit_field;
  }

  async derive(
    events: readonly StoredEvent[],
    state: StoryState,
  ): Promise<MemoryAgentProposal | null> {
    if (events.length === 0) return null;
    const eventText = serializeStoryContext([...events]);
    if (eventText.trim() === "") return null;

    const callStart = Date.now();
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `【当前状态】\n${summarizeState(state)}\n\n【新剧情片段】\n${eventText}`,
          },
        ],
        temperature: 0.2,
        ...(this.tokenLimitField === "max_tokens"
          ? { max_tokens: this.maxTokens }
          : { max_completion_tokens: this.maxTokens }),
        // DeepSeek reasoning models：顶层关闭思考（与 recap 压缩器一致）。
        ...(({ thinking: { type: "disabled" } }) as unknown as Record<string, unknown>),
      });

      const raw = (response.choices[0]?.message?.content ?? "").trim();
      this.metrics?.recordLLMRequest(
        "memory_agent",
        parseLLMUsage(response.usage) ?? { input: 0, output: Math.ceil(raw.length / 4) },
        Date.now() - callStart,
      );

      const parsed = ProposalSchema.safeParse(extractJson(raw));
      if (!parsed.success) {
        this.diagnostics.warn("Game", "记忆代理输出无法解析为有效提案，本批跳过");
        return null;
      }
      // exactOptionalPropertyTypes：zod 的可选字段带 | undefined，剥掉
      // 未提供的键，只把真实出现的部分交给合并层。
      const data = parsed.data;
      const proposal: MemoryAgentProposal = {};
      if (data.characters !== undefined) {
        const characters: Record<string, { emotion?: string; current_goal?: string; relationship_to_player?: string }> = {};
        for (const [id, fields] of Object.entries(data.characters)) {
          if (fields === undefined) continue;
          characters[id] = {
            ...(fields.emotion !== undefined ? { emotion: fields.emotion } : {}),
            ...(fields.current_goal !== undefined ? { current_goal: fields.current_goal } : {}),
            ...(fields.relationship_to_player !== undefined
              ? { relationship_to_player: fields.relationship_to_player }
              : {}),
          };
        }
        proposal.characters = characters;
      }
      if (data.canon !== undefined) proposal.canon = data.canon;
      if (data.open_threads !== undefined) {
        proposal.open_threads = data.open_threads.map((thread) => ({
          id: thread.id,
          ...(thread.summary !== undefined ? { summary: thread.summary } : {}),
          ...(thread.status !== undefined ? { status: thread.status } : {}),
        }));
      }
      return proposal;
    } catch (error) {
      this.metrics?.recordLLMRequest(
        "memory_agent",
        { input: 0, output: 0 },
        Date.now() - callStart,
      );
      this.diagnostics.warn("Game", `记忆代理提取失败：${String(error)}`);
      return null;
    }
  }
}
