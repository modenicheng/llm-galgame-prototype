/**
 * 编剧评分 adapter（执行清单 M5.5 ①）——单次 JSON 调用：输入末态记忆
 * digest 摘要 + 结局报告，输出玩家评注与大纲贴合度。
 */

import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";

export interface ScreenwriterReviewRequest {
  /** 末态记忆 digest 摘要（线程/伏笔/事实计数 + 摘要文本）。 */
  digestSummary: string;
  /** 结局报告（伏笔回收率等确定性聚合；可缺省）。 */
  endingReport?: { setups: { payoffRate: number }; threads: { resolved: number; abandoned: number; active: number } };
  /** 大纲 acts（目的文本；贴合度对照用）。 */
  outlineActs: Array<{ id: string; purpose: string; status: string }>;
}

export interface ScreenwriterReview {
  /** 编剧评注（≤200 字）。 */
  comment: string;
  /** 大纲贴合度描述（≤80 字）。 */
  outlineFit: string;
}

const ReviewSchema = z.object({
  comment: z.string().min(1).max(400),
  outlineFit: z.string().min(1).max(200),
});

export class ReviewAdapter {
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

  async reviewRun(request: ScreenwriterReviewRequest): Promise<ScreenwriterReview> {
    const parts: string[] = ["===== 末态记忆摘要 =====", request.digestSummary];
    if (request.endingReport !== undefined) {
      parts.push(
        `===== 结局报告 =====\n伏笔回收率 ${request.endingReport.setups.payoffRate}；线程 resolved/abandoned/active = ${request.endingReport.threads.resolved}/${request.endingReport.threads.abandoned}/${request.endingReport.threads.active}`,
      );
    }
    parts.push("===== 大纲 =====");
    for (const act of request.outlineActs) {
      parts.push(`- ${act.id}（${act.status}）：${act.purpose}`);
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "你是 GalGame 编剧，为本局游玩写一段评注。输入末态记忆摘要、结局报告与大纲，" +
            '输出 JSON：{comment: string, outlineFit: string}。comment ≤200 字、口吻克制；' +
            "outlineFit ≤80 字，说明本局与大纲的贴合程度。只输出 JSON。",
        },
        { role: "user", content: parts.join("\n\n") },
      ],
      response_format: { type: "json_object" },
      temperature: 0.6,
    });

    const raw = response.choices[0]?.message?.content ?? "";
    try {
      return ReviewSchema.parse(JSON.parse(raw));
    } catch (err: unknown) {
      this.diagnostics.warn(
        "ReviewAdapter",
        `评分输出解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
      throw new Error("评分输出解析失败");
    }
  }
}
