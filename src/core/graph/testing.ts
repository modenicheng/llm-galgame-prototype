/**
 * 图契约测试夹具（仅供测试导入）——最小合法的 StateSnapshot 与图记录
 * 构造器。纯数据，无 IO。
 */
import type {
  DecisionNode,
  InteractionFormSnapshot,
  PlotEdge,
  StateSnapshot,
} from "./types.js";

export function makeSnapshot(overrides?: Partial<StateSnapshot>): StateSnapshot {
  return {
    snapshotVersion: 3,
    storyState: {
      scene: { id: "scene_1", location: "地下室", purpose: "发现旧终端" },
      characters: {},
      recent_summary: "林澈在废弃校舍发现了仍在运行的旧终端。",
    },
    visualState: { characters: {} },
    memoryDigest: {
      revision: 0,
      consolidatedThroughEventSeq: 0,
      checkpointCount: 0,
      threads: [],
      setups: [],
      anchors: [],
      facts: [],
      beliefs: [],
    },
    outlineRevision: 0,
    ...overrides,
  };
}

export function makeForm(
  overrides?: Partial<InteractionFormSnapshot>,
): InteractionFormSnapshot {
  return { mode: "choice", prompt: "你要怎么做？", options: ["追问", "离开"], ...overrides };
}

export function makeDecision(
  overrides?: Partial<DecisionNode> & { id?: string },
): DecisionNode {
  const { id = "dc_001", ...rest } = overrides ?? {};
  return {
    id,
    sceneId: "sc_001",
    entryState: makeSnapshot(),
    form: makeForm(),
    ...rest,
  };
}

export function makeEdge(overrides?: Partial<PlotEdge> & { id?: string }): PlotEdge {
  const { id = "eg_001", ...rest } = overrides ?? {};
  return {
    id,
    from: "dc_001",
    choice: { kind: "option", text: "追问终端的来历" },
    payload: { eventCount: 0, firstSeq: 0, lastSeq: 0 },
    endState: makeSnapshot(),
    to: { kind: "decision", id: "dc_002" },
    ...rest,
  };
}
