/**
 * SceneMusicComposerAdapter — 作曲家 agent（第四 agent）的 LLM 实现（V2）。
 *
 * 单次 chat.completions（response_format json_object）产出复用/新作决策：
 *   {action:"reuse", themeId, reason} | {action:"compose", theme, score, reason}
 * system = 决策契约 + MUSIC_COMPOSITION_SKILL（和声纪律硬约束）+ 复用纪律；
 * messages 前插作曲家持久会话轮次（music/session.jsonl 窗口），本轮 user
 * 携带场景 brief 与全量主题目录。输出过 ComposerDecisionSchema 判别联合
 * 硬校验，失败携带 zod 逐条 issue 修复重试一次，双败返回 null（服务层
 * 告警降级，不抛）。
 *
 * 预算（用户明示放宽）：timeout ≥300s（决策+大谱面 JSON 单次产出）、
 * max_tokens 16000（reuse 决策不写谱面，天然省 token）；thinking 保持
 * disabled（机械 JSON 任务；听感不达标时的第一调参项是开启 thinking）。
 */
import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions.js";
import type { AppConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import {
  MUSIC_INSTRUMENTS,
  MUSIC_MOODS,
} from "../../shared/music/score.js";
import {
  ComposerDecisionSchema,
  type ComposerDecision,
  type ComposerSessionTurn,
  type SceneMusicBrief,
  type ThemeCatalogEntry,
} from "../../shared/music/theme.js";
import type {
  SceneMusicComposerDecisionInput,
  SceneMusicComposerPort,
} from "../../application/audio/scene-music-service.js";
import { MUSIC_COMPOSITION_SKILL } from "./music-composition-skill.js";

const COMPOSER_SYSTEM_PROMPT =
  "你是 GalGame 的驻团作曲家，为一局游戏逐步铸成一张 OST 专辑。输入当前场景的配乐需求" +
  "（brief）与已有主题目录，先决策复用还是新作，输出决策 JSON（二选一）：" +
  '{"action":"reuse","themeId":"<目录中的主题 id>","reason":"..."} 或 ' +
  '{"action":"compose","theme":{"id","title","concept","style?","parentTheme?"},"score":{...},"reason":"..."}。' +
  `\nscore 形状：{version:1, bpm, key, mode, bars, tracks:[{instrument, gain, notes:[{beat, dur, midi, vel}]}]}；` +
  "结构规则：bars 取 16 或 32（4/4）；bpm 50~170；key 是主音半音数（0=C … 11=B）；" +
  "mode 取 major/minor/dorian；instrument 只能取 " +
  `${MUSIC_INSTRUMENTS.join("/")}，每种至多一条轨；全部轨道音符总数 ≤ 500；` +
  "beat 是四分音符起拍（0=循环起点，必须 < bars×4）；dur 0.1~8；vel 1~127；gain 0~1。" +
  "\n复用纪律（决策规则，与作曲质量同等重要）：" +
  "同一地点/同一游戏区域/情境相近的场景必须 reuse——主题是区域的音乐身份，日夜共用；" +
  "mood/intensity 差异不构成新主题的理由（同一主题直接复用）；" +
  "只有导演 note 明示质变（如「堡垒陷落后废墟」相对「堡垒日常」）才建变体主题" +
  "（compose 时填 parentTheme 引用母题，动机以母题 motifHint 为核心变形）；" +
  "全新区域/全新戏剧功能且目录中无可复用主题才 compose 全新主题；" +
  "一局游戏的主题数目标 5~15——宁复用勿滥作。目录为空时必 compose。" +
  "\ntheme 字段：id 是 kebab-case slug（≤40 字符，不得与已有主题重复）；title 是中文" +
  "曲目短名（≤20 字）；concept 一句话主题概念（≤80 字，如「地下堡垒——压抑的机械回响」）；" +
  "style 可选风格短语（≤80 字，可引用风格语汇如「east-asia 五声、bell 前置」）。" +
  "\n只输出 JSON，不输出任何解释或包裹。" +
  `\n\n${MUSIC_COMPOSITION_SKILL}`;

export class SceneMusicComposerAdapter implements SceneMusicComposerPort {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly diagnostics: DiagnosticSink;
  /** 上一次原始输出（修复轮的 assistant 回放）。 */
  private lastRaw = "";

  constructor(
    opts: {
      apiKey: string;
      api: AppConfig["api"];
      diagnostics?: DiagnosticSink;
      client?: OpenAI;
    },
  ) {
    this.client =
      opts.client ??
      new OpenAI({
        apiKey: opts.apiKey,
        ...(opts.api.base_url ? { baseURL: opts.api.base_url } : {}),
        // 作曲家是场景边界的后台任务（fire-and-forget）；决策 + 大谱面
        // JSON 单次产出可达数分钟——用户明示放宽到 ≥300s。
        timeout: Math.max(opts.api.timeout_ms, 300_000),
      });
    this.model = opts.api.model;
    this.diagnostics = opts.diagnostics ?? silentDiagnosticSink;
  }

  async decide(input: SceneMusicComposerDecisionInput): Promise<ComposerDecision | null> {
    const user = this.buildUserMessage(input.brief, input.catalog);
    const history = input.sessionTurns.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));
    let lastIssues = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages:
          attempt === 0
            ? [{ role: "system", content: COMPOSER_SYSTEM_PROMPT }, ...history, { role: "user", content: user }]
            : [
                { role: "system", content: COMPOSER_SYSTEM_PROMPT },
                ...history,
                { role: "user", content: user },
                { role: "assistant", content: this.lastRaw },
                {
                  role: "user",
                  content: `上一次输出未通过契约校验：${lastIssues}。请修正后重新输出完整决策 JSON。`,
                },
              ],
        response_format: { type: "json_object" },
        temperature: 0.8,
        // 机械 JSON 任务禁思考链（BigModel 默认开 thinking 会拖到超时）；
        // 听感不达标时第一调参项是开启 thinking。输出预算给足决策+大谱面。
        max_tokens: 16_000,
        ...(({ thinking: { type: "disabled" } }) as unknown as Record<string, unknown>),
      } as ChatCompletionCreateParamsNonStreaming);
      const raw = response.choices[0]?.message?.content ?? "";
      this.lastRaw = raw;
      const parsed = this.parseDecision(raw);
      if (parsed.ok) return parsed.decision;
      lastIssues = parsed.issues;
      this.diagnostics.warn(
        "SceneMusicComposer",
        `第 ${attempt + 1} 次输出未过契约：${parsed.issues.slice(0, 300)}`,
      );
    }
    return null;
  }

  private parseDecision(
    raw: string,
  ): { ok: true; decision: ComposerDecision } | { ok: false; issues: string } {
    // 模型偶发把 JSON 包进 ```fence``` 或前后加说明——正则截取首个大括号块。
    const match = /\{[\s\S]*\}/.exec(raw);
    if (match === null) {
      return { ok: false, issues: "输出中找不到 JSON 对象" };
    }
    let json: unknown;
    try {
      json = JSON.parse(match[0]);
    } catch (error) {
      return { ok: false, issues: `JSON 解析失败：${String(error)}` };
    }
    const result = ComposerDecisionSchema.safeParse(json);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("；");
      return { ok: false, issues };
    }
    return { ok: true, decision: result.data };
  }

  private buildUserMessage(brief: SceneMusicBrief, catalog: ThemeCatalogEntry[]): string {
    const parts = [
      "===== 当前场景配乐需求（brief） =====",
      `sceneId: ${brief.sceneId}`,
      `场景目标：${brief.sceneGoal ?? "（无）"}`,
      `mood: ${brief.mood}（词表：${MUSIC_MOODS.join("/")}）`,
      `intensity: ${brief.intensity}（1=铺垫 2=主体 3=高潮）`,
      ...(brief.note !== undefined ? [`note: ${brief.note}`] : []),
    ];
    if (catalog.length === 0) {
      parts.push("===== 主题目录（空——必须 compose 首个主题） =====");
    } else {
      parts.push("===== 已有主题目录（复用优先；谱面统计供编配参考） =====");
      for (const entry of catalog) {
        const m = entry.meta;
        const s = entry.stats;
        parts.push(
          `- id=${m.id}《${m.title}》：${m.concept}` +
            (m.style !== undefined ? `｜风格：${m.style}` : "") +
            (m.parentTheme !== undefined ? `｜母题：${m.parentTheme}` : "") +
            (m.motifHint !== undefined ? `｜动机：${m.motifHint}` : "") +
            `｜${s.bpm}bpm ${s.key === 0 ? "C" : ""}mode=${s.mode} bars=${s.bars}` +
            ` 循环${s.loopSeconds.toFixed(0)}s ${s.instruments.join("+")} ${s.noteCount}音`,
        );
      }
    }
    return parts.join("\n");
  }
}
