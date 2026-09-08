/**
 * v2 ID 规则与存储布局测试（设计 §9）。
 */
import { describe, expect, it } from "vitest";
import {
  decisionSnapshotPath,
  edgePayloadPath,
  EdgeIdSchema,
  GAME_STORAGE_LAYOUT,
  GameIdSchema,
  OutlineNodeIdSchema,
  RunIdSchema,
  SceneIdSchema,
} from "./ids.js";

describe("id prefixes", () => {
  it.each([
    [GameIdSchema, "game_world-01"],
    [SceneIdSchema, "sc_abc.1"],
    [EdgeIdSchema, "eg_abc"],
    [RunIdSchema, "run_2026-09-09T00-00-00-000Z"],
    [OutlineNodeIdSchema, "ol_001"],
  ])("accepts %j", (schema, id) => {
    expect(schema.safeParse(id).success).toBe(true);
  });

  it.each([
    [GameIdSchema, "world_01"], // 缺 game_ 前缀
    [SceneIdSchema, "dc_abc"], // 前缀类型不符
    [SceneIdSchema, "sc_"], // 空后缀
    [EdgeIdSchema, "eg_有中文"], // 后缀字符集外
    [OutlineNodeIdSchema, "ol_ a"], // 后缀含空格
  ])("rejects %j", (schema, id) => {
    expect(schema.safeParse(id).success).toBe(false);
  });
});

describe("game storage layout", () => {
  it("matches the frozen layout (design §9)", () => {
    expect(GAME_STORAGE_LAYOUT.worldCanon).toBe("world/canon.json");
    expect(GAME_STORAGE_LAYOUT.outline).toBe("outline.json");
    expect(GAME_STORAGE_LAYOUT.scenes).toBe("graph/scenes.jsonl");
    expect(GAME_STORAGE_LAYOUT.decisions).toBe("graph/decisions.jsonl");
    expect(GAME_STORAGE_LAYOUT.edges).toBe("graph/edges.jsonl");
    expect(GAME_STORAGE_LAYOUT.endings).toBe("graph/endings.jsonl");
    expect(GAME_STORAGE_LAYOUT.runs).toBe("graph/runs.jsonl");
    expect(GAME_STORAGE_LAYOUT.cursor).toBe("cursor.json");
    expect(GAME_STORAGE_LAYOUT.stats).toBe("stats.json");
    expect(GAME_STORAGE_LAYOUT.assetsCatalog).toBe("assets/resources.yaml");
  });

  it("derives per-edge payload and per-decision snapshot paths", () => {
    expect(edgePayloadPath("eg_001")).toBe("graph/payloads/eg_001.jsonl");
    expect(decisionSnapshotPath("dc_001")).toBe("graph/snapshots/dc_001.json");
  });
});
