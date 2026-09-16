/**
 * CanonPromoter tests（执行清单 M3.6 ② 验收）：双周目同 fact 晋升、
 * 单周目不晋升、例外登记留痕、已定格周目范围（含已弃，D7）、幂等。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameGraphStore } from "../../adapters/storage/game-graph-store.js";
import { CanonStore } from "../../adapters/storage/canon-store.js";
import { CanonPromoter } from "./canon-promoter.js";
import type { CanonAdjudicatorPort, CanonCandidate } from "./canon-promoter.js";
import type { CanonOp } from "../../core/ports/canon-store-port.js";
import type { FactRecord } from "../../core/narrative/memory-types.js";
import type { MemoryDigest, PlotEdge, RunRecord } from "../../core/graph/types.js";
import { makeDecision, makeEdge, makeSnapshot } from "../../core/graph/testing.js";
import { GAME_STORAGE_LAYOUT } from "../../core/graph/ids.js";

function makeFact(overrides: Partial<FactRecord> & { id: string; content: string }): FactRecord {
  return {
    evidenceEventSeqs: [1],
    checkpoint: 1,
    superseded: false,
    importance: "major",
    ...overrides,
  };
}

function digestWithFacts(facts: FactRecord[]): MemoryDigest {
  return {
    revision: 0,
    consolidatedThroughEventSeq: 0,
    checkpointCount: 0,
    threads: [],
    setups: [],
    anchors: [],
    beliefs: [],
    facts,
  };
}

function makeRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  return {
    origin: { kind: "root" },
    startedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

/** 弃局周目：游标决策（entryState 携带 facts）+ run 记录 abandonedAt。 */
async function seedAbandonedRun(
  graph: GameGraphStore,
  runId: string,
  decisionId: string,
  facts: FactRecord[],
): Promise<void> {
  await graph.putDecision(
    makeDecision({ id: decisionId, entryState: makeSnapshot({ memoryDigest: digestWithFacts(facts) }) }),
  );
  await graph.putRun(makeRun({ id: runId, abandonedAt: decisionId }));
}

/** 完结周目：ending 边（endState 携带末态 facts）+ run 记录 ending。 */
async function seedEndedRun(
  graph: GameGraphStore,
  runId: string,
  endingId: string,
  facts: FactRecord[],
): Promise<void> {
  await graph.putDecision(makeDecision({ id: `dc_${runId}` }));
  const endEdge: PlotEdge = {
    ...makeEdge({ id: `eg_${runId}`, from: `dc_${runId}` }),
    endState: makeSnapshot({ memoryDigest: digestWithFacts(facts) }),
    to: { kind: "ending", id: endingId },
  };
  await graph.putEdge(endEdge);
  await graph.putEnding({ id: endingId });
  await graph.putRun(makeRun({ id: runId, endedAt: "2026-09-17T01:00:00.000Z", ending: endingId }));
}

describe("CanonPromoter", () => {
  let root: string;
  let graph: GameGraphStore;
  let canon: CanonStore;
  let adjudicate: ReturnType<typeof vi.fn>;
  let promoter: CanonPromoter;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "canon-promoter-"));
    graph = new GameGraphStore(root, "game_promoter_test");
    await graph.initialize();
    canon = new CanonStore(root, "game_promoter_test");
    adjudicate = vi.fn(async (): Promise<CanonOp[]> => []);
    promoter = new CanonPromoter({
      graph,
      canon,
      adjudicator: { adjudicateCanon: adjudicate } as unknown as CanonAdjudicatorPort,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const logPath = () =>
    path.join(root, "game_promoter_test", GAME_STORAGE_LAYOUT.worldCanonLog);

  it("promotes a fact corroborated by two runs and skips single-run facts", async () => {
    const shared = "旧终端连通着废弃的广播站。";
    const single = "只有 run_a 见过的猫。";

    await seedEndedRun(graph, "run_a", "end_a", [
      makeFact({ id: "f_shared_a", content: shared }),
      makeFact({ id: "f_single", content: single }),
    ]);
    await seedAbandonedRun(graph, "run_b", "dc_b1", [
      makeFact({ id: "f_shared_b", content: shared }),
    ]);
    // 活跃周目（无 ending 无 abandonedAt）——尚未定格，跳过。
    await graph.putRun(makeRun({ id: "run_c" }));

    adjudicate.mockImplementation(async (req: { candidates: CanonCandidate[] }) => {
      expect(req.candidates).toHaveLength(1);
      expect(req.candidates[0]!.content).toBe(shared);
      expect(req.candidates[0]!.evidenceRuns).toEqual(["run_a", "run_b"]);
      return [
        { type: "promote", fact: { id: "canon_1", content: shared, evidenceRuns: ["run_a", "run_b"] } },
      ];
    });

    const result = await promoter.promoteFromRuns();
    expect(result.settledRuns).toBe(2); // run_c 活跃，不计入
    expect(result.candidates).toBe(1);
    expect(result.promoted).toBe(1);

    const snap = await canon.load();
    expect(snap.promotedFacts).toHaveLength(1);
    expect(snap.promotedFacts[0]!.judgedBy).toBe("canon-adjudicator");
    expect(snap.promotedFacts[0]!.promotedAt).toBeTruthy();
    // 单周目事实（run_a 独有）没有成为候选 → 不在 canon。
    expect(snap.promotedFacts.some((f) => f.content === single)).toBe(false);
  });

  it("registers an exception with its compensating limit and leaves a log trail", async () => {
    const shared = "苏遥在两个周目里都记得前世的雨。";
    await seedAbandonedRun(graph, "run_a", "dc_x0", [makeFact({ id: "f_x0", content: shared })]);
    await seedAbandonedRun(graph, "run_b", "dc_x1", [makeFact({ id: "f_x1", content: shared })]);
    adjudicate.mockResolvedValue([
      {
        type: "exception",
        exception: {
          id: "exc_1",
          content: shared,
          reason: "与 canon 的失忆铁律矛盾",
          compensatingLimit: "仅限雨天场景",
        },
      },
    ]);

    const result = await promoter.promoteFromRuns();
    expect(result.exceptions).toBe(1);
    const snap = await canon.load();
    expect(snap.promotedFacts).toHaveLength(0);
    expect(snap.exceptions[0]!.compensatingLimit).toBe("仅限雨天场景");
    // 留痕：canon.log.jsonl 追加了含例外的修订行。
    const log = await readFile(logPath(), "utf8");
    expect(log).toContain("exc_1");
  });

  it("ignores minor and superseded facts", async () => {
    const facts = [
      makeFact({ id: "f_min", content: "次要事实", importance: "minor" }),
      makeFact({ id: "f_sup", content: "已废止事实", superseded: true }),
    ];
    await seedAbandonedRun(graph, "run_a", "dc_m0", facts);
    await seedAbandonedRun(graph, "run_b", "dc_m1", facts);
    const result = await promoter.promoteFromRuns();
    expect(result.candidates).toBe(0);
    expect(adjudicate).not.toHaveBeenCalled();
  });

  it("is idempotent: already-promoted content is not re-adjudicated", async () => {
    const shared = "操场的老槐树在两个周目里都开满花。";
    await seedAbandonedRun(graph, "run_a", "dc_i0", [makeFact({ id: "f_i0", content: shared })]);
    await seedAbandonedRun(graph, "run_b", "dc_i1", [makeFact({ id: "f_i1", content: shared })]);
    adjudicate.mockResolvedValue([
      { type: "promote", fact: { id: "canon_i", content: shared, evidenceRuns: ["run_a", "run_b"] } },
    ]);

    await promoter.promoteFromRuns();
    const second = await promoter.promoteFromRuns();
    expect(second.candidates).toBe(0); // 已在 canon，幂等跳过
    expect(adjudicate).toHaveBeenCalledTimes(1);
  });

  it("swallows adjudicator failures (warn, no throw)", async () => {
    const shared = "两个周目都出现的走廊尽头的门。";
    await seedAbandonedRun(graph, "run_a", "dc_f0", [makeFact({ id: "f_f0", content: shared })]);
    await seedAbandonedRun(graph, "run_b", "dc_f1", [makeFact({ id: "f_f1", content: shared })]);
    adjudicate.mockRejectedValue(new Error("LLM 不可达"));

    const result = await promoter.promoteFromRuns();
    expect(result.promoted).toBe(0);
    expect(result.exceptions).toBe(0);
  });
});
