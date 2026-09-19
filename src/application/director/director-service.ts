/**
 * 导演服务（执行清单 M4.1，决议 D1/D7）——工具循环骨架 + 首批确定性工具。
 *
 * 触发：场景边界（场景首个决策落成 / checkpoint）异步 fire-and-forget +
 * 诊断告警，绝不阻塞演出（实时性红线）。导演产出 `SceneDirective`（场景
 * 目标/防守节拍/收束压力/表单收窄），会话内工作态缓存，不入图契约。
 *
 * 工具（确定性，M4.1 首批）：
 * - readSceneHistory(sceneId)：边负载回放投影（复用 context-builder 序列化）；
 *   返回该场景全部已实现边（含已弃周目，决议 D7——NG+ 前世记忆取材来源）。
 * - queryCharacterState(characterId)：场景决策入口快照里的最新角色状态。
 * - narrowFormModes(modes)：相位门 → InteractionPolicy.allowed_modes 收窄。
 *
 * 汇流判定承接（M4.1 ④）：ConfluenceJudgePort 的持有装配移入导演；
 * 协调器调度机制不变（bootstrap 把 director.exposeConfluenceJudge() 传给
 * coordinator options.judge）。
 */

import type { AppConfig } from "../../config.js";
import type { AgentRunnerPort, AgentTool } from "../../core/ports/agent-runner-port.js";
import type { CanonStorePort } from "../../core/ports/canon-store-port.js";
import type { ConfluenceJudgePort } from "../../core/ports/confluence-judge-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { GraphStorePort } from "../../core/ports/graph-store-port.js";
import type { OutlineStorePort } from "../../core/ports/outline-store-port.js";
import type { StoredEvent } from "../../schema.js";
import {
  DELIVERY_TAGS,
  ENERGY_VALUES,
  PACE_VALUES,
  VOLUME_VALUES,
  type VoiceDirectionTarget,
} from "../audio/performance-compiler.js";
// C5：导演观察窗沿用冻结的 legacy 渲染（受控身份视图的投影接入归后续
// 任务；本文件不在 C5 文件清单内）。
import { serializeStoryContextLegacy } from "../../story/context-builder.js";

/** 表单模式（与 InteractionPolicy/InteractionFormSnapshot 同口径）。 */
export type FormMode = "choice" | "input" | "hybrid";

/** 在场角色的音频调色板（供导演发 voice 指导时对齐词汇）。 */
export interface SpeakerVoicePalette {
  allowedDelivery?: string[];
  forbiddenDelivery?: string[];
}

/** 导演产出（M4.1 ③）：会话内工作态，不入图契约。 */
export interface SceneDirective {
  sceneId: string;
  /** 本场景目标（一段话）。 */
  sceneGoal?: string;
  /** 防守节拍（M4.3）：离谱输入引回指令。 */
  defenseBeats: string[];
  /** 收束压力（M3.5）：true 时提示演员向结局推进。 */
  endingPressure: boolean;
  /** 相位门：allowed_modes 收窄（缺省 = 不收窄）。 */
  formModes?: FormMode[];
  /**
   * 角色音频指导（角色音频特征设计 §3.2，V1）：说话人 id → 指导。
   * 由音频管线按行查询（VoiceDirectionHub），经编译器进缓存键。
   */
  voice?: Record<string, VoiceDirectionTarget>;
}

// 词表段从 performance-compiler 运行时常量拼接（单一真源，防手抄漂移）。
const DIRECTIVE_SYSTEM_PROMPT =
  "你是 GalGame 导演。输入场景信息与既有记忆，输出本场景的演出指令 JSON：" +
  '{sceneGoal, defenseBeats:[string], endingPressure:boolean, voice?}。' +
  "sceneGoal ≤120 字；defenseBeats 是针对离谱输入的引回要点（可为空数组）；" +
  "endingPressure 仅在剧情明显接近终章时为 true。" +
  "voice 是可选的角色音频指导，仅当场景状态要求声音变化时给出，形如 " +
  '{"角色id":{"delivery":"breathless","volume":"whisper","note":"夜谈压低声音"}}；' +
  `delivery 只能取 ${DELIVERY_TAGS.join("/")} 之一，` +
  `volume 只能取 ${VOLUME_VALUES.join("/")}，` +
  `pace 只能取 ${PACE_VALUES.join("/")}，` +
  `energy 只能取 ${ENERGY_VALUES.join("/")}，` +
  "note ≤40 字。只给指令，不写台词。";

interface DirectorServiceOptions {
  runner: AgentRunnerPort;
  store: GraphStorePort;
  /** M4.1 ④：汇流判定员由导演持有装配（bootstrap 接线变化）。 */
  judge?: ConfluenceJudgePort;
  /** M3.5 ①：大纲读取（ending 候选 → 确定性收束压力）。导演可见、演员不可见。 */
  outline?: OutlineStorePort;
  /** M3.6 ③：canon 读取（晋升事实进导演输入）。导演可见、演员不可见。 */
  canon?: CanonStorePort;
  /**
   * 角色音频调色板查询（角色音频特征设计 V1）：按说话人取 allowed/forbidden
   * 语气（author semantic 或 per-game 设计）；缺省 = 不渲染调色板段。
   */
  speakerPalette?: (characterId: string) => SpeakerVoicePalette | undefined;
  diagnostics?: DiagnosticSink;
}

/** Game 依赖的最小导演面（相位门/防守节拍/剪报输入），结构化便于注入。 */
export type SceneDirectorPort = Pick<
  DirectorService,
  "getDirective" | "evaluateFreeInput" | "narrowFormModes" | "triggerDirective"
>;

export class DirectorService {
  private readonly runner: AgentRunnerPort;
  private readonly store: GraphStorePort;
  private readonly judge: ConfluenceJudgePort | undefined;
  private readonly outline: OutlineStorePort | undefined;
  private readonly canon: CanonStorePort | undefined;
  private readonly speakerPalette:
    | ((characterId: string) => SpeakerVoicePalette | undefined)
    | undefined;
  private readonly diagnostics: DiagnosticSink;
  /** 场景 id → 本场景 directive（会话内工作态缓存）。 */
  private readonly directives = new Map<string, SceneDirective>();
  private directiveRunning = false;

  constructor(options: DirectorServiceOptions) {
    this.runner = options.runner;
    this.store = options.store;
    this.judge = options.judge;
    this.outline = options.outline;
    this.canon = options.canon;
    this.speakerPalette = options.speakerPalette;
    this.diagnostics = options.diagnostics ?? silentDiagnosticSink;
    // M3.6 ③：canon 后台预热（fire-and-forget；未就绪时导演输入无 canon 段）。
    void this.canon?.load().catch((err: unknown) => {
      this.diagnostics.warn("DirectorService", `canon load failed: ${String(err)}`);
    });
  }

  /** M4.1 ④：协调器调度机制零改动——判定员实例由导演持有并交出。 */
  exposeConfluenceJudge(): ConfluenceJudgePort | undefined {
    return this.judge;
  }

  getDirective(sceneId: string): SceneDirective | undefined {
    return this.directives.get(sceneId);
  }

  /**
   * 场景边界触发（fire-and-forget 入口）：跑工具循环产出 SceneDirective
   * 并落缓存。失败只告警——演出永远不等导演。
   */
  async refreshDirective(input: {
    sceneId: string;
    scenePurpose: string;
    recentSummary: string;
    /** 在场角色 id（场景状态键集），用于渲染音频调色板段。 */
    cast?: string[];
  }): Promise<SceneDirective> {
    const tools = this.buildTools();
    // M4.3 相位门工具的 sceneId 经闭包绑定（修复共享可变字段的并发问题）。
    const executeTool = (name: string, argsJson: string): Promise<string> =>
      name === "narrowFormModes"
        ? this.executeNarrowFormModes(input.sceneId, argsJson)
        : this.executeTool(name, argsJson);
    const canonSection = this.renderCanonSection();
    const voicePaletteSection = this.renderVoicePaletteSection(input.cast);
    const user = [
      "===== 场景 =====",
      `sceneId: ${input.sceneId}`,
      `目的: ${input.scenePurpose}`,
      "===== 最近剧情摘要 =====",
      input.recentSummary === "" ? "（暂无）" : input.recentSummary,
      ...(voicePaletteSection !== undefined ? [voicePaletteSection] : []),
      ...(canonSection !== undefined ? [canonSection] : []),
    ].join("\n");

    const directive: SceneDirective = {
      sceneId: input.sceneId,
      defenseBeats: [],
      endingPressure: false,
    };
    const { text } = await this.runner.runLoop({
      system: DIRECTIVE_SYSTEM_PROMPT,
      user,
      tools,
      executeTool,
    });
    const parsed = this.parseDirective(text);
    // M3.5 ①：收束压力取「模型判定 ∨ 大纲确定性信号」——大纲信号是充分
    // 条件，模型判定保留（提前收束的演出自由度）；演员只见方向性指令，
    // 不见结局候选本身（§5.2 防火墙）。
    directive.endingPressure =
      (parsed !== undefined && parsed.endingPressure) || this.computeOutlineEndingPressure();
    if (parsed !== undefined) {
      if (parsed.sceneGoal !== undefined) {
        directive.sceneGoal = parsed.sceneGoal;
      }
      directive.defenseBeats = parsed.defenseBeats;
      if (parsed.voice !== undefined) {
        directive.voice = parsed.voice;
      }
    }
    // narrowFormModes 的结果不覆盖——相位门是显式工具调用，先于最终文本落缓存。
    const previous = this.directives.get(input.sceneId);
    if (previous?.formModes !== undefined) {
      directive.formModes = previous.formModes;
    }
    this.directives.set(input.sceneId, directive);
    return directive;
  }

  /** 场景边界异步触发入口（调用方 void 掉；失败告警不阻塞）。 */
  triggerDirective(input: {
    sceneId: string;
    scenePurpose: string;
    recentSummary: string;
    cast?: string[];
  }): void {
    if (this.directiveRunning) return;
    this.directiveRunning = true;
    void this.refreshDirective(input)
      .catch((err: unknown) => {
        this.diagnostics.warn("DirectorService", `directive failed: ${String(err)}`);
      })
      .finally(() => {
        this.directiveRunning = false;
      });
  }

  /** 相位门工具闭包：绑定场景 id 的 narrowFormModes（M4.3）。 */
  private executeNarrowFormModes(sceneId: string, argsJson: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      return Promise.resolve("工具参数不是合法 JSON");
    }
    const modes = Array.isArray(args.modes) ? (args.modes as string[]) : [];
    const allowed = modes.filter((m): m is FormMode =>
      m === "choice" || m === "input" || m === "hybrid",
    );
    this.narrowFormModes(sceneId, allowed);
    return Promise.resolve(`已收窄 ${sceneId} → [${allowed.join(", ")}]`);
  }

  /**
   * 在场角色音频调色板段（角色音频特征设计 V1）：只列有调色板数据的角色；
   * 无查询器/无在场角色/全员无数据 → 省略整段。
   */
  private renderVoicePaletteSection(cast: string[] | undefined): string | undefined {
    if (this.speakerPalette === undefined || cast === undefined || cast.length === 0) {
      return undefined;
    }
    const lines: string[] = [];
    for (const id of cast) {
      const palette = this.speakerPalette(id);
      if (palette === undefined) continue;
      const allowed = palette.allowedDelivery ?? [];
      const forbidden = palette.forbiddenDelivery ?? [];
      if (allowed.length === 0 && forbidden.length === 0) continue;
      const parts = [`- ${id}`];
      if (allowed.length > 0) parts.push(`语气可用 [${allowed.join(", ")}]`);
      if (forbidden.length > 0) parts.push(`忌用 [${forbidden.join(", ")}]`);
      lines.push(parts.join("："));
    }
    return lines.length > 0 ? ["===== 在场角色音频调色板 =====", ...lines].join("\n") : undefined;
  }

  /**
   * M3.6 ③：canon 段（导演可见、演员不可见）。晋升事实是跨周目世界真相，
   * 供导演校准场景目标；未加载/为空时省略整段。上限 20 条，保 prompt 有界。
   */
  private renderCanonSection(): string | undefined {
    if (this.canon === undefined) return undefined;
    let snap;
    try {
      snap = this.canon.getCanon();
    } catch (err: unknown) {
      this.diagnostics.warn("DirectorService", `canon read skipped: ${String(err)}`);
      return undefined;
    }
    const lines: string[] = [];
    if (snap.promotedFacts.length > 0) {
      lines.push("===== 世界既定（canon）=====");
      for (const fact of snap.promotedFacts.slice(0, 20)) {
        lines.push(`- ${fact.content}`);
      }
    }
    if (snap.exceptions.length > 0) {
      if (lines.length === 0) lines.push("===== 世界既定（canon）=====");
      for (const e of snap.exceptions.slice(0, 10)) {
        lines.push(`- 例外：${e.content}（限制：${e.compensatingLimit}）`);
      }
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  /**
   * M3.5 ①：大纲确定性收束压力（同步内存读，零 await）。
   * - 维护调用判定进入终章：存在非 pruned 的 ending 候选已被 activate/realize；
   * - 前沿 act 全部 realized 且至少还有一个 ending 候选可达成。
   * 大纲未加载（协调器尚未 load）/读取失败 → false 只告警，绝不阻塞导演。
   */
  private computeOutlineEndingPressure(): boolean {
    if (this.outline === undefined) return false;
    let nodes;
    try {
      nodes = this.outline.getOutline().nodes;
    } catch (err: unknown) {
      this.diagnostics.warn(
        "DirectorService",
        `outline ending pressure read skipped: ${String(err)}`,
      );
      return false;
    }
    const live = nodes.filter((n) => n.status !== "pruned");
    const acts = live.filter((n) => n.kind === "act");
    const endings = live.filter((n) => n.kind === "ending");
    if (endings.some((n) => n.status === "active" || n.status === "realized")) return true;
    return acts.length > 0 && acts.every((n) => n.status === "realized") && endings.length > 0;
  }

  /** 相位门工具：显式收窄某场景的 allowed_modes（M4.3 接 InteractionPolicy）。 */
  narrowFormModes(sceneId: string, modes: FormMode[]): void {
    const previous = this.directives.get(sceneId);
    const directive: SceneDirective = previous ?? {
      sceneId,
      defenseBeats: [],
      endingPressure: false,
    };
    directive.formModes = [...modes];
    this.directives.set(sceneId, directive);
  }

  /**
   * M4.3 防守节拍评估：free_input 解决后异步评估玩家输入 vs 当前场景目标。
   * 产出 DefenseBeat 追加进该场景 directive 的 defenseBeats——滞后一拍是
   * 有意行为：本段按既有 directive 播出，引回作用于下一段（不阻塞生成）。
   */
  async evaluateFreeInput(input: {
    sceneId: string;
    scenePurpose: string;
    playerInput: string;
    recentSummary: string;
  }): Promise<string> {
    const directive = this.directives.get(input.sceneId);
    const { text } = await this.runner.runLoop({
      system:
        "你是 GalGame 导演。玩家刚给出一段自由输入。评估它与当前场景目标的关系：" +
        "若输入离题/离谱，给一条引回要点（一句话，不含台词）；若贴合场景，给一句顺势推进的要点。" +
        '输出 JSON：{"beat":"..."}。',
      user: [
        "===== 场景目标 =====",
        directive?.sceneGoal ?? input.scenePurpose,
        "===== 玩家输入 =====",
        input.playerInput,
        "===== 最近剧情摘要 =====",
        input.recentSummary === "" ? "（暂无）" : input.recentSummary,
      ].join("\n\n"),
      tools: this.buildTools(),
      executeTool: (name, argsJson) => this.executeTool(name, argsJson),
    });
    const match = /\{[\s\S]*\}/.exec(text);
    let beat = text.trim();
    if (match !== null) {
      try {
        const parsed = JSON.parse(match[0]) as { beat?: unknown };
        if (typeof parsed.beat === "string" && parsed.beat.length > 0) {
          beat = parsed.beat;
        }
      } catch {
        // 非 JSON → 原样取文本
      }
    }
    beat = beat.slice(0, 120);
    const current = this.directives.get(input.sceneId) ?? {
      sceneId: input.sceneId,
      defenseBeats: [],
      endingPressure: false,
    };
    current.defenseBeats = [...current.defenseBeats, beat].slice(-3);
    this.directives.set(input.sceneId, current);
    return beat;
  }

  // -------------------------------------------------------------------------
  // 确定性工具（M4.1 ②）
  // -------------------------------------------------------------------------

  private buildTools(): AgentTool[] {
    return [
      {
        name: "readSceneHistory",
        description:
          "读取指定场景（modelSceneId）的全部已实现剧情（含已弃周目）。返回逐行文本。",
        parameters: {
          type: "object",
          properties: { sceneId: { type: "string", description: "模型场景 id" } },
          required: ["sceneId"],
        },
      },
      {
        name: "queryCharacterState",
        description: "查询角色当前状态（最近决策入口快照）。返回 JSON 或「未知角色」。",
        parameters: {
          type: "object",
          properties: { characterId: { type: "string" } },
          required: ["characterId"],
        },
      },
      {
        name: "narrowFormModes",
        description: "收窄本场景允许的交互表单模式（相位门）。",
        parameters: {
          type: "object",
          properties: {
            modes: { type: "array", items: { type: "string", enum: ["choice", "input", "hybrid"] } },
          },
          required: ["modes"],
        },
      },
    ];
  }

  private async executeTool(name: string, argsJson: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      return "工具参数不是合法 JSON";
    }
    switch (name) {
      case "readSceneHistory": {
        const sceneId = String(args.sceneId ?? "");
        return this.readSceneHistory(sceneId);
      }
      case "queryCharacterState": {
        const characterId = String(args.characterId ?? "");
        return this.queryCharacterState(characterId);
      }
      case "narrowFormModes": {
        // 该工具由 refreshDirective 的闭包 executeTool 拦截处理（绑定场景）；
        // 此分支只对非指令循环调用方（防御性）返回提示。
        return `narrowFormModes 需绑定场景（由 refreshDirective 闭包处理）`;
      }
      default:
        return `未知工具：${name}`;
    }
  }

  /** 场景全部已实现边（D7：不分周目）的负载回放投影。 */
  async readSceneHistory(modelSceneId: string): Promise<string> {
    const decisions = await this.store.listDecisions();
    const sceneDecisions = decisions.filter(
      (d) => d.entryState.storyState.scene.id === modelSceneId,
    );
    if (sceneDecisions.length === 0) return "（该场景暂无已实现剧情）";
    const sceneIds = new Set(sceneDecisions.map((d) => d.sceneId));
    const edges = (await this.store.listEdges()).filter(
      (edge) =>
        sceneIds.has(edge.from) ||
        (edge.to.kind === "decision" && sceneIds.has(edge.to.id)),
    );
    const chunks: string[] = [];
    for (const edge of edges) {
      let events: StoredEvent[];
      try {
        events = await this.store.readPayload(edge.id);
      } catch {
        continue;
      }
      if (events.length === 0) continue;
      chunks.push(serializeStoryContextLegacy(events));
    }
    return chunks.length === 0 ? "（该场景暂无已实现剧情）" : chunks.join("\n");
  }

  /** 最近决策入口快照里的角色状态（无记录 → 未知角色）。 */
  async queryCharacterState(characterId: string): Promise<string> {
    const decisions = await this.store.listDecisions();
    for (const decision of [...decisions].reverse()) {
      const character = decision.entryState.storyState.characters[characterId];
      if (character !== undefined) {
        return JSON.stringify({ characterId, ...character });
      }
    }
    return JSON.stringify({ characterId, known: false });
  }

  private parseDirective(text: string): ParsedDirective | undefined {
    const match = /\{[\s\S]*\}/.exec(text);
    if (match === null) return undefined;
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const directive: ParsedDirective = {
        defenseBeats: [],
        endingPressure: parsed.endingPressure === true,
      };
      if (typeof parsed.sceneGoal === "string" && parsed.sceneGoal.length > 0) {
        directive.sceneGoal = parsed.sceneGoal;
      }
      if (Array.isArray(parsed.defenseBeats)) {
        directive.defenseBeats = parsed.defenseBeats
          .filter((b): b is string => typeof b === "string")
          .slice(0, 5);
      }
      const voice = parseVoiceDirections(parsed.voice);
      if (voice !== undefined) {
        directive.voice = voice;
      }
      return directive;
    } catch {
      return undefined;
    }
  }
}

/** 模型指令 JSON 的校验产物（voice 已过词表校验）。 */
interface ParsedDirective {
  sceneGoal?: string;
  defenseBeats: string[];
  endingPressure: boolean;
  voice?: Record<string, VoiceDirectionTarget>;
}

/** 枚举字段校验：字符串命中词表则收窄返回，否则 undefined（丢弃该字段）。 */
function pickEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * voice 段解析（角色音频特征设计 §3.2）：逐条目校验词表（越界字段丢弃）、
 * note 截 40 字；空目标/空表 → undefined。确定性——相同输入相同输出。
 */
function parseVoiceDirections(
  raw: unknown,
): Record<string, VoiceDirectionTarget> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, VoiceDirectionTarget> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const target: VoiceDirectionTarget = {};
    const delivery = pickEnum(v.delivery, DELIVERY_TAGS);
    if (delivery !== undefined) target.delivery = delivery;
    const pace = pickEnum(v.pace, PACE_VALUES);
    if (pace !== undefined) target.pace = pace;
    const energy = pickEnum(v.energy, ENERGY_VALUES);
    if (energy !== undefined) target.energy = energy;
    const volume = pickEnum(v.volume, VOLUME_VALUES);
    if (volume !== undefined) target.volume = volume;
    if (typeof v.note === "string") {
      const note = v.note.trim().slice(0, 40);
      if (note !== "") target.note = note;
    }
    if (Object.keys(target).length > 0) {
      out[id.slice(0, 64)] = target;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
