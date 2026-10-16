/**
 * SceneMusicComposerAdapter — 作曲端口的一次性 JSON LLM 实现。
 *
 * 单次 chat.completions（response_format json_object）；输出过
 * MusicScoreSchema 硬校验，失败携带 zod 逐条 issue 修复重试一次，
 * 双败返回 null（服务层告警降级，不抛）。词表/音域/结构约束全部来自
 * shared/music/score.ts 运行时常量插值（表演词汇表同模式，单一真源）。
 */
import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions.js";
import type { AppConfig } from "../../config.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import {
  MUSIC_INSTRUMENTS,
  MUSIC_MOODS,
  MusicScoreSchema,
  type MusicScore,
} from "../../shared/music/score.js";
import type {
  SceneMusicComposeRequest,
  SceneMusicComposerPort,
} from "../../application/audio/scene-music-service.js";

const COMPOSER_SYSTEM_PROMPT =
  "你是 GalGame 场景配乐作曲家。输入导演的音乐指导，输出一段可无缝循环的场景配乐符号谱 JSON：" +
  "{version:1, bpm, key, mode, bars, tracks:[{instrument, gain, notes:[{beat, dur, midi, vel}]}]}。" +
  "结构规则：version 恒为 1；bars 取 16 或 32（4/4 拍）；bpm 50~170；" +
  "key 是主音半音数（0=C … 11=B）；mode 取 major（明亮）/minor（阴郁紧张）/dorian（古朴神秘）；" +
  `tracks 2~4 条，instrument 只能取 ${MUSIC_INSTRUMENTS.join("/")}，每种至多一条：` +
  "bass=低音根基（midi 33~52，落在拍点）；piano/strings=和声与旋律主体（midi 55~84）；" +
  "pad/choir=长音铺底（midi 48~72）；bell=高音点缀（midi 72~96，少量）。" +
  "beat 是以四分音符为单位的起拍（0=循环起点，必须 < bars×4）；dur 是时值（拍，0.1~8）；" +
  "vel 1~127（旋律强、铺底弱）；gain 是轨道音量 0~1；全部轨道音符总数 ≤ 500。" +
  "作曲要领：先定 2~4 个和弦的循环进行（如大调 I-V-vi-IV、小调 i-VI-III-VII），" +
  "bass 走和弦根音，pad/choir 按和弦叠长音，piano/strings 在和弦音上写旋律动机；" +
  "旋律动机 2~4 小节，重复一次后变化再现（移位/换尾），不要通篇无重复的新音；" +
  "最后 1~2 小节和声回到主和弦（或停在属和弦悬置），让循环回到开头自然；" +
  "intensity 1=少轨道稀疏音符（pad+bass+单旋律），2=标准三轨，3=全轨饱满加花；" +
  "mood 参考：daily 大调轻钢琴；warm 大调 strings+pad；tense 小调快 bpm、bass 每拍；" +
  "sorrowful 小调慢 bpm 钢琴分解；mysterious dorian bell+choir；hopeful 大调渐开；climax 全轨推进。" +
  "只输出 JSON，不输出任何解释或包裹。";

export class SceneMusicComposerAdapter implements SceneMusicComposerPort {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly diagnostics: DiagnosticSink;

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
        // 作曲是场景边界的后台任务（fire-and-forget，不阻塞演出），
        // 大谱面 JSON 生成可达 ~1 分钟——给比写手管线宽的超时。
        timeout: Math.max(opts.api.timeout_ms, 120_000),
      });
    this.model = opts.api.model;
    this.diagnostics = opts.diagnostics ?? silentDiagnosticSink;
  }

  async compose(request: SceneMusicComposeRequest): Promise<MusicScore | null> {
    const user = this.buildUserMessage(request);
    let lastIssues = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages:
          attempt === 0
            ? [
                { role: "system", content: COMPOSER_SYSTEM_PROMPT },
                { role: "user", content: user },
              ]
            : [
                { role: "system", content: COMPOSER_SYSTEM_PROMPT },
                { role: "user", content: user },
                { role: "assistant", content: this.lastRaw },
                {
                  role: "user",
                  content: `上一次输出未通过契约校验：${lastIssues}。请修正后重新输出完整 JSON。`,
                },
              ],
        response_format: { type: "json_object" },
        temperature: 0.8,
        // 作曲是机械 JSON 任务，禁思考链（BigModel 默认开 thinking，
        // 大谱面会拖到超时）；输出预算给足 500 音符的 JSON 体量。
        max_tokens: 8000,
        ...(({ thinking: { type: "disabled" } }) as unknown as Record<string, unknown>),
      } as ChatCompletionCreateParamsNonStreaming);
      const raw = response.choices[0]?.message?.content ?? "";
      this.lastRaw = raw;
      const parsed = this.parseScore(raw);
      if (parsed.ok) return parsed.score;
      lastIssues = parsed.issues;
      this.diagnostics.warn(
        "SceneMusicComposer",
        `第 ${attempt + 1} 次输出未过契约：${parsed.issues.slice(0, 300)}`,
      );
    }
    return null;
  }

  /** 上一次原始输出（修复轮的 assistant 回放）。 */
  private lastRaw = "";

  private parseScore(
    raw: string,
  ): { ok: true; score: MusicScore } | { ok: false; issues: string } {
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
    const result = MusicScoreSchema.safeParse(json);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("；");
      return { ok: false, issues };
    }
    return { ok: true, score: result.data };
  }

  private buildUserMessage(request: SceneMusicComposeRequest): string {
    const direction = request.direction;
    const parts = [
      "===== 场景 =====",
      `sceneId: ${request.sceneId}`,
      `目标：${request.sceneGoal ?? "（无）"}`,
      "===== 音乐指导 =====",
      `mood: ${direction.mood}（词表：${MUSIC_MOODS.join("/")}）`,
      `intensity: ${direction.intensity}`,
    ];
    if (direction.note !== undefined) {
      parts.push(`note: ${direction.note}`);
    }
    return parts.join("\n");
  }
}
