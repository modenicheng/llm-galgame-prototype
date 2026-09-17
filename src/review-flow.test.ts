/**
 * M5.5 测试：评分落盘（ReviewStore 往返）、评价喂回输入包含断言
 * （维护请求携带历史评注）、大纲回顾通关解锁（未通关负面断言）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReviewStore } from "./adapters/storage/review-store.js";
import { OutlineWriterAdapter } from "./adapters/llm/outline-writer-adapter.js";
import { buildGraphView } from "./application/graph/graph-view.js";
import { GameGraphStore } from "./adapters/storage/game-graph-store.js";
import { OutlineStore } from "./adapters/storage/outline-store.js";
import { StatsStore } from "./adapters/storage/stats-store.js";
import { makeDecision, makeSnapshot } from "./core/graph/testing.js";
import { MemoryDigestSchema } from "./core/graph/types.js";

describe("ReviewStore", () => {
  let root: string;
  let store: ReviewStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "review-store-"));
    store = new ReviewStore(root, "game_review");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves, loads, and lists run reviews", async () => {
    await store.save({ runId: "run_1", rating: 4, comment: "伏笔回收干净。", outlineFit: "贴合第一幕。", reviewedAt: "2026-09-17T00:00:00.000Z" });
    await store.save({ runId: "run_2", rating: 2, comment: "中段赶工。", outlineFit: "偏离主线。", reviewedAt: "2026-09-17T01:00:00.000Z" });
    const loaded = await store.load("run_1");
    expect(loaded?.rating).toBe(4);
    expect(loaded?.comment).toContain("伏笔");
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(await store.load("run_missing")).toBeNull();
  });
});

describe("M5.5 评价喂回（维护请求携带评注）", () => {
  it("renders historical reviews into the maintenance prompt", async () => {
    const captured: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fakeClient = {
      chat: {
        completions: {
          create: vi.fn(async (request: { messages: Array<{ role: string; content: string }> }) => {
            captured.push(request);
            return { choices: [{ message: { content: JSON.stringify({ ops: [] }) } }] };
          }),
        },
      },
    };
    const adapter = new OutlineWriterAdapter({
      apiKey: "k",
      api: { model: "m", base_url: "http://127.0.0.1:1", timeout_ms: 1000 } as never,
      client: fakeClient as never,
    });
    await adapter.maintainOutline({
      outline: [{ id: "ol_act1", purpose: "第一幕", kind: "act", status: "active" }],
      recentSummary: "摘要",
      memoryDigest: MemoryDigestSchema.parse({
        revision: 0, consolidatedThroughEventSeq: 0, checkpointCount: 0,
        threads: [], setups: [], anchors: [], facts: [], beliefs: [],
      }),
      reviews: [
        { runId: "run_1", rating: 5, comment: "回收惊艳", outlineFit: "完全贴合", reviewedAt: "t" },
      ],
    });
    const userContent = captured[0]!.messages.find((m) => m.role === "user")!.content;
    expect(userContent).toContain("历史通关评注");
    expect(userContent).toContain("回收惊艳");
    expect(userContent).toContain("完全贴合");
  });
});

describe("M5.5 大纲回顾通关解锁", () => {
  let root: string;
  let graph: GameGraphStore;
  let outline: OutlineStore;
  let stats: StatsStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "review-unlock-"));
    graph = new GameGraphStore(root, "game_unlock");
    await graph.initialize();
    outline = new OutlineStore(root, "game_unlock");
    stats = new StatsStore(root, "game_unlock");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("withholds outlineReview until a run has been settled; reveals it after", async () => {
    await outline.load();
    await outline.applyRevision(
      [{ type: "add", node: { id: "ol_act1", purpose: "第一幕：相识", kind: "act", status: "planned", location: "教室" } }],
      "大纲",
    );

    await graph.putDecision(makeDecision({ id: "dc_1" }));

    // 未通关：大纲回顾不返回（负面断言）。
    const locked = await buildGraphView({ gameId: "game_unlock", graph, outline, stats });
    expect(locked.outlineReview).toBeUndefined();
    expect(JSON.stringify(locked)).not.toContain("第一幕：相识");

    // 通关（结算一次周目）后：解锁大纲回顾（路径触及的 act 已被激活）。
    await stats.recordSettlement("run_1", "end_fin", []);
    await outline.applyRevision([{ type: "activate", id: "ol_act1" }], "第一幕开演");
    const unlocked = await buildGraphView({ gameId: "game_unlock", graph, outline, stats });
    expect(unlocked.outlineReview).toBeDefined();
    expect(unlocked.outlineReview?.acts[0]?.id).toBe("ol_act1");
    expect(unlocked.outlineReview?.acts[0]?.location).toBe("教室");
    expect(unlocked.outlineReview?.endings).toEqual([
      { id: "end_fin", label: "fin", count: 1 },
    ]);
  });

  it("typechecks the snapshot factory still produces valid digests", () => {
    expect(makeSnapshot().snapshotVersion).toBe(3);
  });
});
