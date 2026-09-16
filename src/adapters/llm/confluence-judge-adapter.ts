/**
 * ConfluenceJudgePort 的首个 adapter（执行清单 M2.1，设计 §3.3）。
 *
 * LLM 主观判定：把双方状态快照渲染为文本（故事状态 + 记忆线索 + 舞台），
 * 问「从此分叉继续，故事是否会一样？」，回收 {equivalent, confidence,
 * rationale}。复用演员管线的 openai-compatible client；调用方负责异步
 * 后台执行（实时性红线），本类不做重试/缓存——低置信落边策略在 M2.2。
 */
import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type {
  ConfluenceJudgment,
  ConfluenceJudgePort,
} from "../../core/ports/confluence-judge-port.js";
import type { StateSnapshot } from "../../core/graph/types.js";
import { serializeVisualContext } from "../../story/context-builder.js";
import { summarizeState } from "../../story/state.js";

// ---------------------------------------------------------------------------
// System prompt（固定中文指令，与 plot-planner-adapter 同风格）
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "你是剧情图的汇流判定员。给你两个剧情状态快照：状态甲（某条新路径的真实末态）与" +
  "状态乙（一个既有决策节点的入口态）。请判断：假如玩家从甲、乙两个状态分别继续游玩，" +
  "故事是否会走成同一条路？" +
  "判定看语义等价而非字面相同：地点与在场人物一致、人物关系与关键事实一致、" +
  "剧情线索（线程/伏笔/锚点）走向一致即等价；摘要措辞差异不算分歧。" +
  "舞台演出（背景/立绘/BGM）只是次要依据，演出差异不构成分歧。" +
  "只输出 JSON：{equivalent: boolean, confidence: 0到1的小数, rationale: 判定依据（指出" +
  "支持等价或分歧的关键状态差异，不超过 200 字）}。confidence 是你对本次判定的把握。";

const JudgmentOutputSchema = z.object({
  equivalent: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

// ---------------------------------------------------------------------------
// ConfluenceJudgeAdapter
// ---------------------------------------------------------------------------

export class ConfluenceJudgeAdapter implements ConfluenceJudgePort {
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

  async judge(input: {
    endState: StateSnapshot;
    candidateEntry: StateSnapshot;
  }): Promise<ConfluenceJudgment> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            renderSnapshot("状态甲（新路径末态）", input.endState),
            renderSnapshot("状态乙（候选后继节点入口态）", input.candidateEntry),
          ].join("\n\n"),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const rawContent = response.choices[0]?.message?.content ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      this.diagnostics.warn("ConfluenceJudge", `JSON 解析失败：${rawContent.slice(0, 200)}`);
      throw new Error("汇流判定输出解析失败");
    }

    const result = JudgmentOutputSchema.safeParse(parsed);
    if (!result.success) {
      this.diagnostics.warn("ConfluenceJudge", `输出校验失败：${result.error.message}`);
      throw new Error("汇流判定输出解析失败");
    }

    return { ...result.data, judgedBy: `llm:${this.model}` };
  }
}

// ---------------------------------------------------------------------------
// Snapshot rendering（判定专用的投影：复用 story/visual 序列化器 + digest 摘要行）
// ---------------------------------------------------------------------------

function renderSnapshot(label: string, snapshot: StateSnapshot): string {
  const parts: string[] = [`===== ${label} =====`];
  parts.push(summarizeState(snapshot.storyState));

  const digest = snapshot.memoryDigest;
  const digestLines: string[] = [];
  for (const thread of digest.threads) {
    digestLines.push(`- 线程 ${thread.id}（${thread.status}，${thread.importance}）：${thread.summary}`);
  }
  for (const setup of digest.setups) {
    digestLines.push(`- 伏笔 ${setup.id}（${setup.status}）：${setup.setup}`);
  }
  for (const anchor of digest.anchors) {
    digestLines.push(`- 锚点 ${anchor.id}（${anchor.status}）：${anchor.purpose}`);
  }
  if (digestLines.length > 0) {
    parts.push("剧情线索：\n" + digestLines.join("\n"));
  }

  parts.push("舞台演出（次要依据）：\n" + serializeVisualContext(snapshot.visualState));
  return parts.join("\n\n");
}
