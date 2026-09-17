/**
 * GraphView 测试（执行清单 M5.1 验收）：脱敏负面断言（响应无 planned/
 * pruned/ending outline 内容）、D8 location 分组、决策粒度（M5.2）、
 * 游标高亮标记与周目统计。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameGraphStore } from "../../adapters/storage/game-graph-store.js";
import { OutlineStore } from "../../adapters/storage/outline-store.js";
import { buildGraphView } from "./graph-view.js";
import { makeDecision, makeEdge, makeSnapshot } from "../../core/graph/testing.js";

describe("buildGraphView", () => {
  let root: string;
  let graph: GameGraphStore;
  let outline: OutlineStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "graph-view-"));
    graph = new GameGraphStore(root, "game_graph_view");
    await graph.initialize();
    outline = new OutlineStore(root, "game_graph_view");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("groups scenes by outline act location and never leaks planned/pruned/ending outline info", async () => {
    // 大纲：act1（active，带 location 教室）+ act2（planned，location 未来礼堂）
    // + ending 节点（planned）。act2 与 ending 都必须绝不出现在视图里。
    await outline.load();
    await outline.applyRevision(
      [
        { type: "add", node: { id: "ol_act1", purpose: "第一幕", kind: "act", status: "planned", location: "教室" } },
        { type: "add", node: { id: "ol_act2", purpose: "第二幕", kind: "act", status: "planned", location: "未来礼堂" } },
        { type: "add", node: { id: "ol_end_1", purpose: "结局", kind: "ending", status: "planned" } },
      ],
      "测试大纲",
    );
    await outline.applyRevision([{ type: "activate", id: "ol_act1" }], "激活第一幕");

    // 场景：sc1（outlineRef=act1）+ sc2（outlineRef 也=act1——同物理场景不同状态，D8）。
    await graph.putScene({ id: "sc_1", outlineRef: "ol_act1", status: "active" });
    await graph.putScene({ id: "sc_2", outlineRef: "ol_act1", status: "realized" });

    // 决策与边。
    await graph.putDecision(
      makeDecision({
        id: "dc_1",
        sceneId: "sc_1",
        entryState: makeSnapshot({ storyState: makeSnapshot().storyState }),
      }),
    );
    await graph.putDecision(makeDecision({ id: "dc_2", sceneId: "sc_2" }));
    await graph.putDecision(makeDecision({ id: "dc_3", sceneId: "sc_2" }));
    await graph.putEdge(makeEdge({ id: "eg_1", from: "dc_1", to: { kind: "decision", id: "dc_2" } }));
    await graph.putEdge(
      makeEdge({
        id: "eg_2",
        from: "dc_2",
        to: { kind: "decision", id: "dc_3" },
        confluence: { matchedNode: "dc_3", judgedBy: "j", confidence: 0.9, rationale: "r" },
      }),
    );
    await graph.putRun({ id: "run_1", origin: { kind: "root" }, startedAt: "t1", endedAt: "t2", ending: "end_x" });
    await graph.putRun({ id: "run_2", origin: { kind: "root" }, startedAt: "t3", abandonedAt: "dc_3" });
    await graph.saveCursor({ runId: "run_2", position: "dc_3" });

    const view = await buildGraphView({ gameId: "game_graph_view", graph, outline });
    const json = JSON.stringify(view);

    // D8 分组：两个场景同 groupKey「教室」。
    expect(view.scenes).toHaveLength(2);
    expect(view.scenes.every((s) => s.groupKey === "教室")).toBe(true);
    expect(view.scenes.every((s) => s.outlineRef === "ol_act1")).toBe(true);

    // 脱敏负面断言：planned/pruned/ending 内容零泄漏。
    expect(json).not.toContain("未来礼堂");
    expect(json).not.toContain("ol_act2");
    expect(json).not.toContain("ol_end_1");
    expect(json).not.toContain("第二幕");
    expect(json).not.toContain("结局");

    // 决策粒度（M5.2）与游标标记。
    const sc2 = view.scenes.find((s) => s.sceneId === "sc_2")!;
    expect(sc2.decisions.map((d) => d.id)).toEqual(["dc_2", "dc_3"]);
    expect(sc2.decisions.find((d) => d.id === "dc_3")!.isCursor).toBe(true);
    expect(sc2.decisions.find((d) => d.id === "dc_2")!.isCursor).toBe(false);
    expect(view.cursor).toEqual({ runId: "run_2", decisionId: "dc_3" });

    // 出边归属场景 + 汇流标注。
    expect(sc2.outEdges.map((e) => e.id)).toEqual(["eg_2"]);
    expect(sc2.outEdges[0]!.confluence).toEqual({ matchedNode: "dc_3", judgedBy: "j", confidence: 0.9 });

    // 周目统计。
    expect(view.runs).toEqual({ total: 2, ended: 1, abandoned: 1, active: 0 });
  });

  it("falls back to the model scene id as groupKey when the outline is absent", async () => {
    await graph.putScene({ id: "sc_1", outlineRef: "ol_act1", status: "active" });
    await graph.putDecision(makeDecision({ id: "dc_1", sceneId: "sc_1" }));
    const view = await buildGraphView({ gameId: "game_graph_view", graph, outline: undefined });
    expect(view.scenes).toHaveLength(1);
    expect(view.scenes[0]!.groupKey).toBe("scene_1"); // 模型场景 id 回退
    expect(view.scenes[0]!.outlineRef).toBeUndefined();
  });
});
