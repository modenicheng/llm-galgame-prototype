import OpenAI from "openai";
import type { AppConfig, NarrativeConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { serializeStoryContext } from "../../story/context-builder.js";
import type {
  PlotPlannerPort,
  PlotPlannerRequest,
  PlannerProposal,
} from "../../application/narrative/plot-planner.js";
import { PlannerProposalSchema } from "../../application/narrative/plot-planner.js";
import {
  ACTIVE_THREAD_STATUSES,
  NON_TERMINAL_SETUP_STATUSES,
} from "../../application/narrative/memory-consolidator.js";
import { PLANNER_RECENT_EVENTS_MAX } from "../../application/narrative/plot-planner.js";

// ---------------------------------------------------------------------------
// System prompt (fixed Chinese instruction — Task 7 brief)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "你是剧情导演。输入作者锚点、当前剧情记忆、最近事件与当前计划，输出未来几个 checkpoint 的导演计划 JSON：" +
  "{phase, currentGoal, beats:[{purpose}], focusThreads, anchorOps:[{type,id}], revealLocks}。" +
  "只规划剧情走向与目的，不要写任何具体台词或对话。" +
  "focusThreads 只能引用给定线程 id；anchorOps 只能引用给定锚点 id，reach 必须满足该锚点全部前置（同批先满足的算满足），required 锚点不能 pass。" +
  "revealLocks 是暂时不得确认为事实的揭示项清单。" +
  "beats 1~6 条，每条 purpose 不超过 200 字；currentGoal 不超过 200 字。";

// ---------------------------------------------------------------------------
// PlotPlannerAdapter
// ---------------------------------------------------------------------------

export class PlotPlannerAdapter implements PlotPlannerPort {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly config: NarrativeConfig;
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
    this.config = opts.config;
    this.diagnostics = opts.diagnostics ?? silentDiagnosticSink;
  }

  async plan(request: PlotPlannerRequest): Promise<PlannerProposal> {
    const userMessage = this.buildUserMessage(request);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      temperature: 0.5,
    });

    const rawContent = response.choices[0]?.message?.content ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      this.diagnostics.warn(
        "PlotPlanner",
        `JSON 解析失败：${rawContent.slice(0, 200)}`,
      );
      throw new Error("planner 输出解析失败");
    }

    const schemaResult = PlannerProposalSchema.safeParse(parsed);
    if (!schemaResult.success) {
      this.diagnostics.warn(
        "PlotPlanner",
        `输出校验失败：${schemaResult.error.message}`,
      );
      throw new Error("planner 输出解析失败");
    }

    return schemaResult.data;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildUserMessage(request: PlotPlannerRequest): string {
    const parts: string[] = [];

    // Anchors section (sorted by id, all shown)
    parts.push("===== 作者锚点 =====");
    const anchors = Object.values(request.memory.anchors).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    for (const anchor of anchors) {
      const prereqs =
        anchor.prerequisites.length > 0 ? anchor.prerequisites.join(", ") : "";
      const flag = anchor.required ? "required，" : "";
      parts.push(
        `- ${anchor.id}（${flag}${anchor.status}，前置 [${prereqs}]）：${anchor.purpose}`,
      );
    }

    // Threads section (only non-terminal)
    parts.push("===== 当前剧情线 =====");
    const threads = Object.values(request.memory.threads)
      .filter((t) => ACTIVE_THREAD_STATUSES.has(t.status))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const t of threads) {
      parts.push(`- ${t.id}（${t.status}，${t.importance}）：${t.summary}`);
    }

    // Setups section (only non-terminal)
    parts.push("===== 当前伏笔 =====");
    const setups = Object.values(request.memory.setups)
      .filter((s) => NON_TERMINAL_SETUP_STATUSES.has(s.status))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const s of setups) {
      parts.push(`- ${s.id}（${s.status}）：${s.setup}`);
    }

    // Recent events section
    parts.push("===== 最近事件 =====");
    const recentEvents = request.events.slice(-PLANNER_RECENT_EVENTS_MAX);
    parts.push(
      recentEvents.length > 0 ? serializeStoryContext(recentEvents) : "暂无",
    );

    // Current plan section
    parts.push("===== 当前导演计划 =====");
    const plan = request.currentPlan;
    if (plan === undefined) {
      parts.push("无");
    } else {
      parts.push(`phase：${plan.phase}`);
      parts.push(`currentGoal：${plan.currentGoal}`);
      parts.push(
        `beats：${plan.beats.map((b) => b.purpose).join(" / ")}`,
      );
      parts.push(`focusThreads：${plan.focusThreads.join(", ")}`);
      parts.push(`revealLocks：${plan.revealLocks.join(", ")}`);
      parts.push(`expiresAfterCheckpoint：${plan.expiresAfterCheckpoint}`);
    }

    // Budget section
    parts.push("===== 预算约束 =====");
    parts.push(
      `major 线程 ≤ max_major_active=${this.config.threads.max_major_active}；` +
        `minor ≤ max_minor_active=${this.config.threads.max_minor_active}；` +
        `活跃伏笔 ≤ max_active=${this.config.setups.max_active}；` +
        `计划 horizon = horizon_checkpoints=${this.config.plan.horizon_checkpoints} 个 checkpoint；` +
        `当前 checkpoint = ${request.memory.checkpointCount}`,
    );

    return parts.join("\n\n");
  }
}
