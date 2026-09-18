/**
 * OutlineWriter adapter（执行清单 M3.2，决议 D1）——单次 JSON 调用。
 * prompt 约束：purpose ≤200 字禁台词、至少 2 act + 1 ending、id 唯一、
 * location 为物理地点标签不写状态细节（决议 D8）。
 */

import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { OUTLINE_PURPOSE_MAX_LENGTH } from "../../core/outline/types.js";
import type { OutlineOp } from "../../core/ports/outline-store-port.js";
import type {
  OutlineMaintainerPort,
  OutlineWriterPort,
  OutlineWriterRequest,
  OutlineMaintenanceRequest,
  WorldDraft,
} from "../../application/outline/outline-writer.js";

const SYSTEM_PROMPT =
  "你是 GalGame 编剧。输入玩家的世界描述，输出开局前的世界设计 JSON：" +
  "{worldSetting, characters:[{id,name,description,spriteBinding?,voice?}], outline:[{id,purpose,kind,status,location?}]}。" +
  "worldSetting 是世界观设定（≤500 字）。characters 2~5 名角色，description ≤200 字。" +
  "voice 是可选的音频画像，为每个有台词的角色设计：{timbre（声音画像一句话，≤60 字：年龄感/质感/音区/口音）, " +
  "delivery:[语气标签，从 restrained/hesitant/firm/gentle/cold/playful/breathless/tearful 中选 2~4 个], " +
  "avoid?:[忌用的同类标签], baseline?:{pace,energy,volume}}；" +
  "pace 取 very_slow/slow/normal/fast/very_fast，energy 取 very_low/low/normal/high/very_high，" +
  "volume 取 whisper/soft/normal/loud。" +
  "outline 是幕级大纲：至少 2 个 kind=act 的幕节点按剧情顺序排列，最后恰好 1~2 个 kind=ending 的结局节点；" +
  "所有节点 status 固定为 planned；id 用 `ol_` 前缀且全局唯一（结局节点 id 以 `ol_end_` 开头）。" +
  "每个 purpose 是节拍目的（不超过 " + OUTLINE_PURPOSE_MAX_LENGTH + " 字），禁止写任何台词。" +
  "location 是物理地点标签（如「教室」「旧校舍」），不写状态细节；同一物理地点的不同幕共享同一 location。";

const VoiceDesignSchema = z.object({
  timbre: z.string().min(1).max(120),
  delivery: z.array(z.string().min(1).max(24)).min(1).max(8),
  avoid: z.exactOptional(z.array(z.string().min(1).max(24)).max(8)),
  baseline: z.exactOptional(
    z
      .object({
        pace: z.exactOptional(z.enum(["very_slow", "slow", "normal", "fast", "very_fast"])),
        energy: z.exactOptional(z.enum(["very_low", "low", "normal", "high", "very_high"])),
        volume: z.exactOptional(z.enum(["whisper", "soft", "normal", "loud"])),
      })
      .strict(),
  ),
}).strict();

const DraftCharacterSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(500),
  spriteBinding: z.exactOptional(z.string().min(1).max(64)),
  voice: z.exactOptional(VoiceDesignSchema),
});

const RawOutlineNodeSchema = z.object({
  id: z.string().min(1).max(64),
  purpose: z.string().min(1).max(OUTLINE_PURPOSE_MAX_LENGTH),
  kind: z.enum(["act", "ending"]),
  status: z.literal("planned"),
  location: z.exactOptional(z.string().min(1).max(64)),
});

const RawWorldDraftSchema = z.object({
  worldSetting: z.string().min(1).max(2000),
  characters: z.array(DraftCharacterSchema).min(1).max(8),
  outline: z
    .array(RawOutlineNodeSchema)
    .min(3)
    .max(12)
    .refine(
      (nodes) => nodes.some((n) => n.kind === "act"),
      { message: "至少 1 个 act 节点" },
    )
    .refine(
      (nodes) => {
        const endings = nodes.filter((n) => n.kind === "ending");
        return endings.length >= 1 && endings.length <= 2;
      },
      { message: "ending 节点须为 1~2 个" },
    )
    .refine(
      (nodes) => new Set(nodes.map((n) => n.id)).size === nodes.length,
      { message: "节点 id 必须唯一" },
    )
    .refine(
      (nodes) => nodes.every((n) => (n.kind === "ending" ? n.id.startsWith("ol_end_") : true)),
      { message: "结局节点 id 须以 ol_end_ 开头" },
    ),
});
export class OutlineWriterAdapter implements OutlineWriterPort, OutlineMaintainerPort {
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

  async writeOutline(request: OutlineWriterRequest): Promise<WorldDraft> {
    const userMessage = this.buildUserMessage(request);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    });

    const rawContent = response.choices[0]?.message?.content ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      this.diagnostics.warn(
        "OutlineWriter",
        `JSON 解析失败：${rawContent.slice(0, 200)}`,
      );
      throw new Error("outline 输出解析失败");
    }

    const schemaResult = RawWorldDraftSchema.safeParse(parsed);
    if (!schemaResult.success) {
      this.diagnostics.warn(
        "OutlineWriter",
        `输出校验失败：${schemaResult.error.message}`,
      );
      throw new Error("outline 输出解析失败");
    }

    const data = schemaResult.data;
    return {
      worldSetting: data.worldSetting,
      characters: data.characters,
      // 契约类型与 raw schema 字段一致（status 恒 planned），直接投影。
      outline: data.outline.map((node) => ({ ...node })),
    };
  }

  private buildUserMessage(request: OutlineWriterRequest): string {
    const parts: string[] = ["===== 世界描述 =====", request.userText];
    if (request.seedStoryLine !== undefined && request.seedStoryLine !== "") {
      parts.push("===== 故事主线种子（附加约束） =====");
      parts.push(request.seedStoryLine);
    }
    return parts.join("\n\n");
  }

  // -------------------------------------------------------------------------
  // M3.4 后台维护：单次 JSON 调用产出候选 OutlineOp[]（只允许 add/planned
  // 与 prune）。activate/realize 为协调器确定性迁移独占，这里产出即忽略。
  // -------------------------------------------------------------------------

  private static readonly MAINTENANCE_SYSTEM_PROMPT =
    "你是大纲维护器。输入当前大纲、最近剧情摘要与记忆摘要，输出结构修订 JSON：" +
    '{ops:[{type:"add",node:{id,purpose,kind,status,location?}}|{type:"prune",id}]}。' +
    "add 只允许 status=planned 的新幕节点（id 用 ol_ 前缀且不得与现有节点重复，purpose 不超过 " +
    OUTLINE_PURPOSE_MAX_LENGTH + " 字）；prune 只允许剪除尚未实例化的 planned/active 节点。" +
    "不得输出 activate/realize；没有需要的修订时输出空 ops。";

  async maintainOutline(request: OutlineMaintenanceRequest): Promise<OutlineOp[]> {
    const parts: string[] = ["===== 当前大纲 ====="];
    for (const node of request.outline) {
      parts.push(
        `- ${node.id}（${node.kind}，${node.status}${node.instantiatedBy !== undefined ? "，已实例化" : ""}）：${node.purpose}`,
      );
    }
    parts.push("===== 最近剧情摘要 =====");
    parts.push(request.recentSummary === "" ? "（暂无）" : request.recentSummary);
    parts.push("===== 记忆摘要 =====");
    parts.push(
      `revision ${request.memoryDigest.revision}；threads：${
        request.memoryDigest.threads.map((t) => `${t.id}(${t.status})`).join("、") || "无"
      }`,
    );
    if (request.canon !== undefined) {
      parts.push("===== 世界既定（canon，维护不得与之矛盾）=====");
      if (request.canon.promotedFacts.length === 0) {
        parts.push("（暂无晋升事实）");
      } else {
        for (const fact of request.canon.promotedFacts.slice(0, 20)) {
          parts.push(`- ${fact.content}`);
        }
      }
      for (const e of request.canon.exceptions.slice(0, 10)) {
        parts.push(`- 例外：${e.content}（限制：${e.compensatingLimit}）`);
      }
    }
    if (request.reviews !== undefined && request.reviews.length > 0) {
      parts.push("===== 历史通关评注（M5.5 评价喂回）=====");
      for (const review of request.reviews.slice(-5)) {
        parts.push(`- ★${review.rating}：${review.comment}（贴合度：${review.outlineFit}）`);
      }
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: OutlineWriterAdapter.MAINTENANCE_SYSTEM_PROMPT },
        { role: "user", content: parts.join("\n\n") },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
    });

    const rawContent = response.choices[0]?.message?.content ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      throw new Error("outline 维护输出解析失败");
    }
    const checked = RawMaintenanceOpsSchema.safeParse(parsed);
    if (!checked.success) {
      throw new Error("outline 维护输出解析失败");
    }
    return checked.data.ops.map((op) => op as OutlineOp);
  }
}

const RawMaintenanceAddSchema = z.object({
  type: z.literal("add"),
  node: z.object({
    id: z.string().min(1).max(64),
    purpose: z.string().min(1).max(OUTLINE_PURPOSE_MAX_LENGTH),
    kind: z.enum(["act", "ending"]),
    status: z.literal("planned"),
    location: z.exactOptional(z.string().min(1).max(64)),
  }),
});
const RawMaintenancePruneSchema = z.object({
  type: z.literal("prune"),
  id: z.string().min(1),
});
const RawMaintenanceOpsSchema = z.object({
  ops: z.array(z.discriminatedUnion("type", [RawMaintenanceAddSchema, RawMaintenancePruneSchema])),
});
