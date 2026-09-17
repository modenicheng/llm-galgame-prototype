/**
 * 图视图模型（执行清单 M5.1/M5.2）——`GET /api/graph` 的数据形状与装配。
 *
 * 可见性纪律（设计 §4，脱敏）：只返回**已演出**的图内容——场景节点本身
 * 只有 active/realized 两态（§3 schema），但输出额外做三层过滤：
 * ① outlineRef 只在指向 active/realized 的 **act** 时返回（planned/pruned/
 *    ending 一律不出——未来剧情与结局候选不外泄）；
 * ② 决策与边只来自图存储（已落盘的已实现路径，含已弃周目——D7）；
 * ③ outline 全量、ending 候选、prompt 等结构性信息永不进入本视图。
 *
 * D8 分组：场景按其 outline 节点的 `location`（物理地点标签）分组键返回
 * （`groupKey`），前端据此并排分组；组内保持剧情时序（按快照 seq）。
 */

import type { OutlineStorePort } from "../../core/ports/outline-store-port.js";
import type { GraphStorePort } from "../../core/ports/graph-store-port.js";

/** 单个决策节点视图（M5.2 决策粒度；表单快照原样内联）。 */
export interface GraphDecisionView {
  id: string;
  form: {
    mode: string;
    prompt: string;
    options?: string[];
    placeholder?: string;
  };
  /** 当前游标停驻在该决策上（总览高亮）。 */
  isCursor: boolean;
}

/** 单条已实现边视图（选择文本 + 指向；汇流凭据标注改绑）。 */
export interface GraphEdgeView {
  id: string;
  from: string;
  choiceText: string;
  choiceKind: "option" | "free_input";
  to: { kind: "decision"; id: string } | { kind: "ending"; id: string };
  /** 汇流改绑成立过的边（UI 标注「与既有剧情汇流」）。 */
  confluence?: { matchedNode: string; judgedBy: string; confidence: number };
}

/** 单个场景块视图。 */
export interface GraphSceneView {
  sceneId: string;
  /** D8 分组键：outline 物理地点；无大纲/未解析时回退场景模型 id。 */
  groupKey: string;
  status: "active" | "realized";
  /** 剧情时序（按首个决策快照序）。 */
  outlineRef?: string | undefined;
  decisions: GraphDecisionView[];
  outEdges: GraphEdgeView[];
}

/** 周目统计（§9 runs 折叠；不展开周目明细）。 */
export interface GraphRunStats {
  total: number;
  ended: number;
  abandoned: number;
  active: number;
}

export interface GraphView {
  gameId: string;
  /** D8 分组后的场景块（组内剧情时序）。 */
  scenes: GraphSceneView[];
  /** 当前活动游标（无活动周目时缺省）。 */
  cursor?: { runId: string; decisionId: string } | undefined;
  runs: GraphRunStats;
}

export interface GraphViewStores {
  gameId: string;
  graph: GraphStorePort;
  outline?: OutlineStorePort | undefined;
}

/**
 * 装配总览图视图。outline 缺省（种子世界）或未加载成功时 groupKey 回退
 * 场景的模型 id——脱敏纪律优先于分组完整性。
 */
export async function buildGraphView(stores: GraphViewStores): Promise<GraphView> {
  const [decisions, edges, scenes, runs, cursor] = await Promise.all([
    stores.graph.listDecisions(),
    stores.graph.listEdges(),
    stores.graph.listScenes(),
    stores.graph.listRuns(),
    stores.graph.loadCursor(),
  ]);

  // 脱敏白名单：只有 active/realized 的 act 允许以 outlineRef/groupKey 出现。
  const actRefBySceneId = new Map<string, { id: string; location?: string | undefined }>();
  if (stores.outline !== undefined) {
    try {
      const outline = await stores.outline.load();
      const byId = new Map(outline.nodes.map((n) => [n.id, n]));
      for (const scene of scenes) {
        const node = byId.get(scene.outlineRef);
        if (
          node !== undefined &&
          node.kind === "act" &&
          (node.status === "active" || node.status === "realized")
        ) {
          actRefBySceneId.set(scene.id, {
            id: node.id,
            ...(node.location !== undefined ? { location: node.location } : {}),
          });
        }
      }
    } catch {
      // outline 缺失/损坏 → 全部回退模型 id 分组（视图仍可用）。
    }
  }

  const cursorPosition = cursor?.position ?? null;
  const decisionSceneById = new Map(decisions.map((d) => [d.id, d.sceneId]));
  const sceneViews: GraphSceneView[] = [];
  for (const scene of scenes) {
    // listDecisions 保持 append-only 落盘序 = 剧情时序；不再重排。
    const sceneDecisions = decisions.filter((d) => d.sceneId === scene.id);
    if (sceneDecisions.length === 0) continue; // 空场景（惰性创建未落决策）不出图

    const act = actRefBySceneId.get(scene.id);
    const sceneView: GraphSceneView = {
      sceneId: scene.id,
      groupKey: act?.location ?? sceneDecisions[0]!.entryState.storyState.scene.id,
      status: scene.status,
      ...(act !== undefined ? { outlineRef: act.id } : { outlineRef: undefined }),
      decisions: sceneDecisions.map((d) => ({
        id: d.id,
        form: {
          mode: d.form.mode,
          prompt: d.form.prompt,
          ...(d.form.options !== undefined ? { options: d.form.options } : {}),
          ...(d.form.placeholder !== undefined ? { placeholder: d.form.placeholder } : {}),
        },
        isCursor: cursorPosition === d.id,
      })),
      outEdges: edges
        .filter((e) => decisionSceneById.get(e.from) === scene.id)
        .map((e) => ({
          id: e.id,
          from: e.from,
          choiceText: e.choice.text,
          choiceKind: e.choice.kind,
          to: e.to,
          ...(e.confluence !== undefined
            ? {
                confluence: {
                  matchedNode: e.confluence.matchedNode,
                  judgedBy: e.confluence.judgedBy,
                  confidence: e.confluence.confidence,
                },
              }
            : {}),
        })),
    };
    sceneViews.push(sceneView);
  }

  const runStats: GraphRunStats = {
    total: runs.length,
    ended: runs.filter((r) => r.endedAt !== undefined).length,
    abandoned: runs.filter((r) => r.abandonedAt !== undefined).length,
    active: runs.filter((r) => r.endedAt === undefined && r.abandonedAt === undefined).length,
  };

  return {
    gameId: stores.gameId,
    scenes: sceneViews,
    ...(cursor !== null ? { cursor: { runId: cursor.runId, decisionId: cursor.position } } : {}),
    runs: runStats,
  };
}
