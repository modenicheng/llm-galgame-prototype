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
import { serializeStoryContextLegacy } from "../../story/context-builder.js";
import {
  projectMemoryEvidence,
  renderProjectedEvents,
} from "../../story/event-projection.js";
import type { ProjectedEvent } from "../../story/event-projection.js";
import type { CharacterRegistry } from "../../core/characters/types.js";
import type {
  MemoryConsolidatorPort,
  ConsolidationRequest,
  ConsolidationResult,
} from "../../application/narrative/memory-consolidator.js";
import type { MemoryIdentityView } from "../../application/narrative/memory-validator.js";

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
  "episode.characters 只能使用用户消息「权威角色 ID」清单中的稳定 ID；" +
  "显示名（角色姓名/名牌）不是 ID，同名角色以稳定 ID 区分，绝不合并。" +
  "summary 不超过 200 字。" +
  "factOps：type=establish 登记剧情已确立、未来会被引用的事实（≤120 字，" +
  "每批最多 3 条；content 用「<主语/范围> + <事实>」句式），type=amend 修订" +
  "既有事实——id 必填且只能引用「相关既定事实」清单中给出的 id（清单为空" +
  "就不输出 amend）；evidenceEventSeqs 填 1..3 条证据事件 seq（必须在本批" +
  "事件的 seq 范围内——批前已整理过的 seq 同样非法）；importance=major " +
  "表示常驻导演便签的事实。" +
  "beliefOps：登记角色认知边界——learn=获知、believe=可能错误的信念、" +
  "correct=信念被纠正（replacesBeliefId 必填，且只能引用「相关角色认知」" +
  "清单中同一角色 characterId 的 belief id；角色只能纠正自己的认知）。" +
  "characterId 只能取「权威角色 ID」清单中的稳定 ID，且该角色必须在本批" +
  "证据中登场或明确在场被告知——仅因角色存在于世界不算获知依据。" +
  "content 为命题式 ≤80 字（如「苏遥知道终端会响应玩家指纹」）。" +
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
    /** C2 角色注册表（bootstrap 注入）；缺席 = legacy 兼容渲染。 */
    registry?: CharacterRegistry;
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
    // 注：main 侧不存在 campus 的 this.registry 未赋值缺陷——main 以
    // `private readonly opts` 参数属性持有注册表（this.opts.registry 恒
    // 可用），C5 的注入自始生效。
  }

  async consolidate(request: ConsolidationRequest): Promise<ConsolidationResult> {
    // C8 §6.2（main 接线）：身份视图与记忆证据投影由 MemoryConsolidator
    // 构造并随 REQUEST 显式携带（campus 在 adapter 构造后随结果回传，
    // 校验函数零差异）。adapter 只消费：用请求携带的 evidenceEvents 渲染
    // 身份稳定事件、用 identity 渲染权威 ID 段——模型被告知的权威与提案
    // 校验同源。请求未携带时回退 C5 行为（adapter 自带 registry 投影），
    // 再退 legacy 冻结渲染。
    const evidence =
      request.evidenceEvents ??
      (this.opts.registry !== undefined
        ? projectMemoryEvidence(request.events, this.opts.registry)
        : undefined);
    const identity = request.identity;

    const userMessage = this.buildUserMessage(request, evidence, identity);

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

  private buildUserMessage(
    request: ConsolidationRequest,
    evidence: readonly ProjectedEvent[] | undefined,
    identity: MemoryIdentityView | undefined,
  ): string {
    const parts: string[] = [];

    // Events section
    parts.push("===== 剧情事件 =====");
    // C5 §5.1：身份稳定的事件 JSON（registry 缺席 = 兼容路径，冻结 legacy
    // 渲染）。C8 起优先渲染请求携带的 evidenceEvents（与 identity 同源）。
    parts.push(
      evidence !== undefined
        ? renderProjectedEvents(evidence)
        : serializeStoryContextLegacy(request.events),
    );

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

    if (identity !== undefined) {
      // C8 §6.2 权威角色 ID：允许集合 = 证据登场 ∪ 场景名单。空集合
      // 严格为空——明确告知模型必须输出空数组，不退化为不限。
      parts.push(`===== 权威角色 ID（roster ${identity.rosterRevision}） =====`);
      if (identity.allowedCharacterIds.size > 0) {
        parts.push(
          `episode.characters 只能使用以下稳定 ID：${[...identity.allowedCharacterIds].join("、")}。` +
            "显示名（角色姓名/名牌）不是合法取值；同名角色以稳定 ID 区分，绝不合并。",
        );
      } else {
        parts.push(
          "本批证据无可归因角色，允许集合为空：episode.characters 必须是空数组 []。" +
            "空允许集合严格为空——任何 ID 或显示名都会被整案拒绝。",
        );
      }
      if (identity.canonicalLocations !== undefined) {
        parts.push("===== 当前地点 ID =====");
        parts.push(
          `episode.locations 只能引用：${request.stateLocation}（其他地点标签将被拒绝）。`,
        );
      }
    } else {
      // Legacy（无 registry）：兼容渲染冻结，不携带身份权威。
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
    }

    // --- M2 §6.2：可引用的 facts/beliefs 候选（与校验权威同源一份清单）---
    if (request.relevantFacts !== undefined) {
      parts.push("===== 相关既定事实（amend 可引用） =====");
      if (request.relevantFacts.length === 0) {
        parts.push("没有可修订的事实：factOps 不得输出 type=amend（establish 照常）。");
      } else {
        for (const fact of request.relevantFacts) {
          parts.push(`- ${fact.id}：${fact.content}`);
        }
        parts.push("factOps 的 type=amend 只能引用上述 id；其他 fact id 会被整案拒绝。");
      }
    }
    if (request.relevantBeliefs !== undefined) {
      parts.push("===== 相关角色认知（correct 可引用） =====");
      if (request.relevantBeliefs.length === 0) {
        parts.push("没有可纠正的认知：beliefOps 不得输出 type=correct（learn/believe 照常）。");
      } else {
        for (const belief of request.relevantBeliefs) {
          parts.push(`- ${belief.id}（${belief.characterId}）：${belief.content}`);
        }
        parts.push(
          "beliefOps 的 replacesBeliefId 只能引用上述 id，且必须属于同一角色 characterId；" +
            "其他 belief id 会被整案拒绝。",
        );
      }
    }

    // --- M2 §6.2 定向修复：上一次尝试的 issues（整批被拒后重试一次）---
    if (request.priorIssues !== undefined && request.priorIssues.length > 0) {
      parts.push("===== 上次提案被拒（定向修复） =====");
      parts.push(
        "上一次整理提案因以下身份/引用问题被整案拒绝。请修正后重新输出完整 JSON：" +
          "使用权威清单中的稳定 ID、只引用给定清单中的 fact/belief id、" +
          "证据 seq 落在本批事件范围内。",
      );
      for (const issue of request.priorIssues) {
        parts.push(`- ${issue.path}=${issue.value}（${issue.code}）`);
      }
    }

    return parts.join("\n\n");
  }
}
