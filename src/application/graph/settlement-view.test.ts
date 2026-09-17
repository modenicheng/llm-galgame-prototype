/**
 * 结算/图鉴视图测试（执行清单 M5.4 ②③ 验收）：结算聚合（结局文本、
 * 大纲完成度、伏笔回收率挂接）、图鉴不剧透断言（未达成只给「???"，
 * outline purpose/location 零泄漏）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameGraphStore } from "../../adapters/storage/game-graph-store.js";
import { OutlineStore } from "../../adapters/storage/outline-store.js";
import { StatsStore } from "../../adapters/storage/stats-store.js";
import { buildSettlementView, buildGalleryView } from "./graph-view.js";
import { makeDecision, makeEdge, makeSnapshot } from "../../core/graph/testing.js";
import type { StoredEvent } from "../../schema.js";

function endEvent(seq: number, text: string): StoredEvent {
  return { seq, turn: 1, timestamp: new Date().toISOString(), source: "model", type: "end", ending_id: `end_${seq}`, text } as StoredEvent;
}

describe("settlement + gallery views (M5.4)", () => {
  let root: string;
  let graph: GameGraphStore;
  let outline: OutlineStore;
  let stats: StatsStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "settlement-"));
    graph = new GameGraphStore(root, "game_settle");
    await graph.initialize();
    outline = new OutlineStore(root, "game_settle");
    stats = new StatsStore(root, "game_settle");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("aggregates the latest ended run: ending text, outline progress, payoff rate, stats", async () => {
    // 大纲：2 幕（1 realized 1 active）→ 完成度 1/2；一个结局候选。
    await outline.load();
    await outline.applyRevision([
      { type: "add", node: { id: "ol_act1", purpose: "第一幕", kind: "act", status: "planned" } },
      { type: "add", node: { id: "ol_act2", purpose: "第二幕", kind: "act", status: "planned" } },
    ], "测试大纲");
    await outline.applyRevision([{ type: "activate", id: "ol_act1" }], "第一幕开演");
    await outline.applyRevision([{ type: "realize", id: "ol_act1", instantiatedBy: "sc_1" }], "第一幕演完");

    // 图：D1 →（负载含 @end）→ 结局 end_true；周目完结。
    await graph.putDecision(makeDecision({ id: "dc_1" }));
    await graph.appendPayload("eg_1", endEvent(1, "雨停了，故事落幕。"));
    await graph.putEdge(
      makeEdge({
        id: "eg_1",
        from: "dc_1",
        payload: { eventCount: 1, firstSeq: 1, lastSeq: 1 },
        endState: makeSnapshot(),
        to: { kind: "ending", id: "end_true" },
      }),
    );
    await graph.putEnding({ id: "end_true" });
    await graph.putRun({ id: "run_1", origin: { kind: "root" }, startedAt: "t", endedAt: "t2", ending: "end_true" });
    await stats.recordSettlement("run_1", "end_true", ["eg_1"]);

    // 会话 ending-report（伏笔回收率）。
    const sessionsDir = path.join(root, "sessions", "sess-1");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, "ending-report.json"),
      JSON.stringify({ generatedAt: "t", setups: { paidOff: 2, dropped: 1, active: 1, payoffRate: 0.5 }, threads: { resolved: 1, abandoned: 0, active: 0 }, lessons: [] }),
      "utf8",
    );

    const view = await buildSettlementView({
      gameId: "game_settle",
      graph,
      outline,
      stats,
      sessionsDir: path.join(root, "sessions"),
      sessionId: "sess-1",
    });
    expect(view.endingId).toBe("end_true");
    expect(view.endingText).toBe("雨停了，故事落幕。");
    expect(view.outlineProgress).toEqual({ realized: 1, total: 2 });
    expect(view.payoffRate).toBe(0.5);
    expect(view.endingsAchieved).toBe(1);
    expect(view.edgesTraversed).toBeGreaterThanOrEqual(1);
  });

  it("gallery hides unachieved endings behind '???' and leaks no outline text", async () => {
    // 大纲两个结局候选：真结局（玩家没达成）带剧透 purpose/location。
    await outline.load();
    await outline.applyRevision([
      { type: "add", node: { id: "ol_end_true", purpose: "真结局：知晓终端真相", kind: "ending", status: "planned" } },
      { type: "add", node: { id: "ol_end_fin", purpose: "普通结局", kind: "ending", status: "planned" } },
    ], "测试大纲结局");

    // 玩家达成 end_fin（1 次）。
    await stats.recordSettlement("run_1", "end_fin", []);

    const view = await buildGalleryView({ gameId: "game_settle", graph, outline, stats });
    const json = JSON.stringify(view);

    // 已达成：语义名 + 次数。
    const fin = view.entries.find((e) => e.key === "end_fin")!;
    expect(fin.achieved).toBe(true);
    expect(fin.label).toBe("fin");
    expect(fin.count).toBe(1);

    // 未达成：只给「???」——outline 的 purpose / 副本细节零泄漏。
    const secret = view.entries.find((e) => e.key === "ol_end_true")!;
    expect(secret.achieved).toBe(false);
    expect(secret.label).toBe("???");
    expect(json).not.toContain("知晓终端真相");
    expect(json).not.toContain("真结局");
    expect(view.achievedCount).toBe(1);
  });
});
