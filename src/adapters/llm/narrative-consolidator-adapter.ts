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
  "threadOps:[{type,id,progress?}], setupOps:[{type,id,evidenceEventIds?}]}。" +
  "只整理事实，不要推测未来，不要写未来计划。" +
  "threads/setups 只能引用给定列表中的 id；唯一例外：threadOps 可用 " +
  "type=create 创建全新线程（id 自拟且不得与列表重复，importance 默认为 minor）。" +
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

  constructor(private readonly opts: {
    apiKey: string;
    api: AppConfig["api"];
    config: NarrativeConfig;
    diagnostics?: DiagnosticSink;
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
  }

  async consolidate(request: ConsolidationRequest): Promise<ConsolidationResult> {
    const userMessage = this.buildUserMessage(request);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const rawContent = response.choices[0]?.message?.content ?? "";

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

    return parts.join("\n\n");
  }
}
