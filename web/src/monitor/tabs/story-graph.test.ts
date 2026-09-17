/**
 * Story-graph derivation tests — interaction nodes, option selection,
 * pending detection and the ending node, from a committed timeline.
 */
import { describe, expect, it } from "vitest";
import { deriveStoryGraph } from "./story-graph.js";
import type { MonitorTimelineEntry } from "@core/runtime/monitor-state.js";

function entry(patch: Partial<MonitorTimelineEntry> & { seq: number }): MonitorTimelineEntry {
  return {
    turn: 1,
    at: "2026-09-17T00:00:00.000Z",
    source: "model",
    kind: "narration",
    ...patch,
  };
}

describe("deriveStoryGraph", () => {
  it("returns an empty graph for an empty timeline", () => {
    const graph = deriveStoryGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.ending).toBeNull();
    expect(graph.hasEnding).toBe(false);
  });

  it("builds one node per interaction with the selected option marked", () => {
    const timeline = [
      entry({ seq: 1, kind: "narration", text: "夜色渐深" }),
      entry({
        seq: 2,
        kind: "interaction",
        prompt: "接下来去哪？",
        mode: "choice",
        options: [
          { id: "opt_a", text: "天台" },
          { id: "opt_b", text: "机房" },
        ],
      }),
      entry({ seq: 3, source: "player", kind: "player_choice", choiceId: "opt_b", text: "机房" }),
      entry({ seq: 4, kind: "dialogue", speaker: "苏遥", text: "走吧。" }),
    ];
    const graph = deriveStoryGraph(timeline);
    expect(graph.nodes).toHaveLength(1);
    const node = graph.nodes[0]!;
    expect(node.prompt).toBe("接下来去哪？");
    expect(node.chosenKind).toBe("choice");
    expect(node.chosenText).toBe("机房");
    expect(node.options.map((o) => o.selected)).toEqual([false, true]);
    expect(node.pending).toBe(false);
  });

  it("marks a free-input answer on the edge", () => {
    const timeline = [
      entry({
        seq: 1,
        kind: "interaction",
        prompt: "你想说什么？",
        mode: "input",
      }),
      entry({ seq: 2, source: "player", kind: "player_input", text: "我想留下来。" }),
    ];
    const graph = deriveStoryGraph(timeline);
    expect(graph.nodes[0]!.chosenKind).toBe("input");
    expect(graph.nodes[0]!.chosenText).toBe("我想留下来。");
  });

  it("flags the last unanswered interaction as pending (before any ending)", () => {
    const timeline = [
      entry({
        seq: 1,
        kind: "interaction",
        prompt: "选一个。",
        mode: "choice",
        options: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
      }),
    ];
    const graph = deriveStoryGraph(timeline);
    expect(graph.nodes[0]!.pending).toBe(true);
    expect(graph.ending).toBeNull();
  });

  it("attaches the ending node and stops marking pending", () => {
    const timeline = [
      entry({
        seq: 1,
        kind: "interaction",
        prompt: "要结束了吗？",
        mode: "choice",
        options: [{ id: "a", text: "是的" }],
      }),
      entry({ seq: 2, source: "player", kind: "player_choice", choiceId: "a", text: "是的" }),
      entry({ seq: 3, kind: "end", endingId: "farewell", text: "灯影散场。" }),
    ];
    const graph = deriveStoryGraph(timeline);
    expect(graph.nodes[0]!.pending).toBe(false);
    expect(graph.ending).toEqual({ seq: 3, endingId: "farewell", text: "灯影散场。" });
    expect(graph.hasEnding).toBe(true);
  });

  it("does not let a later interaction steal an earlier one's answer", () => {
    const timeline = [
      entry({ seq: 1, kind: "interaction", prompt: "第一问", mode: "input" }),
      entry({ seq: 2, kind: "interaction", prompt: "第二问", mode: "input" }),
      entry({ seq: 3, source: "player", kind: "player_input", text: "回答二" }),
    ];
    const graph = deriveStoryGraph(timeline);
    expect(graph.nodes[0]!.chosenKind).toBeNull();
    expect(graph.nodes[1]!.chosenKind).toBe("input");
    expect(graph.nodes[1]!.chosenText).toBe("回答二");
  });
});
