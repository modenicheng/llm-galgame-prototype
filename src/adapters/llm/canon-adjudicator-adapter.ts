/**
 * CanonAdjudicator adapter（执行清单 M3.6 ②）——编剧裁决变体，单次 JSON
 * 调用。prompt 约束：只裁决送审候选；与既有 canon 矛盾的候选不晋升、可登记
 * 例外（必须附补偿限制）；拿不准不晋升（canon 宁缺毋滥）。
 */

import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { CanonOp } from "../../core/ports/canon-store-port.js";
import type {
  CanonAdjudicatorPort,
  CanonCandidate,
} from "../../application/canon/canon-promoter.js";

const SYSTEM_PROMPT =
  "你是 GalGame 编剧，负责世界既定（canon）裁决。输入候选事实列表" +
  "（每个已被 ≥2 个周目佐证）与既有 canon，输出裁决 JSON：" +
  "{promote:[{id,content,evidenceRuns:[string]}], exceptions:[{id,content,reason,compensatingLimit}]}。" +
  "规则：与既有 canon 或候选间自洽的日常世界事实 → promote（content 原样保留）；" +
  "与既有 canon 矛盾但剧情上允许共存的 → exceptions 登记，必须写 reason 与" +
  "compensatingLimit（该例外在演出中的边界限制）；拿不准的一律不输出（宁缺毋滥）。" +
  "只输出 JSON，不写解释。";

const AdjudicationSchema = z.object({
  promote: z
    .array(
      z.object({
        id: z.string().min(1),
        content: z.string().min(1),
        evidenceRuns: z.array(z.string().min(1)).min(1),
      }),
    )
    .default([]),
  exceptions: z
    .array(
      z.object({
        id: z.string().min(1),
        content: z.string().min(1),
        reason: z.string().min(1),
        compensatingLimit: z.string().min(1),
      }),
    )
    .default([]),
});

export class CanonAdjudicatorAdapter implements CanonAdjudicatorPort {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly diagnostics: DiagnosticSink;

  constructor(private readonly opts: {
    apiKey: string;
    api: AppConfig["api"];
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

  async adjudicateCanon(request: {
    candidates: CanonCandidate[];
    existing: {
      promotedFacts: Array<{ id: string; content: string }>;
      exceptions: Array<{ id: string; content: string; compensatingLimit: string }>;
    };
  }): Promise<CanonOp[]> {
    const parts: string[] = ["===== 既有 canon ====="];
    if (request.existing.promotedFacts.length === 0) {
      parts.push("（暂无晋升事实）");
    } else {
      for (const fact of request.existing.promotedFacts) {
        parts.push(`- ${fact.content}`);
      }
    }
    if (request.existing.exceptions.length > 0) {
      parts.push("既有例外：");
      for (const e of request.existing.exceptions) {
        parts.push(`- ${e.content}（${e.compensatingLimit}）`);
      }
    }
    parts.push("===== 候选事实 =====");
    for (const candidate of request.candidates) {
      parts.push(`- [${candidate.id}] ${candidate.content}（佐证周目：${candidate.evidenceRuns.join("、")}）`);
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: parts.join("\n\n") },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const rawContent = response.choices[0]?.message?.content ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      this.diagnostics.warn(
        "CanonAdjudicator",
        `裁决输出不是 JSON（${rawContent.slice(0, 80)}…）→ 全部候选放弃`,
      );
      return [];
    }
    const checked = AdjudicationSchema.safeParse(parsed);
    if (!checked.success) {
      this.diagnostics.warn(
        "CanonAdjudicator",
        `裁决输出结构非法：${String(checked.error.message).slice(0, 120)} → 全部候选放弃`,
      );
      return [];
    }
    const ops: CanonOp[] = [
      ...checked.data.promote.map((fact) => ({ type: "promote" as const, fact })),
      ...checked.data.exceptions.map((exception) => ({ type: "exception" as const, exception })),
    ];
    return ops;
  }
}
