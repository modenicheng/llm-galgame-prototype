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
import type { ConfluenceJudgePort } from "../../core/ports/confluence-judge-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { GraphStorePort } from "../../core/ports/graph-store-port.js";
import type { StoredEvent } from "../../schema.js";
import { serializeStoryContext } from "../../story/context-builder.js";

/** 表单模式（与 InteractionPolicy/InteractionFormSnapshot 同口径）。 */
export type FormMode = "choice" | "input" | "hybrid";

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
}

const DIRECTIVE_SYSTEM_PROMPT =
  "你是 GalGame 导演。输入场景信息与既有记忆，输出本场景的演出指令 JSON：" +
  '{sceneGoal, defenseBeats:[string], endingPressure:boolean}。' +
  "sceneGoal ≤120 字；defenseBeats 是针对离谱输入的引回要点（可为空数组）；" +
  "endingPressure 仅在剧情明显接近终章时为 true。只给指令，不写台词。";

interface DirectorServiceOptions {
  runner: AgentRunnerPort;
  store: GraphStorePort;
  /** M4.1 ④：汇流判定员由导演持有装配（bootstrap 接线变化）。 */
  judge?: ConfluenceJudgePort;
  diagnostics?: DiagnosticSink;
}

export class DirectorService {
  private readonly runner: AgentRunnerPort;
  private readonly store: GraphStorePort;
  private readonly judge: ConfluenceJudgePort | undefined;
  private readonly diagnostics: DiagnosticSink;
  /** 场景 id → 本场景 directive（会话内工作态缓存）。 */
  private readonly directives = new Map<string, SceneDirective>();
  private directiveRunning = false;

  constructor(options: DirectorServiceOptions) {
    this.runner = options.runner;
    this.store = options.store;
    this.judge = options.judge;
    this.diagnostics = options.diagnostics ?? silentDiagnosticSink;
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
  }): Promise<SceneDirective> {
    const tools = this.buildTools();
    this.currentDirectiveSceneId = input.sceneId;
    const user = [
      "===== 场景 =====",
      `sceneId: ${input.sceneId}`,
      `目的: ${input.scenePurpose}`,
      "===== 最近剧情摘要 =====",
      input.recentSummary === "" ? "（暂无）" : input.recentSummary,
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
      executeTool: (name, argsJson) => this.executeTool(name, argsJson),
    });
    const parsed = this.parseDirective(text);
    if (parsed !== undefined) {
      if (parsed.sceneGoal !== undefined) {
        directive.sceneGoal = parsed.sceneGoal;
      }
      directive.defenseBeats = parsed.defenseBeats;
      directive.endingPressure = parsed.endingPressure;
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
        const modes = Array.isArray(args.modes) ? (args.modes as string[]) : [];
        const allowed = modes.filter((m): m is FormMode =>
          m === "choice" || m === "input" || m === "hybrid",
        );
        const target = this.currentDirectiveSceneId ?? "";
        this.narrowFormModes(target, allowed);
        return `已收窄 ${target || "(当前场景)"} → [${allowed.join(", ")}]`;
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
      chunks.push(serializeStoryContext(events));
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

  private currentDirectiveSceneId: string | undefined;

  private parseDirective(text: string):
    | { sceneGoal?: string; defenseBeats: string[]; endingPressure: boolean }
    | undefined {
    const match = /\{[\s\S]*\}/.exec(text);
    if (match === null) return undefined;
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const directive: { sceneGoal?: string; defenseBeats: string[]; endingPressure: boolean } = {
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
      return directive;
    } catch {
      return undefined;
    }
  }
}
