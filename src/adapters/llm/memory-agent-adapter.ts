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
import { thinkingRequestBody } from "./openai-compatible-generator.js";
import type { ContextLlmRecorder, ContextLlmResult } from "../../core/ports/context-llm-recorder-port.js";

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

/**
 * 从模型原文里抠出 JSON 对象。
 *
 * 推理模型常在 content 里带 `<think>` 推演（内含大量花括号样式的伪
 * JSON）或代码围栏/前后杂文字， naïve 的 first-{-last-} 切片会被推理
 * 噪声带偏。策略：
 * 1. 先剥掉 `<think>…</think>`（含只有开头没有闭合的残截）；
 * 2. 括号配平扫描出所有顶层 `{…}` 候选切片（跳过字符串字面量内的
 *    花括号），从最后一个候选开始尝试解析——最终答案总在推理之后；
 * 3. 严格解析失败再试容错解析（去尾逗号）。
 */
export function extractJson(text: string): unknown {
  const body = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const thinkEnd = body.toLowerCase().lastIndexOf("</think>");
  const withoutThink = thinkEnd !== -1 ? body.slice(thinkEnd + "</think>".length) : body;

  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < withoutThink.length; i++) {
    const ch = withoutThink[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(withoutThink.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  for (const candidate of candidates.reverse()) {
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
      } catch {
        // 尝试下一个（更早的）候选切片。
      }
    }
  }
  return undefined;
}

/** 失败日志用的原文摘录：压平空白并截断，保证 /monitor 上可读。 */
export function rawOutputExcerpt(text: string, maxChars = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

export class MemoryAgentAdapter implements SessionMemoryAgentPort {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly diagnostics: DiagnosticSink;
  private readonly metrics: Metrics | undefined;
  private readonly maxTokens: number;
  private readonly thinking: AppConfig["generation"]["thinking"] | undefined;
  private readonly tokenLimitField: AppConfig["api"]["token_limit_field"];
  private readonly contextRecorder: ContextLlmRecorder | undefined;

  constructor(opts: {
    apiKey: string;
    api: AppConfig["api"];
    /** 思考链开关（agents.memory.thinking 覆盖）；缺省关闭。 */
    thinking?: AppConfig["generation"]["thinking"];
    /** 输出 token 预算（agents.memory.max_tokens 覆盖）。推理模型 reasoning
     * token 计入该预算，开思考时必须给足，否则 JSON 被截断必解析失败。 */
    maxTokens?: number;
    diagnostics?: DiagnosticSink;
    metrics?: Metrics;
    client?: OpenAI;
    /** 请求审计落盘（observability.record_llm_streams）；缺省不录。 */
    contextRecorder?: ContextLlmRecorder;
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
    this.maxTokens = opts.maxTokens ?? 1200;
    this.thinking = opts.thinking;
    this.tokenLimitField = opts.api.token_limit_field;
    this.contextRecorder = opts.contextRecorder;
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
      // 显式字面量 role 注解：无注解的对象字面量会把 "system" 宽化成
      // string，导致提取后的 body 再传给 create() 过不了类型检查。
      const messages: [
        { role: "system"; content: string },
        { role: "user"; content: string },
      ] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `【当前状态】\n${summarizeState(state)}\n\n【新剧情片段】\n${eventText}`,
        },
      ];
      const requestBody = {
        model: this.model,
        messages,
        temperature: 0.2,
        ...(this.tokenLimitField === "max_tokens"
          ? { max_tokens: this.maxTokens }
          : { max_completion_tokens: this.maxTokens }),
        // DeepSeek thinking 顶层开关（+ reasoning_effort），与主写手同一
        // 形态；agents.memory.thinking 未配置时保持关闭。
        ...thinkingRequestBody(this.thinking),
      };
      const send = async (): Promise<ContextLlmResult> => {
        const response = await this.client.chat.completions.create(requestBody);
        return {
          raw: response.choices[0]?.message?.content ?? "",
          usage: parseLLMUsage(response.usage),
        };
      };
      const { raw: untrimmed, usage } =
        this.contextRecorder !== undefined
          ? await this.contextRecorder.recordContextRequest(
              { taskType: "memory_agent", body: requestBody, meta: { events: events.length } },
              send,
            )
          : await send();

      const raw = untrimmed.trim();
      this.metrics?.recordLLMRequest(
        "memory_agent",
        usage ?? { input: 0, output: Math.ceil(raw.length / 4) },
        Date.now() - callStart,
      );

      const parsed = ProposalSchema.safeParse(extractJson(raw));
      if (!parsed.success) {
        // 带上原文摘录便于 /monitor 现场速览；完整原文已由落盘器留档。
        this.diagnostics.warn(
          "Game",
          `记忆代理输出无法解析为有效提案（模型 ${this.model}），本批跳过。原文摘录：${rawOutputExcerpt(raw) || "（空输出）"}`,
        );
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
