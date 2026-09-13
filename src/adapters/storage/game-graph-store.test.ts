/**
 * GameGraphStore 测试（§9 布局 / M1.2）——真源拆分、latest-wins、
 * 损坏容忍与结构级抛错的边界。
 */
import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameGraphStore } from "./game-graph-store.js";
import { GAME_STORAGE_LAYOUT, decisionSnapshotPath, edgePayloadPath } from "../../core/graph/ids.js";
import { makeDecision, makeEdge, makeSnapshot } from "../../core/graph/testing.js";
import type { StoredEvent } from "../../schema.js";

function makeStoredEvent(seq: number): StoredEvent {
  return {
    seq,
    turn: 1,
    timestamp: new Date().toISOString(),
    source: "model",
    type: "narration",
    text: `Event ${seq}`,
    line_id: `line-${seq}`,
  } as StoredEvent;
}

const GAME_ID = "game_test1";

/** 每个用例独立的临时 game 目录。 */
async function makeStore(): Promise<{ store: GameGraphStore; gameDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "galgame-graph-"));
  const store = new GameGraphStore(root, GAME_ID);
  await store.initialize();
  return { store, gameDir: path.join(root, GAME_ID) };
}

describe("GameGraphStore 布局", () => {
  it("rejects an invalid gameId", () => {
    expect(() => new GameGraphStore("/tmp", "bad-id")).toThrow();
  });

  it("creates payloads and snapshots dirs under games/<gameId>", async () => {
    const { gameDir } = await makeStore();
    try {
      expect(existsSync(path.join(gameDir, GAME_STORAGE_LAYOUT.payloadsDir))).toBe(true);
      expect(existsSync(path.join(gameDir, GAME_STORAGE_LAYOUT.snapshotsDir))).toBe(true);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });
});

describe("决策节点：快照唯一真源", () => {
  it("roundtrips a decision node through index + snapshot files", async () => {
    const { store, gameDir } = await makeStore();
    try {
      const node = makeDecision({ id: "dc_a1", sceneId: "sc_s1" });
      await store.putDecision(node);

      expect(await store.getDecision("dc_a1")).toEqual(node);
      expect(existsSync(path.join(gameDir, decisionSnapshotPath("dc_a1")))).toBe(true);
      // 索引行不含 entryState（entryState 唯一物理真源 = 快照文件）
      const decisionsRaw = await readFile(path.join(gameDir, GAME_STORAGE_LAYOUT.decisions), "utf8");
      expect(decisionsRaw).not.toContain("entryState");
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("returns null for an unknown decision and throws when the snapshot is missing", async () => {
    const { store, gameDir } = await makeStore();
    try {
      expect(await store.getDecision("dc_none")).toBeNull();

      await store.putDecision(makeDecision({ id: "dc_x1" }));
      await rm(path.join(gameDir, decisionSnapshotPath("dc_x1")));
      await expect(store.getDecision("dc_x1")).rejects.toThrow(/快照缺失/);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("lists decisions with composed entry states", async () => {
    const { store, gameDir } = await makeStore();
    try {
      await store.putDecision(makeDecision({ id: "dc_b1" }));
      await store.putDecision(makeDecision({ id: "dc_b2" }));
      const nodes = await store.listDecisions();
      expect(nodes.map((n) => n.id).sort()).toEqual(["dc_b1", "dc_b2"]);
      expect(nodes[0]?.entryState.snapshotVersion).toBe(1);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });
});

describe("边：endState 派生与门禁", () => {
  it("accepts an edge whose endState equals the successor entry snapshot", async () => {
    const { store, gameDir } = await makeStore();
    try {
      const entry = makeSnapshot({ outlineRevision: 4 });
      await store.putDecision(makeDecision({ id: "dc_c1" }));
      await store.putDecision(makeDecision({ id: "dc_c2", entryState: entry }));
      await store.putEdge(
        makeEdge({
          id: "eg_c1",
          from: "dc_c1",
          to: { kind: "decision", id: "dc_c2" },
          endState: entry,
        }),
      );

      const edges = await store.listEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0]?.endState).toEqual(entry);
      expect(edges[0]?.to).toEqual({ kind: "decision", id: "dc_c2" });
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("throws when the endState diverges from the successor snapshot", async () => {
    const { store, gameDir } = await makeStore();
    try {
      await store.putDecision(makeDecision({ id: "dc_d1" }));
      await store.putDecision(
        makeDecision({ id: "dc_d2", entryState: makeSnapshot({ outlineRevision: 9 }) }),
      );
      await expect(
        store.putEdge(
          makeEdge({
            id: "eg_d1",
            from: "dc_d1",
            to: { kind: "decision", id: "dc_d2" },
            endState: makeSnapshot({ outlineRevision: 1 }),
          }),
        ),
      ).rejects.toThrow(/不一致/);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("stores an ending-pointed edge inline and composes it back", async () => {
    const { store, gameDir } = await makeStore();
    try {
      const endState = makeSnapshot({ outlineRevision: 2 });
      await store.putDecision(makeDecision({ id: "dc_e1" }));
      await store.putEdge(
        makeEdge({
          id: "eg_e1",
          from: "dc_e1",
          to: { kind: "ending", id: "end_e1" },
          endState,
        }),
      );
      const edges = await store.listEdges();
      expect(edges[0]?.to).toEqual({ kind: "ending", id: "end_e1" });
      expect(edges[0]?.endState).toEqual(endState);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("keeps the latest record when an edge id is written twice (latest-wins)", async () => {
    const { store, gameDir } = await makeStore();
    try {
      await store.putDecision(makeDecision({ id: "dc_f1" }));
      await store.putDecision(makeDecision({ id: "dc_f2" }));
      const endState = makeSnapshot();
      await store.putEdge(
        makeEdge({ id: "eg_f1", from: "dc_f1", to: { kind: "decision", id: "dc_f2" }, endState }),
      );
      await store.putEdge(
        makeEdge({
          id: "eg_f1",
          from: "dc_f1",
          to: { kind: "decision", id: "dc_f2" },
          endState,
          confluence: {
            matchedNode: "dc_f2",
            judgedBy: "director",
            confidence: 0.9,
            rationale: "同末态",
          },
        }),
      );
      const edges = await store.listEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0]?.confluence?.judgedBy).toBe("director");
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });
});

describe("payload 与游标", () => {
  it("appends, reads, and deletes edge payload events in order", async () => {
    const { store, gameDir } = await makeStore();
    try {
      await store.appendPayload("eg_p1", makeStoredEvent(3));
      await store.appendPayload("eg_p1", makeStoredEvent(4));
      expect((await store.readPayload("eg_p1")).map((e) => e.seq)).toEqual([3, 4]);
      expect(await store.readPayload("eg_missing")).toEqual([]);

      expect(existsSync(path.join(gameDir, edgePayloadPath("eg_p1")))).toBe(true);
      await store.deletePayload("eg_p1");
      expect(existsSync(path.join(gameDir, edgePayloadPath("eg_p1")))).toBe(false);
      await expect(store.deletePayload("eg_p1")).resolves.toBeUndefined();
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("skips malformed payload lines without hiding the rest", async () => {
    const { store, gameDir } = await makeStore();
    try {
      await store.appendPayload("eg_g1", makeStoredEvent(1));
      await appendFile(path.join(gameDir, edgePayloadPath("eg_g1")), "{broken\n", "utf8");
      await store.appendPayload("eg_g1", makeStoredEvent(2));
      expect((await store.readPayload("eg_g1")).map((e) => e.seq)).toEqual([1, 2]);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("roundtrips the cursor and reads a missing or corrupt cursor as null", async () => {
    const { store, gameDir } = await makeStore();
    try {
      expect(await store.loadCursor()).toBeNull();
      await store.putRun({ id: "run_r1", origin: { kind: "root" }, startedAt: "t1" });
      await store.saveCursor({ runId: "run_r1", position: "dc_p1" });
      expect(await store.loadCursor()).toEqual({ runId: "run_r1", position: "dc_p1" });
      expect((await store.getRun("run_r1"))?.origin).toEqual({ kind: "root" });
      expect(await store.getRun("run_none")).toBeNull();

      await writeFile(path.join(gameDir, GAME_STORAGE_LAYOUT.cursor), "{oops", "utf8");
      expect(await store.loadCursor()).toBeNull();
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });
});
