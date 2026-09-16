/**
 * CanonPromoter（执行清单 M3.6 ②）——跨周目 major facts 的后台晋升管线。
 *
 * 触发时机：周目完结或弃局（bootstrap 在 session_ended / restart 弃局后
 * fire-and-forget）。范围：**全部周目（含已弃，决议 D7）**的末态/游标快照——
 * 完结周目取其 ending 边的 endState，弃局周目取 abandonedAt 决策的入口快照；
 * 活跃周目跳过（尚未定格）。
 *
 * 晋升门（§5.1）：同一内容（trim 后全等）出现在 **≥2 个不同周目**的
 * major 未废止 facts 里才成为候选——单周目事实只是该周目的局部剧情。
 * 候选交编剧裁决变体 adjudicateCanon（单次 JSON）：晋升 / 例外登记
 * （矛盾事实过不了门，例外必须附补偿限制）。晋升不回改既有快照（D6）。
 */

import type { CanonOp, CanonStorePort } from "../../core/ports/canon-store-port.js";
import type { GraphStorePort } from "../../core/ports/graph-store-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { FactRecord } from "../../core/narrative/memory-types.js";

/** 送裁决的候选：跨周目佐证过的 major fact。 */
export interface CanonCandidate {
  id: string;
  content: string;
  /** 佐证周目 id（≥2，含已弃周目）。 */
  evidenceRuns: string[];
}

/** 编剧裁决变体 port（单次 JSON 调用，与 writeOutline/maintainOutline 同族）。 */
export interface CanonAdjudicatorPort {
  adjudicateCanon(request: {
    candidates: CanonCandidate[];
    existing: {
      promotedFacts: Array<{ id: string; content: string }>;
      exceptions: Array<{ id: string; content: string; compensatingLimit: string }>;
    };
  }): Promise<CanonOp[]>;
}

export interface CanonPromotionResult {
  /** 参与收集的已定格周目数（完结 + 弃局）。 */
  settledRuns: number;
  /** 送裁决的候选数（≥2 周目佐证）。 */
  candidates: number;
  promoted: number;
  exceptions: number;
}

export class CanonPromoter {
  private readonly graph: GraphStorePort;
  private readonly canon: CanonStorePort;
  private readonly adjudicator: CanonAdjudicatorPort;
  private readonly diagnostics: DiagnosticSink;
  private running: Promise<CanonPromotionResult> | null = null;

  constructor(options: {
    graph: GraphStorePort;
    canon: CanonStorePort;
    adjudicator: CanonAdjudicatorPort;
    diagnostics?: DiagnosticSink;
  }) {
    this.graph = options.graph;
    this.canon = options.canon;
    this.adjudicator = options.adjudicator;
    this.diagnostics = options.diagnostics ?? silentDiagnosticSink;
  }

  /**
   * 跑一轮晋升（后台串行：重复触发合并到在途批次，不并发写 canon）。
   * 失败只告警——晋升是增强，绝不阻塞游玩。
   */
  promoteFromRuns(): Promise<CanonPromotionResult> {
    if (this.running !== null) return this.running;
    this.running = this.promoteUnsafe()
      .catch((err: unknown) => {
        this.diagnostics.warn("CanonPromoter", `promotion failed: ${String(err)}`);
        return { settledRuns: 0, candidates: 0, promoted: 0, exceptions: 0 };
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async promoteUnsafe(): Promise<CanonPromotionResult> {
    const canonSnap = await this.canon.load();

    // 1. 收集全部已定格周目（完结/弃局，含已弃——决议 D7）的 major facts。
    const runs = await this.graph.listRuns();
    const edges = await this.graph.listEdges();
    const endingEdgeByEndingId = new Map(
      edges
        .filter((e) => e.to.kind === "ending")
        .map((e) => [e.to.id, e.endState.memoryDigest.facts]),
    );
    const factsByRun = new Map<string, FactRecord[]>();
    for (const run of runs) {
      let facts: FactRecord[] | undefined;
      if (run.ending !== undefined) {
        facts = endingEdgeByEndingId.get(run.ending);
      } else if (run.abandonedAt !== undefined) {
        const decision = await this.graph.getDecision(run.abandonedAt);
        facts = decision?.entryState.memoryDigest.facts;
      }
      // 活跃周目（无 ending 无 abandonedAt）尚未定格，跳过。
      if (facts === undefined) continue;
      factsByRun.set(run.id, facts);
    }

    // 2. 跨周目佐证分组：内容 trim 全等 → ≥2 个不同周目 = 候选。
    const existingContent = new Set(canonSnap.promotedFacts.map((f) => f.content));
    const existingExceptionContent = new Set(canonSnap.exceptions.map((e) => e.content));
    const runsByContent = new Map<string, Set<string>>();
    const idByContent = new Map<string, string>();
    for (const [runId, facts] of factsByRun) {
      for (const fact of facts) {
        if (fact.importance !== "major" || fact.superseded) continue;
        const key = fact.content.trim();
        if (!runsByContent.has(key)) runsByContent.set(key, new Set());
        runsByContent.get(key)!.add(runId);
        if (!idByContent.has(key)) idByContent.set(key, fact.id);
      }
    }
    const candidates: CanonCandidate[] = [];
    for (const [content, runIds] of runsByContent) {
      if (runIds.size < 2) continue; // 单周目事实不晋升
      if (existingContent.has(content)) continue; // 已在 canon，幂等跳过
      if (existingExceptionContent.has(content)) continue; // 已登记例外
      candidates.push({
        id: idByContent.get(content)!,
        content,
        evidenceRuns: [...runIds].sort(),
      });
    }
    if (candidates.length === 0) {
      return { settledRuns: factsByRun.size, candidates: 0, promoted: 0, exceptions: 0 };
    }

    // 3. 编剧裁决（单次 JSON）→ 4. 落盘（store 整批校验 + 留痕）。
    const ops = await this.adjudicator.adjudicateCanon({
      candidates,
      existing: {
        promotedFacts: canonSnap.promotedFacts.map((f) => ({ id: f.id, content: f.content })),
        exceptions: canonSnap.exceptions.map((e) => ({
          id: e.id,
          content: e.content,
          compensatingLimit: e.compensatingLimit,
        })),
      },
    });
    if (ops.length === 0) {
      return { settledRuns: factsByRun.size, candidates: candidates.length, promoted: 0, exceptions: 0 };
    }
    await this.canon.applyPromotion(
      ops,
      `跨周目事实晋升（${candidates.length} 候选 / ${factsByRun.size} 已定格周目）`,
    );
    return {
      settledRuns: factsByRun.size,
      candidates: candidates.length,
      promoted: ops.filter((o) => o.type === "promote").length,
      exceptions: ops.filter((o) => o.type === "exception").length,
    };
  }
}
