/**
 * StatsStore 测试（执行清单 M5.4 ① 验收）：增量计数 + 幂等（同一周目
 * 重复结算/重放不重复计）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StatsStore } from "./stats-store.js";

describe("StatsStore", () => {
  let root: string;
  let stats: StatsStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "stats-store-"));
    stats = new StatsStore(root, "game_stats");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("starts empty, increments on settlement, and is idempotent per run", async () => {
    // 新周目首次结算：结局 +1，路径边各 +1。
    await stats.recordSettlement("run_a", "end_fin", ["eg_1", "eg_2"]);
    let snap = await stats.load();
    expect(snap.settledRuns).toEqual(["run_a"]);
    expect(snap.endings).toEqual([{ id: "end_fin", count: 1 }]);
    expect(snap.edges).toEqual([
      { id: "eg_1", count: 1 },
      { id: "eg_2", count: 1 },
    ]);

    // 同一周目重复结算（重放/重入）：no-op。
    await stats.recordSettlement("run_a", "end_fin", ["eg_1", "eg_2"]);
    snap = await stats.load();
    expect(snap.settledRuns).toHaveLength(1);
    expect(snap.endings[0]!.count).toBe(1);
    expect(snap.edges.every((e) => e.count === 1)).toBe(true);

    // 第二个周目经其中一条边到达另一结局：该边 +1、新结局 +1。
    await stats.recordSettlement("run_b", "end_true", ["eg_1", "eg_3"]);
    snap = await stats.load();
    expect(snap.settledRuns).toEqual(["run_a", "run_b"]);
    expect(snap.endings.map((e) => e.count).sort()).toEqual([1, 1]);
    expect(snap.edges.find((e) => e.id === "eg_1")!.count).toBe(2);
    expect(snap.edges.find((e) => e.id === "eg_3")!.count).toBe(1);
  });

  it("throws loudly on a corrupt stats.json", async () => {
    await stats.recordSettlement("run_a", "end_fin", []);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(root, "game_stats", "stats.json"),
      "{ corrupt",
      "utf8",
    );
    await expect(new StatsStore(root, "game_stats").load()).rejects.toThrow();
  });
});
