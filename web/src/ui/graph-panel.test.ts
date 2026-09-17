/**
 * GraphPanel 渲染测试（执行清单 M5.1/M5.2 验收）：D8 分组、游标高亮、
 * 决策子图（出边选择文本）、空态与错误态。
 */
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { GraphPanel } from "./graph-panel.js";

const fakeView = {
  gameId: "game_x",
  scenes: [
    {
      sceneId: "sc_1",
      groupKey: "教室",
      status: "active",
      outlineRef: "ol_act1",
      decisions: [
        { id: "dc_1", form: { mode: "choice", prompt: "第一幕：如何选择？", options: ["追问", "离开"] }, isCursor: false },
      ],
      outEdges: [
        { id: "eg_1", from: "dc_1", choiceText: "追问", choiceKind: "option", to: { kind: "decision", id: "dc_2" } },
      ],
    },
    {
      sceneId: "sc_2",
      groupKey: "教室",
      status: "realized",
      outlineRef: "ol_act1",
      decisions: [
        { id: "dc_2", form: { mode: "input", prompt: "说什么？", placeholder: "..." }, isCursor: true },
      ],
      outEdges: [],
    },
    {
      sceneId: "sc_3",
      groupKey: "旧校舍",
      status: "active",
      decisions: [{ id: "dc_3", form: { mode: "choice", prompt: "追吗？" }, isCursor: false }],
      outEdges: [
        {
          id: "eg_3",
          from: "dc_3",
          choiceText: "认输",
          choiceKind: "option",
          to: { kind: "ending", id: "end_1" },
          confluence: { matchedNode: "dc_9", judgedBy: "j", confidence: 0.9 },
        },
      ],
    },
  ],
  cursor: { runId: "run_1", decisionId: "dc_2" },
  runs: { total: 3, ended: 1, abandoned: 1, active: 1 },
};

describe("GraphPanel", () => {
  it("renders D8 groups, scene cards, decisions with cursor highlight, and edges", () => {
    const root = document.createElement("div");
    const panel = new GraphPanel(root);
    panel.render(fakeView);

    // 分组：教室（2 场景）+ 旧校舍（1 场景）。
    const groups = root.querySelectorAll(".graph-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.querySelector(".graph-group__title")!.textContent).toBe("教室");
    expect(groups[0]!.querySelectorAll(".graph-scene")).toHaveLength(2);
    expect(groups[1]!.querySelector(".graph-group__title")!.textContent).toBe("旧校舍");

    // 决策子图：决策节点 + 出边选择文本；结局端点有标注；汇流有标注。
    const edges = Array.from(root.querySelectorAll(".graph-edge")).map((n) => n.textContent);
    expect(edges).toContain("「追问」");
    expect(edges).toContain("「认输」 ⇒ 结局 · 汇流");

    // 游标高亮。
    expect(root.querySelectorAll(".graph-decision--cursor")).toHaveLength(1);
    expect(root.querySelector(".graph-decision--cursor .graph-decision__prompt")!.textContent).toBe(
      "说什么？",
    );

    // 周目统计行。
    expect(root.querySelector(".graph-panel__summary")!.textContent).toContain("周目 3");
  });

  it("shows the empty state when nothing has been played", () => {
    const root = document.createElement("div");
    const panel = new GraphPanel(root);
    panel.render({ scenes: [], runs: { total: 0, ended: 0, abandoned: 0, active: 0 } });
    expect(root.querySelector(".graph-panel__empty")!.textContent).toContain("尚无已演出");
  });

  it("reports fetch failures inside the panel instead of throwing", async () => {
    const root = document.createElement("div");
    const panel = new GraphPanel(root);
    await panel.refresh(async () => {
      throw new Error("HTTP 500");
    });
    expect(panel.isVisible).toBe(true);
    expect(root.querySelector(".graph-panel__error")!.textContent).toContain("HTTP 500");
  });

  it("show/hide toggles the overlay", () => {
    const root = document.createElement("div");
    const panel = new GraphPanel(root);
    expect(panel.isVisible).toBe(false);
    panel.show();
    expect(panel.isVisible).toBe(true);
    panel.hide();
    expect(panel.isVisible).toBe(false);
  });
});
