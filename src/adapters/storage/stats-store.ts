/**
 * StatsStore adapter（执行清单 M5.4 ①）——`games/<gameId>/stats.json`（§9
 * 布局常量 GAME_STORAGE_LAYOUT.stats）。
 *
 * 结局达成计数 + 边通过计数。纪律：每个周目只结算一次（settledRuns 留痕，
 * 幂等——重放/重复结算不重复计数，tmp+rename 原子写）。键用「结局名 =
 * EndingNode id 去前缀」（模型声明的结局语义名跨周目稳定，运行时生成的
 * 边/节点随机 id 不入 stats——按周目路径回放的边 id 统计通过次数）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GAME_STORAGE_LAYOUT } from "../../core/graph/ids.js";
import type { StatsSnapshot, StatsStorePort } from "../../core/ports/stats-store-port.js";

const StatsFileSchema = z.object({
  /** 已结算周目（幂等留痕：重复结算不再计数）。 */
  settledRuns: z.array(z.string().min(1)),
  /** 结局达成计数：键 = EndingNode id（end_<语义名>）。 */
  endings: z.array(z.object({ id: z.string().min(1), count: z.number().int().positive() })),
  /** 边通过计数：键 = EdgeId，值 = 首次通过的不重复周目数。 */
  edges: z.array(z.object({ id: z.string().min(1), count: z.number().int().positive() })),
});

export type { StatsSnapshot };

export class StatsStore implements StatsStorePort {
  private readonly filePath: string;
  private snapshot: StatsSnapshot | null = null;

  constructor(private readonly gamesRoot: string, private readonly gameId: string) {
    this.filePath = path.join(path.resolve(gamesRoot), gameId, GAME_STORAGE_LAYOUT.stats);
  }

  /** 读宽容：缺文件 = 空统计；损坏大声抛错（统计损坏即不可信）。 */
  async load(): Promise<StatsSnapshot> {
    if (this.snapshot !== null) return this.snapshot;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        this.snapshot = { settledRuns: [], endings: [], edges: [] };
        return this.snapshot;
      }
      throw err;
    }
    const checked = StatsFileSchema.parse(JSON.parse(raw));
    this.snapshot = checked;
    return this.snapshot;
  }

  /**
   * 结算一个完结周目：结局 +1，路径上每条边 +1。同一周目重复结算为
   * no-op（幂等——重放路径不重复计）。
   */
  async recordSettlement(runId: string, endingId: string, traversedEdgeIds: readonly string[]): Promise<StatsSnapshot> {
    const current = await this.load();
    if (current.settledRuns.includes(runId)) return current;

    const next: StatsSnapshot = {
      settledRuns: [...current.settledRuns, runId],
      endings: bump(current.endings, endingId),
      edges: bumpAll(current.edges, traversedEdgeIds),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
    this.snapshot = next;
    return next;
  }
}

function bump(entries: Array<{ id: string; count: number }>, id: string): Array<{ id: string; count: number }> {
  const found = entries.find((e) => e.id === id);
  if (found === undefined) return [...entries, { id, count: 1 }];
  return entries.map((e) => (e.id === id ? { ...e, count: e.count + 1 } : e));
}

function bumpAll(
  entries: Array<{ id: string; count: number }>,
  ids: readonly string[],
): Array<{ id: string; count: number }> {
  let next = [...entries];
  for (const id of ids) next = bump(next, id);
  return next;
}
