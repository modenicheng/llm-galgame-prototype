/**
 * v2 剧情图契约测试（设计 §3）——schema 解析/拒绝与不变量。
 */
import { describe, expect, it } from "vitest";
import type { InteractionEvent } from "../../schema.js";
import {
  ActiveCursorSchema,
  DecisionNodeSchema,
  InteractionFormSnapshotSchema,
  PlotEdgeSchema,
  RunRecordSchema,
  StateSnapshotSchema,
  type InteractionFormSnapshot,
} from "./types.js";
import { formSnapshotFromInteraction } from "./form.js";
import { makeIdentity, makeSnapshot } from "./testing.js";

const hybridForm = {
  mode: "hybrid",
  prompt: "你要怎么做？",
  options: ["追问", "离开"],
  placeholder: "或输入……",
};

describe("StateSnapshot", () => {
  it("accepts a minimal valid snapshot", () => {
    const parsed = StateSnapshotSchema.parse(makeSnapshot());
    expect(parsed.snapshotVersion).toBe(4);
  });

  it("rejects an unknown snapshotVersion", () => {
    // 故意的契约违规：字面量类型绕开 Partial<StateSnapshot> 的 1 类型约束
    const invalid = { ...makeSnapshot(), snapshotVersion: 1 } as Record<string, unknown>;
    expect(StateSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a snapshot missing memoryDigest", () => {
    const { memoryDigest: _omitted, ...rest } = makeSnapshot();
    expect(StateSnapshotSchema.safeParse(rest).success).toBe(false);
  });

  it("M3 v4: rejects a snapshot missing the identity block", () => {
    const { identity: _omitted, ...rest } = makeSnapshot();
    expect(StateSnapshotSchema.safeParse(rest).success).toBe(false);
  });

  it("M3 v4: requires consolidationFailedIntervals in the digest", () => {
    const digest = {
      ...makeSnapshot().memoryDigest,
    } as Record<string, unknown>;
    delete digest.consolidationFailedIntervals;
    expect(
      StateSnapshotSchema.safeParse({ ...makeSnapshot(), memoryDigest: digest }).success,
    ).toBe(false);
  });

  it("M3 v4: rejects dangerous keys in characterLabels", () => {
    // JSON.parse('{"__proto__":…}') 的产物自有键会被 preprocess 拒绝
    //（对象字面量写 __proto__ 只改原型，必须走 JSON 文本注入）。
    const raw = JSON.stringify(makeSnapshot()).replace(
      '"characterLabels":{}',
      '"characterLabels":{"__proto__":"x"}',
    );
    expect(StateSnapshotSchema.safeParse(JSON.parse(raw)).success).toBe(false);
  });
});

describe("InteractionFormSnapshot", () => {
  it.each([
    [{ mode: "choice", prompt: "？", options: ["A", "B"] }],
    [{ mode: "input", prompt: "？", placeholder: "说点什么……" }],
    [{ mode: "hybrid", prompt: "？", options: ["A"], placeholder: "或输入……" }],
  ])("accepts %j", (form) => {
    expect(InteractionFormSnapshotSchema.safeParse(form).success).toBe(true);
  });

  it.each([
    [{ mode: "choice", options: ["A", "B"] }], // 缺 prompt
    [{ mode: "choice", prompt: "？" }], // choice 无选项
    [{ mode: "choice", prompt: "？", options: ["A"], placeholder: "x" }], // choice 不应有输入框
    [{ mode: "input", prompt: "？" }], // input 无 placeholder
    [{ mode: "input", prompt: "？", options: ["A"], placeholder: "x" }], // input 不应有选项
    [{ mode: "hybrid", prompt: "？", options: ["A"] }], // hybrid 缺 placeholder
    [{ mode: "hybrid", prompt: "？", placeholder: "x" }], // hybrid 缺选项
    [{ mode: "hybrid", prompt: "？" }], // 空表单（设计 §28：既无选项也无输入非法）
  ])("rejects %j", (form) => {
    expect(InteractionFormSnapshotSchema.safeParse(form).success).toBe(false);
  });
});

describe("formSnapshotFromInteraction", () => {
  const cases: Array<[InteractionEvent, InteractionFormSnapshot]> = [
    [
      {
        type: "interaction",
        interaction_id: "i1",
        mode: "choice",
        prompt: "做什么？",
        options: [
          { id: "o1", text: "追问" },
          { id: "o2", text: "离开" },
        ],
      },
      { mode: "choice", prompt: "做什么？", options: ["追问", "离开"] },
    ],
    [
      {
        type: "interaction",
        interaction_id: "i2",
        mode: "input",
        prompt: "说什么？",
        input: { placeholder: "……", max_length: 100, kind: "free_text" },
      },
      { mode: "input", prompt: "说什么？", placeholder: "……" },
    ],
    [
      {
        type: "interaction",
        interaction_id: "i3",
        mode: "hybrid",
        prompt: "做什么？",
        options: [{ id: "o1", text: "沉默" }],
        input: { placeholder: "或输入……", max_length: 100, kind: "free_text" },
      },
      { mode: "hybrid", prompt: "做什么？", options: ["沉默"], placeholder: "或输入……" },
    ],
  ];

  it.each(cases)("maps %j → %j", (event, expected) => {
    expect(formSnapshotFromInteraction(event)).toEqual(expected);
    expect(InteractionFormSnapshotSchema.safeParse(formSnapshotFromInteraction(event)).success).toBe(
      true,
    );
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

  it("rejects confluence evidence that does not target the edge's own successor", () => {
    expect(
      PlotEdgeSchema.safeParse({
        ...baseEdge,
        to: { kind: "decision", id: "dc_002" },
        confluence: { matchedNode: "dc_999", judgedBy: "director", confidence: 0.9, rationale: "x" },
      }).success,
    ).toBe(false);
    expect(
      PlotEdgeSchema.safeParse({
        ...baseEdge,
        to: { kind: "ending", id: "end_001" },
        confluence: { matchedNode: "end_001", judgedBy: "director", confidence: 0.9, rationale: "x" },
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

  it("rejects an ending without endedAt", () => {
    expect(
      RunRecordSchema.safeParse({
        id: "run_001",
        origin: { kind: "root" },
        startedAt: "t",
        ending: "end_001",
      }).success,
    ).toBe(false);
  });

  it("rejects an abandoned run that is also recorded as ended", () => {
    expect(
      RunRecordSchema.safeParse({
        id: "run_001",
        origin: { kind: "root" },
        startedAt: "t",
        endedAt: "t2",
        abandonedAt: "dc_001",
      }).success,
    ).toBe(false);
    expect(
      RunRecordSchema.safeParse({
        id: "run_001",
        origin: { kind: "root" },
        startedAt: "t",
        endedAt: "t2",
        ending: "end_001",
        abandonedAt: "dc_001",
      }).success,
    ).toBe(false);
  });

  it("accepts an active cursor", () => {
    expect(
      ActiveCursorSchema.safeParse({ runId: "run_001", position: "dc_001" }).success,
    ).toBe(true);
  });
});
