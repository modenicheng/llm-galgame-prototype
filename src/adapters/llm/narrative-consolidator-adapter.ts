import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig, NarrativeConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type {
  ThreadOp,
  SetupOp,
  EpisodeSummaryOp,
} from "../../core/narrative/memory-operation.js";
import {
  ThreadOpSchema,
  SetupOpSchema,
  EpisodeSummaryOpSchema,
} from "../../core/narrative/memory-operation.js";
import { serializeStoryContext } from "../../story/context-builder.js";
import type { Metrics } from "../../runtime/metrics.js";
import { parseLLMUsage } from "./llm-usage.js";
import type { ContextLlmRecorder, ContextLlmResult } from "../../core/ports/context-llm-recorder-port.js";
import type {
  MemoryConsolidatorPort,
  ConsolidationRequest,
  ConsolidationResult,
} from "../../application/narrative/memory-consolidator.js";

// ---------------------------------------------------------------------------
// System prompt (fixed Chinese instruction — Task 9 brief)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "你是剧情记忆整理器。输入一段已发生剧情，输出 JSON：" +
  "{episode:{summary,characters,locations,threads,setups,importance}, " +
  "threadOps:[{type,id,progress?}], setupOps:[{type,id}]}。" +
  // evidenceEventIds 故意不邀请：事件序列化不暴露 seq，模型不可能写对
  // 该字段，带上只会让整条 op 被校验拒绝（audit 2026-09-17 #2）。
  "只整理事实，不要推测未来，不要写未来计划。" +
  "threads/setups 只能引用给定列表中的 id；唯一例外：threadOps 可用 " +
  "type=create 创建全新线程（id 自拟且不得与列表重复，必须携带 " +
  "kind∈{main,character,mystery,relationship,promise} 与 importance∈{major,minor}）。" +
  "summary 不超过 200 字。";

// ---------------------------------------------------------------------------
// Internal JSON shape (raw LLM output) + zod schema
// ---------------------------------------------------------------------------

interface RawConsolidatorJson {
  episode: EpisodeSummaryOp;
  threadOps: ThreadOp[];
  setupOps: SetupOp[];
}

const RawConsolidatorJsonSchema = z.object({
  episode: EpisodeSummaryOpSchema,
  threadOps: z.array(ThreadOpSchema),
  setupOps: z.array(SetupOpSchema),
});

// ---------------------------------------------------------------------------
// NarrativeConsolidatorAdapter
// ---------------------------------------------------------------------------

export class NarrativeConsolidatorAdapter implements MemoryConsolidatorPort {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly diagnostics: DiagnosticSink;
  private readonly metrics: Metrics | undefined;
  private readonly contextRecorder: ContextLlmRecorder | undefined;

  constructor(private readonly opts: {
    apiKey: string;
    api: AppConfig["api"];
    config: NarrativeConfig;
    diagnostics?: DiagnosticSink;
    client?: OpenAI;
    metrics?: Metrics;
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
    this.contextRecorder = opts.contextRecorder;
  }

  async consolidate(request: ConsolidationRequest): Promise<ConsolidationResult> {
    const userMessage = this.buildUserMessage(request);

    const callStart = Date.now();
    // 显式字面量 role 注解：无注解的对象字面量会把 "system" 宽化成
    // string，导致提取后的 body 再传给 create() 过不了类型检查。
    const messages: [
      { role: "system"; content: string },
      { role: "user"; content: string },
    ] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ];
    const requestBody = {
      model: this.model,
      messages,
      response_format: { type: "json_object" } as const,
      temperature: 0.3,
    };
    const send = async (): Promise<ContextLlmResult> => {
      const response = await this.client.chat.completions.create(requestBody);
      return {
        raw: response.choices[0]?.message?.content ?? "",
        usage: parseLLMUsage(response.usage),
      };
    };
    const { raw: rawContent, usage } =
      this.contextRecorder !== undefined
        ? await this.contextRecorder.recordContextRequest(
            { taskType: "narrative_consolidation", body: requestBody, meta: { events: request.events.length } },
            send,
          )
        : await send();
    this.metrics?.recordLLMRequest(
      "narrative_consolidation",
      usage ?? {
        input: 0,
        output: Math.ceil(rawContent.length / 4),
      },
      Date.now() - callStart,
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      this.diagnostics.warn(
        "NarrativeConsolidator",
        `JSON 解析失败：${rawContent.slice(0, 200)}`,
      );
      throw new Error("consolidator 输出解析失败");
    }

    const schemaResult = RawConsolidatorJsonSchema.safeParse(parsed);
    if (!schemaResult.success) {
      this.diagnostics.warn(
        "NarrativeConsolidator",
        `输出校验失败：${schemaResult.error.message}`,
      );
      throw new Error("consolidator 输出解析失败");
    }

    const data = schemaResult.data as RawConsolidatorJson;
    return {
      episode: data.episode,
      threadOps: data.threadOps,
      setupOps: data.setupOps,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildUserMessage(request: ConsolidationRequest): string {
    const parts: string[] = [];

    // Events section
    parts.push("===== 剧情事件 =====");
    parts.push(serializeStoryContext(request.events));

    // Threads section
    parts.push("===== 当前剧情线 =====");
    for (const t of request.threads) {
      parts.push(`- ${t.id}（${t.status}）：${t.summary}`);
    }

    // Setups section
    parts.push("===== 当前伏笔 =====");
    for (const s of request.setups) {
      parts.push(`- ${s.id}（${s.status}）：${s.setup}`);
    }

    // Canonical ids（audit P1-6）：episode 的 characters/locations 只能引用
    // 权威 ID，否则 EpisodeRetriever 的精确匹配永远落空。
    if (request.stateCharacters.length > 0) {
      parts.push("===== 权威角色 ID =====");
      parts.push(
        `episode.characters 只能使用以下 ID：${request.stateCharacters.join("、")}`,
      );
    }
    if (request.stateLocation !== "") {
      parts.push("===== 当前地点 ID =====");
      parts.push(`episode.locations 只能引用：${request.stateLocation}`);
    }

    return parts.join("\n\n");
  }
}
