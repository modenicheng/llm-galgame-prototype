/**
 * v2 大纲图契约测试（设计 §4）——schema、状态机与冻结规则。
 */
import { describe, expect, it } from "vitest";
import {
  canTransitionOutlineStatus,
  OutlineNodeSchema,
  transitionOutlineNode,
  type OutlineNode,
} from "./types.js";

const node: OutlineNode = {
  id: "ol_001",
  purpose: "主角在地下室发现终端，故事由此进入核心谜团。",
  kind: "act",
  status: "planned",
};

describe("OutlineNodeSchema", () => {
  it("accepts a valid planned act node", () => {
    expect(OutlineNodeSchema.parse(node)).toEqual(node);
  });

  it("rejects a purpose over 200 characters", () => {
    expect(
      OutlineNodeSchema.safeParse({ ...node, purpose: "长".repeat(201) }).success,
    ).toBe(false);
  });

  it("rejects an id without the outline prefix", () => {
    expect(OutlineNodeSchema.safeParse({ ...node, id: "act_001" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(OutlineNodeSchema.safeParse({ ...node, status: "done" }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(OutlineNodeSchema.safeParse({ ...node, kind: "chapter" }).success).toBe(false);
  });
});

describe("outline status machine", () => {
  it("allows the forward path planned → active → realized", () => {
    expect(canTransitionOutlineStatus("planned", "active")).toBe(true);
    expect(canTransitionOutlineStatus("active", "realized")).toBe(true);
  });

  it("allows pruning from any non-terminal status", () => {
    expect(canTransitionOutlineStatus("planned", "pruned")).toBe(true);
    expect(canTransitionOutlineStatus("active", "pruned")).toBe(true);
  });

  it("forbids skipping activation", () => {
    expect(canTransitionOutlineStatus("planned", "realized")).toBe(false);
  });

  it("treats realized and pruned as terminal", () => {
    expect(canTransitionOutlineStatus("realized", "pruned")).toBe(false);
    expect(canTransitionOutlineStatus("realized", "active")).toBe(false);
    expect(canTransitionOutlineStatus("pruned", "planned")).toBe(false);
    expect(canTransitionOutlineStatus("pruned", "active")).toBe(false);
  });
});

describe("transitionOutlineNode", () => {
  it("activates a planned node immutably", () => {
    const activated = transitionOutlineNode(node, "active");
    expect(activated).toEqual({ ...node, status: "active" });
    expect(node.status).toBe("planned"); // 原节点不被改写
  });

  it("records instantiatedBy when realizing an active node", () => {
    const activated = transitionOutlineNode(node, "active")!;
    const realized = transitionOutlineNode(activated, "realized", "sc_001");
    expect(realized).toEqual({
      ...node,
      status: "realized",
      instantiatedBy: "sc_001",
    });
  });

  it("refuses to realize a planned node directly (must pass through active)", () => {
    expect(transitionOutlineNode(node, "realized", "sc_001")).toBeUndefined();
  });

  it("refuses to realize without a scene reference", () => {
    expect(transitionOutlineNode(node, "realized")).toBeUndefined();
  });

  it("refuses transitions out of terminal statuses", () => {
    const pruned = transitionOutlineNode(node, "pruned");
    expect(pruned).toBeDefined();
    expect(transitionOutlineNode(pruned!, "active")).toBeUndefined();
  });
});
