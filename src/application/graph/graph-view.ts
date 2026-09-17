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
import type { StatsStorePort } from "../../core/ports/stats-store-port.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
  /**
   * M5.5 ③：大纲回顾（通关后解锁）——路径触及的 outline act（按 location
   * 分组）与已达成结局。未通关（无已结算周目）时不返回该字段。
   */
  outlineReview?: {
    acts: Array<{ id: string; location?: string | undefined; status: string; purpose: string }>;
    endings: Array<{ id: string; label: string; count: number }>;
  } | undefined;
}

export interface GraphViewStores {
  gameId: string;
  graph: GraphStorePort;
  outline?: OutlineStorePort | undefined;
  /** M5.5 ③：通关解锁（settledRuns ≥ 1 时返回大纲回顾）。 */
  stats?: StatsStorePort | undefined;
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

  // M5.5 ③：大纲回顾——通关（有已结算周目）才解锁；未通关绝不返回。
  let outlineReview: GraphView["outlineReview"];
  if (stores.stats !== undefined && stores.outline !== undefined) {
    try {
      const statsSnap = await stores.stats.load();
      if (statsSnap.settledRuns.length > 0) {
        const { nodes } = await stores.outline.load();
        const acts = nodes
          .filter((n) => n.kind === "act" && (n.status === "active" || n.status === "realized"))
          .map((n) => ({
            id: n.id,
            ...(n.location !== undefined ? { location: n.location } : {}),
            status: n.status,
            purpose: n.purpose,
          }));
        const endings = statsSnap.endings.map((e) => ({
          id: e.id,
          label: e.id.replace(/^end_/, ""),
          count: e.count,
        }));
        outlineReview = { acts, endings };
      }
    } catch {
      outlineReview = undefined;
    }
  }

  return {
    gameId: stores.gameId,
    scenes: sceneViews,
    ...(cursor !== null ? { cursor: { runId: cursor.runId, decisionId: cursor.position } } : {}),
    runs: runStats,
    ...(outlineReview !== undefined ? { outlineReview } : {}),
  };
}

// ---------------------------------------------------------------------------
// 结算与图鉴（执行清单 M5.4 ②③）
// ---------------------------------------------------------------------------

/** 结算视图：最新完结周目的结局文本 + 伏笔回收率 + 大纲完成度 + 统计。 */
export interface SettlementView {
  gameId: string;
  runId: string;
  endingId: string;
  endingText: string | null;
  /** 伏笔回收率（ending-report 聚合；会话报告缺失时缺省）。 */
  payoffRate?: number | undefined;
  /** 大纲完成度：realized act / 总 act（无大纲为 undefined）。 */
  outlineProgress?: { realized: number; total: number } | undefined;
  /** 世界级统计（本局已计入）。 */
  endingsAchieved: number;
  edgesTraversed: number;
}

/** 图鉴条目：未达成的结局只给「???」，不带任何 outline 文本（不剧透）。 */
export interface GalleryEntry {
  key: string;
  achieved: boolean;
  /** 达成 → 结局语义名（去 end_ 前缀）；未达成 → 固定 "???"。 */
  label: string;
  count?: number | undefined;
}

export interface GalleryView {
  gameId: string;
  entries: GalleryEntry[];
  achievedCount: number;
}

export interface SettlementStores {
  gameId: string;
  graph: GraphStorePort;
  outline?: OutlineStorePort | undefined;
  stats: StatsStorePort;
  /** 会话目录（定位 <sessionId>/ending-report.json）；缺省不读回收率。 */
  sessionsDir?: string | undefined;
  sessionId?: string | undefined;
}

/** 大纲完成度：realized act / 总 act（只统计 act；ending 不计完成度）。 */
async function outlineProgressOf(
  outline: OutlineStorePort | undefined,
): Promise<{ realized: number; total: number } | undefined> {
  if (outline === undefined) return undefined;
  try {
    const { nodes } = await outline.load();
    const acts = nodes.filter((n) => n.kind === "act" && n.status !== "pruned");
    if (acts.length === 0) return undefined;
    return {
      realized: acts.filter((n) => n.status === "realized").length,
      total: acts.length,
    };
  } catch {
    return undefined;
  }
}

/** 结算视图：最新完结周目（runs 末位含 ending 者为准）。 */
export async function buildSettlementView(stores: SettlementStores): Promise<SettlementView> {
  const runs = await stores.graph.listRuns();
  const endedRuns = runs.filter((r) => r.ending !== undefined && r.endedAt !== undefined);
  if (endedRuns.length === 0) {
    throw new Error("尚无已完结周目（结算页在通关后可用）");
  }
  const last = endedRuns.at(-1)!;
  const endingId = last.ending!;

  // 结局文本：从指向该结局的边负载回收（开局直落结局无负载 → null）。
  let endingText: string | null = null;
  const edges = await stores.graph.listEdges();
  const endingEdge = [...edges]
    .reverse()
    .find((e) => e.to.kind === "ending" && e.to.id === endingId);
  if (endingEdge !== undefined && endingEdge.payload.eventCount > 0) {
    const payload = await stores.graph.readPayload(endingEdge.id);
    const endEvent = [...payload].reverse().find((e) => e.type === "end");
    if (endEvent !== undefined && "text" in endEvent) {
      endingText = String(endEvent.text);
    }
  }

  // 伏笔回收率：ending-report（会话目录；缺失/损坏 best-effort 缺省）。
  let payoffRate: number | undefined;
  if (stores.sessionsDir !== undefined && stores.sessionId !== undefined) {
    try {
      const raw = await readFile(
        join(stores.sessionsDir, stores.sessionId, "ending-report.json"),
        "utf8",
      );
      const report = JSON.parse(raw) as { setups?: { payoffRate?: number } };
      if (typeof report.setups?.payoffRate === "number") {
        payoffRate = report.setups.payoffRate;
      }
    } catch {
      payoffRate = undefined;
    }
  }

  const stats = await stores.stats.load();
  const progress = await outlineProgressOf(stores.outline);
  return {
    gameId: stores.gameId,
    runId: last.id,
    endingId,
    endingText,
    ...(payoffRate !== undefined ? { payoffRate } : {}),
    ...(progress !== undefined ? { outlineProgress: progress } : {}),
    endingsAchieved: stats.endings.length,
    edgesTraversed: stats.edges.reduce((sum, e) => sum + e.count, 0),
  };
}

/** 图鉴视图：已达成结局给语义名 + 次数；未达成候选一律「???」。 */
export async function buildGalleryView(stores: SettlementStores): Promise<GalleryView> {
  const stats = await stores.stats.load();
  const entries: GalleryEntry[] = stats.endings
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((e) => ({
      key: e.id,
      achieved: true,
      label: e.id.replace(/^end_/, ""),
      count: e.count,
    }));

  // 未达成的 outline 结局候选 → 「???」（只暴露数量，不暴露 purpose/location）。
  if (stores.outline !== undefined) {
    try {
      const { nodes } = await stores.outline.load();
      const endingNodes = nodes.filter((n) => n.kind === "ending" && n.status !== "pruned");
      for (const node of endingNodes) {
        const suffix = node.id.replace(/^ol_end_/, "");
        const matched = stats.endings.some((e) => e.id.replace(/^end_/, "") === suffix);
        if (!matched) {
          entries.push({ key: node.id, achieved: false, label: "???" });
        }
      }
    } catch {
      // outline 缺失 → 只列已达成。
    }
  }
  return {
    gameId: stores.gameId,
    entries,
    achievedCount: stats.endings.length,
  };
}
