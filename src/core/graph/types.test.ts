/**
 * v2 剧情图契约测试（设计 §3）——schema 解析/拒绝与不变量。
 */
import { describe, expect, it } from "vitest";
import {
  ActiveCursorSchema,
  DecisionNodeSchema,
  InteractionFormSnapshotSchema,
  PlotEdgeSchema,
  RunRecordSchema,
  StateSnapshotSchema,
  type StateSnapshot,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function makeSnapshot(overrides?: Partial<StateSnapshot>): StateSnapshot {
  return {
    snapshotVersion: 1,
    storyState: {
      scene: { id: "scene_1", location: "地下室", purpose: "发现旧终端" },
      canon: {},
      characters: {},
      open_threads: [],
      recent_summary: "林澈在废弃校舍发现了仍在运行的旧终端。",
      player_profile: { recent_tendencies: [] },
    },
    visualState: { characters: {} },
    memoryDigest: {
      revision: 0,
      consolidatedThroughEventSeq: 0,
      checkpointCount: 0,
      threads: [],
      setups: [],
      anchors: [],
    },
    outlineRevision: 0,
    ...overrides,
  };
}

const hybridForm = { mode: "hybrid", options: ["追问", "离开"], placeholder: "或输入……" };

describe("StateSnapshot", () => {
  it("accepts a minimal valid snapshot", () => {
    const parsed = StateSnapshotSchema.parse(makeSnapshot());
    expect(parsed.snapshotVersion).toBe(1);
  });

  it("rejects an unknown snapshotVersion", () => {
    // 故意的契约违规：字面量类型绕开 Partial<StateSnapshot> 的 1 类型约束
    const invalid = { ...makeSnapshot(), snapshotVersion: 2 } as Record<string, unknown>;
    expect(StateSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a snapshot missing memoryDigest", () => {
    const { memoryDigest: _omitted, ...rest } = makeSnapshot();
    expect(StateSnapshotSchema.safeParse(rest).success).toBe(false);
  });
});

describe("InteractionFormSnapshot", () => {
  it.each([
    [{ mode: "choice", options: ["A", "B"] }],
    [{ mode: "input", placeholder: "说点什么……" }],
    [{ mode: "hybrid", options: ["A"], placeholder: "或输入……" }],
  ])("accepts %j", (form) => {
    expect(InteractionFormSnapshotSchema.safeParse(form).success).toBe(true);
  });

  it.each([
    [{ mode: "choice" }], // choice 无选项
    [{ mode: "choice", options: ["A"], placeholder: "x" }], // choice 不应有输入框
    [{ mode: "input" }], // input 无 placeholder
    [{ mode: "input", options: ["A"], placeholder: "x" }], // input 不应有选项
    [{ mode: "hybrid", options: ["A"] }], // hybrid 缺 placeholder
    [{ mode: "hybrid", placeholder: "x" }], // hybrid 缺选项
    [{ mode: "hybrid" }], // 空表单（设计 §28：既无选项也无输入非法）
  ])("rejects %j", (form) => {
    expect(InteractionFormSnapshotSchema.safeParse(form).success).toBe(false);
  });
});

describe("DecisionNode", () => {
  it("accepts a valid decision node", () => {
    const parsed = DecisionNodeSchema.parse({
      id: "dc_001",
      sceneId: "sc_001",
      entryState: makeSnapshot(),
      form: hybridForm,
    });
    expect(parsed.id).toBe("dc_001");
  });

  it("rejects a node id with the wrong prefix", () => {
    expect(
      DecisionNodeSchema.safeParse({
        id: "sc_001", // 场景前缀，不是决策前缀
        sceneId: "sc_001",
        entryState: makeSnapshot(),
        form: hybridForm,
      }).success,
    ).toBe(false);
  });
});

describe("PlotEdge payload stats invariant", () => {
  const baseEdge = {
    id: "eg_001",
    from: "dc_001",
    choice: { kind: "option", text: "追问终端的来历" },
    endState: makeSnapshot(),
    to: { kind: "decision", id: "dc_002" },
  };

  it("accepts a zero-event edge with all-zero seq range", () => {
    expect(
      PlotEdgeSchema.safeParse({ ...baseEdge, payload: { eventCount: 0, firstSeq: 0, lastSeq: 0 } })
        .success,
    ).toBe(true);
  });

  it("accepts a non-empty ordered seq range", () => {
    expect(
      PlotEdgeSchema.safeParse({ ...baseEdge, payload: { eventCount: 3, firstSeq: 7, lastSeq: 9 } })
        .success,
    ).toBe(true);
  });

  it("rejects a non-empty edge whose firstSeq is zero", () => {
    expect(
      PlotEdgeSchema.safeParse({ ...baseEdge, payload: { eventCount: 2, firstSeq: 0, lastSeq: 5 } })
        .success,
    ).toBe(false);
  });

  it("rejects an inverted seq range", () => {
    expect(
      PlotEdgeSchema.safeParse({ ...baseEdge, payload: { eventCount: 2, firstSeq: 9, lastSeq: 7 } })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown endpoint kind", () => {
    expect(
      PlotEdgeSchema.safeParse({ ...baseEdge, to: { kind: "scene", id: "sc_001" } }).success,
    ).toBe(false);
  });

  it("rejects confluence confidence outside [0, 1]", () => {
    expect(
      PlotEdgeSchema.safeParse({
        ...baseEdge,
        to: { kind: "decision", id: "dc_002" },
        confluence: { matchedNode: "dc_002", judgedBy: "director", confidence: 1.5, rationale: "x" },
      }).success,
    ).toBe(false);
  });
});

describe("RunRecord / ActiveCursor", () => {
  it("accepts a root-origin run and a retrace-origin run", () => {
    expect(
      RunRecordSchema.safeParse({ id: "run_001", origin: { kind: "root" }, startedAt: "t" })
        .success,
    ).toBe(true);
    expect(
      RunRecordSchema.safeParse({
        id: "run_002",
        origin: { kind: "retrace", from: "dc_001" },
        startedAt: "t",
        abandonedAt: "dc_003",
      }).success,
    ).toBe(true);
  });

  it("requires `from` on a retrace origin", () => {
    expect(
      RunRecordSchema.safeParse({ id: "run_002", origin: { kind: "retrace" }, startedAt: "t" })
        .success,
    ).toBe(false);
  });

  it("accepts an active cursor", () => {
    expect(
      ActiveCursorSchema.safeParse({ runId: "run_001", position: "dc_001" }).success,
    ).toBe(true);
  });
});
