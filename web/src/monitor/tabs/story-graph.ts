/**
 * Story graph tab — derives the run's story graph from the committed event
 * timeline and renders it as a vertical flow (docs/monitor-dashboard.md).
 *
 * There is no authored DAG in event mode: the "graph" IS the run — a start
 * node, one node per formally opened interaction (with its full option
 * fan), the chosen edge (selected option / free input), and the ending.
 * `deriveStoryGraph` is pure and unit-tested; rendering is a thin walk.
 */
import type { MonitorTimelineEntry } from "@core/runtime/monitor-state.js";
import { el } from "../../ui/dom.js";

export interface GraphOptionView {
  id: string;
  text: string;
  selected: boolean;
}

export interface GraphInteractionNode {
  seq: number;
  turn: number;
  mode: string;
  prompt: string;
  options: GraphOptionView[];
  chosenKind: "choice" | "input" | null;
  chosenText: string | null;
  /** No player answer yet and no ending after it — awaiting the player. */
  pending: boolean;
}

export interface StoryGraphModel {
  nodes: GraphInteractionNode[];
  ending: {
    seq: number;
    endingId: string;
    text: string;
    /** @ending 档位（TE|HE|NE|BE）；未识别/缺省为 null。 */
    grade: string | null;
    /** @ending 结尾词（结局标题）；缺省为 null。 */
    title: string | null;
  } | null;
  hasEnding: boolean;
}

export function deriveStoryGraph(timeline: readonly MonitorTimelineEntry[]): StoryGraphModel {
  const nodes: GraphInteractionNode[] = [];
  let ending: StoryGraphModel["ending"] = null;

  for (let i = 0; i < timeline.length; i += 1) {
    const entry = timeline[i]!;
    if (entry.kind === "end") {
      ending = {
        seq: entry.seq,
        endingId: entry.endingId ?? "",
        text: entry.text ?? "",
        grade: entry.endingGrade ?? null,
        title: entry.endingTitle ?? null,
      };
      continue;
    }
    if (entry.kind !== "interaction") continue;

    // Find this interaction's player answer: the first player event after
    // it, before the next interaction/ending.
    let chosenKind: "choice" | "input" | null = null;
    let chosenText: string | null = null;
    let chosenChoiceId: string | null = null;
    for (let j = i + 1; j < timeline.length; j += 1) {
      const next = timeline[j]!;
      if (next.kind === "interaction" || next.kind === "end") break;
      if (next.kind === "player_choice") {
        chosenKind = "choice";
        chosenText = next.text ?? null;
        chosenChoiceId = next.choiceId ?? null;
        break;
      }
      if (next.kind === "player_input" || next.kind === "player_dialogue") {
        chosenKind = "input";
        chosenText = next.text ?? null;
        break;
      }
    }

    const pending = chosenKind === null && ending === null && i === lastInteractionIndex(timeline);
    nodes.push({
      seq: entry.seq,
      turn: entry.turn,
      mode: entry.mode ?? "choice",
      prompt: entry.prompt ?? "",
      options: (entry.options ?? []).map((option) => ({
        id: option.id,
        text: option.text,
        selected: chosenChoiceId !== null ? option.id === chosenChoiceId : false,
      })),
      chosenKind,
      chosenText,
      pending,
    });
  }

  return { nodes, ending, hasEnding: ending !== null };
}

function lastInteractionIndex(timeline: readonly MonitorTimelineEntry[]): number {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    if (timeline[i]!.kind === "interaction") return i;
  }
  return -1;
}

const MODE_LABELS: Record<string, string> = {
  choice: "选项",
  input: "输入",
  hybrid: "混合",
};

/** Render the graph (rebuild-on-change; the timeline is small). */
export function renderStoryGraph(
  container: HTMLElement,
  graph: StoryGraphModel,
  pressure: { interactionCount: number; wrapupAt: number; closingPushAt: number; maxAt: number },
  branches: Record<string, { label: string; state: string; eventCount: number; dialogueCount: number }>,
  context?: { eventCount?: number },
): void {
  container.textContent = "";

  // Ending-pressure lane.
  const lane = el("div", "graph-lane");
  const bar = el("div", "bar");
  const max = Math.max(1, pressure.maxAt);
  const fill = el("div", "fill");
  fill.style.width = `${Math.min(100, Math.round((pressure.interactionCount / max) * 100))}%`;
  bar.appendChild(fill);
  for (const at of [pressure.wrapupAt, pressure.closingPushAt, pressure.maxAt]) {
    if (at <= 0) continue;
    const mark = el("div", "mark");
    mark.style.left = `${Math.min(100, Math.round((at / max) * 100))}%`;
    mark.setAttribute("title", `阈值 ${at}`);
    bar.appendChild(mark);
  }
  lane.appendChild(bar);
  const legend = el("div", "legend");
  legend.appendChild(el("span", undefined, `交互进度 ${pressure.interactionCount}`));
  if (pressure.wrapupAt > 0) legend.appendChild(el("span", undefined, `L1 @${pressure.wrapupAt}`));
  if (pressure.closingPushAt > 0) legend.appendChild(el("span", undefined, `L2 @${pressure.closingPushAt}`));
  if (pressure.maxAt > 0) legend.appendChild(el("span", undefined, `L3 @${pressure.maxAt}`));
  lane.appendChild(legend);
  container.appendChild(lane);

  const flow = el("div", "graph-flow");
  flow.appendChild(el("div", "graph-start", "● 开局"));

  const branchEntries = Object.entries(branches);
  for (const node of graph.nodes) {
    const nodeEl = el("div", `graph-node${node.pending ? " is-current" : ""}`);
    const head = el("div", "node-head");
    head.appendChild(el("span", undefined, `#${node.seq}`));
    head.appendChild(el("span", undefined, `turn ${node.turn}`));
    head.appendChild(el("span", undefined, MODE_LABELS[node.mode] ?? node.mode));
    if (node.pending) head.appendChild(el("span", "graph-pending", "等待玩家…"));
    nodeEl.appendChild(head);
    nodeEl.appendChild(el("div", "prompt", node.prompt));

    if (node.options.length > 0) {
      const list = el("ul", "graph-options");
      for (const option of node.options) {
        const li = el("li", option.selected ? "is-selected" : undefined);
        li.textContent = `${option.selected ? "✓ " : ""}${option.text}`;
        list.appendChild(li);
      }
      nodeEl.appendChild(list);
    }
    if (node.pending && branchEntries.length > 0) {
      const chips = el("div", "graph-branches");
      for (const [, branch] of branchEntries) {
        const chip = el("span", "mon-chip");
        const dot = el("span", `mon-dot state-${branch.state === "ready" ? "done" : branch.state === "failed" ? "failed" : "streaming"}`);
        chip.appendChild(dot);
        chip.appendChild(el("span", undefined, `${branch.label} ${branch.dialogueCount}句`));
        chips.appendChild(chip);
      }
      nodeEl.appendChild(chips);
    }
    flow.appendChild(nodeEl);

    if (node.chosenKind !== null && node.chosenText !== null) {
      const edge = el("div", "graph-edge");
      const label = el("span", "label", node.chosenText);
      edge.appendChild(el("span", undefined, node.chosenKind === "input" ? "输入" : "选择"));
      edge.appendChild(label);
      flow.appendChild(edge);
    }
  }

  if (graph.ending !== null) {
    const grade = graph.ending.grade ?? "NE";
    // 终局节点按档位换左边框色（.is-ending--te/he/ne/be）。
    const endNode = el("div", `graph-node is-ending is-ending--${grade.toLowerCase()}`);
    const head = el("div", "node-head");
    head.appendChild(
      el("span", undefined, `✦ 结局 #${graph.ending.seq} [${grade}]`),
    );
    head.appendChild(el("span", undefined, graph.ending.endingId));
    endNode.appendChild(head);
    if (graph.ending.title !== null) {
      endNode.appendChild(el("div", "node-ending-title", graph.ending.title));
    }
    endNode.appendChild(el("div", "prompt", graph.ending.text));
    flow.appendChild(endNode);
  } else if (graph.nodes.length === 0) {
    // 区分「真·空会话」与「已有事件但第一次交互还没开」——否则与状态栏的
    // 事件计数互相矛盾。
    const eventCount = context?.eventCount ?? 0;
    flow.appendChild(
      el(
        "div",
        "mon-empty",
        eventCount > 0
          ? `已提交 ${eventCount} 条事件，还没有交互节点（等待第一次表单）`
          : "还没有已提交的剧情事件",
      ),
    );
  }

  container.appendChild(flow);
}
