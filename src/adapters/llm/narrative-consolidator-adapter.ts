import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig, NarrativeConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type {
  ThreadOp,
  SetupOp,
  EpisodeSummaryOp,
  FactOp,
  BeliefOp,
  AuditFinding,
} from "../../core/narrative/memory-operation.js";
import {
  ThreadOpSchema,
  SetupOpSchema,
  EpisodeSummaryOpSchema,
  FactOpSchema,
  BeliefOpSchema,
  AuditFindingSchema,
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
  "threadOps:[{type,id,progress?}], setupOps:[{type,id,evidenceEventIds?}], " +
  "factOps:[{type,id?,content,evidenceEventSeqs,scope?,importance?}], " +
  "beliefOps:[{type,characterId,content,evidenceEventSeqs,replacesBeliefId?}], " +
  "findings:[{dimension,severity,content,evidenceEventSeqs,subject?}]}。" +
  "只整理事实，不要推测未来，不要写未来计划。" +
  "threads/setups 只能引用给定列表中的 id；唯一例外：threadOps 可用 " +
  "type=create 创建全新线程（id 自拟且不得与列表重复，必须携带 " +
  "kind∈{main,character,mystery,relationship,promise} 与 importance∈{major,minor}）。" +
  "summary 不超过 200 字。" +
  "factOps：type=establish 登记剧情已确立、未来会被引用的事实（≤120 字，" +
  "每批最多 3 条；content 用「<主语/范围> + <事实>」句式），type=amend 修订" +
  "既有事实（id 必填，指向给定事实列表中的 id）；evidenceEventSeqs 填 1..3 条" +
  "证据事件 seq（必须在本批内）；importance=major 表示常驻导演便签的事实。" +
  "beliefOps：登记角色认知边界——learn=在场获知、believe=可能错误的信念、" +
  "correct=信念被纠正（replacesBeliefId 必填）；content 为命题式 ≤80 字" +
  "（如「苏遥知道终端会响应玩家指纹」）。" +
  "findings：只报本批内可判定的矛盾（dimension ∈ {belief-violation," +
  "fact-conflict,character-consistency}；severity ∈ {critical,major,normal,minor}），" +
  "每批最多 5 条，只描述事实与判级，不给改写建议。没有则输出空数组。";

// ---------------------------------------------------------------------------
// Internal JSON shape (raw LLM output) + zod schema
// ---------------------------------------------------------------------------

interface RawConsolidatorJson {
  episode: EpisodeSummaryOp;
  threadOps: ThreadOp[];
  setupOps: SetupOp[];
  factOps: FactOp[];
  beliefOps: BeliefOp[];
  findings: AuditFinding[];
}

const RawConsolidatorJsonSchema = z.object({
  episode: EpisodeSummaryOpSchema,
  threadOps: z.array(ThreadOpSchema),
  setupOps: z.array(SetupOpSchema),
  // MA-B：模型未输出时视为空数组（旧 prompt / 无内容场景的容错）。
  factOps: z.array(FactOpSchema).default([]),
  beliefOps: z.array(BeliefOpSchema).default([]),
  findings: z.array(AuditFindingSchema).default([]),
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
      factOps: data.factOps,
      beliefOps: data.beliefOps,
      findings: data.findings,
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
