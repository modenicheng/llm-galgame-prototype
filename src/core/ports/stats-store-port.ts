/**
 * StatsStore port（执行清单 M5.4 ①）——世界级结算统计（结局达成 + 边通过）。
 * 周目完结时由协调器调用；实现方保证按 (周目) 幂等（重放不重复计）。
 */

export interface StatsSnapshot {
  /** 已结算周目（幂等留痕）。 */
  settledRuns: string[];
  /** 结局达成计数：键 = EndingNode id。 */
  endings: Array<{ id: string; count: number }>;
  /** 边通过计数：键 = EdgeId，值 = 首次通过的不重复周目数。 */
  edges: Array<{ id: string; count: number }>;
}

export interface StatsStorePort {
  load(): Promise<StatsSnapshot>;
  /** 同一周目重复结算为 no-op。 */
  recordSettlement(
    runId: string,
    endingId: string,
    traversedEdgeIds: readonly string[],
  ): Promise<StatsSnapshot>;
}
