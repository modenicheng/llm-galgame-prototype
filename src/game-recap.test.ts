import { describe, it, expect, vi } from "vitest";
import { Game } from "./game.js";
import type { GamePorts } from "./game.js";
import { RuntimeStatus } from "./status.js";
import { createInitialState } from "./story/state.js";
import type { RecapSummarizerPort } from "./core/ports/recap-summarizer-port.js";
import type { StoryGeneratorPort } from "./core/ports/story-generator-port.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import type { StoredEvent, StoryContextEvent } from "./schema.js";
import { makeTestConfig, makeTestPorts } from "./test-helpers.js";

/**
 * 滚动前情梗概（recap）管线 —— 2026-09-17 上下文审计落地项：
 * 历史窗口（cap 80，chunk 20 对齐）向前跳时，滑出窗口的事件被压缩成
 * 事实短记追加进 storyState.recent_summary（提示词中的 [Recap]）。
 * 白盒驱动：直接向 game.events 推事件后调 generationHistory()（生产路径
 * 中该窗口计算在每次构建生成请求时发生）。
 */

function ev(seq: number, partial: Record<string, unknown>): StoredEvent {
  return {
    seq,
    turn: Math.ceil(seq / 10),
    timestamp: "2026-09-17T00:00:00.000Z",
    source: "model",
    ...partial,
  } as unknown as StoredEvent;
}

function makeEvents(count: number): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    if (seq % 10 === 3) {
      events.push(ev(seq, { type: "interaction", prompt: `第${seq}次交互提问`, mode: "choice" }));
    } else if (seq % 10 === 4) {
      events.push(ev(seq, { type: "player_choice", text: `玩家选择${seq}` }));
    } else if (seq % 10 === 5) {
      events.push(ev(seq, { type: "dialogue", speaker: "树莓娘", text: `台词${seq}` }));
    } else {
      events.push(ev(seq, { type: "narration", text: `旁白${seq}` }));
    }
  }
  return events;
}

const mockGenerator = {
  generateOpening: vi.fn(),
  generateContinuation: vi.fn(),
  generateBranchPrefetch: vi.fn(),
  generateInputResponse: vi.fn(),
  generateInputBridge: vi.fn(),
} as unknown as StoryGeneratorPort;

const mockMedia = {} as MediaPlannerPort;

function makeGame(ports?: Partial<GamePorts>): Game {
  return new Game(
    makeTestConfig(),
    mockGenerator,
    new RuntimeStatus(),
    mockMedia,
    undefined,
    makeTestPorts(ports),
  );
}

/** 走生产路径计算窗口并等在飞的 recap 压缩落定。 */
async function driveHistory(game: Game): Promise<StoryContextEvent[]> {
  const history = (game as unknown as {
    generationHistory: () => StoryContextEvent[];
  }).generationHistory();
  const inFlight = (game as unknown as { recapInFlight: Promise<void> | null }).recapInFlight;
  if (inFlight !== null) await inFlight;
  return history;
}

async function pushEvents(game: Game, events: StoredEvent[]): Promise<void> {
  (game as unknown as { events: StoredEvent[] }).events.push(...events);
  (game as unknown as { seq: number }).seq = events[events.length - 1]!.seq + 1;
}

function recapThroughSeq(game: Game): number {
  return (game as unknown as { recapThroughSeq: number }).recapThroughSeq;
}

function recentSummary(game: Game): string {
  return (game as unknown as { storyState: { recent_summary: string } }).storyState
    .recent_summary;
}

describe("Game rolling recap", () => {
  it("folds dropped events into recent_summary when the window slides (deterministic fallback)", async () => {
    const game = makeGame();
    await pushEvents(game, makeEvents(101));

    // 101 事件 > cap 80：窗口起点 = floor((101-80)/20)*20 = 20。
    const history = await driveHistory(game);
    expect(history).toHaveLength(81); // chunk 对齐下窗口可到 cap+19
    expect(recentSummary(game)).toContain("[玩家] 选择：玩家选择4");
    expect(recentSummary(game)).toContain("[交互] 第13次交互提问");
    expect(recapThroughSeq(game)).toBe(20);
  });

  it("uses the LLM port when available and falls back when it returns null", async () => {
    const summarize = vi.fn().mockResolvedValue("LLM 摘要：玩家看了维护记录。");
    const game = makeGame({ recapSummarizer: { summarize } as RecapSummarizerPort });
    await pushEvents(game, makeEvents(101));

    await driveHistory(game);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(recentSummary(game)).toContain("LLM 摘要：玩家看了维护记录。");

    // 下一次窗口跳跃时端口失败 → 回退确定性摘要，水位照常推进。
    summarize.mockResolvedValue(null);
    await pushEvents(game, makeEvents(40)); // 141 → 起点 60
    await driveHistory(game);
    expect(recentSummary(game)).toContain("[玩家] 选择：玩家选择24");
    expect(recapThroughSeq(game)).toBe(60);
  });

  it("does not fold while total events stay within the window", async () => {
    const game = makeGame();
    await pushEvents(game, makeEvents(80));
    await driveHistory(game);
    expect(recapThroughSeq(game)).toBe(0);
    expect(recentSummary(game)).not.toContain("[玩家]");
  });

  it("persists the watermark in the snapshot and restores without re-folding", async () => {
    const ports = makeTestPorts();
    const events = makeEvents(101);
    for (const event of events) {
      await ports.store.append(event);
    }
    const game = makeGame({ store: ports.store });
    await pushEvents(game, events);
    await driveHistory(game);

    await (game as unknown as { saveCurrentStateSnapshot: () => Promise<void> })
      .saveCurrentStateSnapshot();
    const { snapshot } = await ports.store.load();
    expect(snapshot?.recapThroughSeq).toBe(20);
    expect(snapshot?.state.recent_summary).toContain("[玩家] 选择：玩家选择4");

    // 恢复：水位从快照成对还原；再次计算窗口不会重复折叠。
    const game2 = makeGame({ store: ports.store });
    (game2 as unknown as { restoreSession: (r: unknown) => void }).restoreSession(
      await ports.store.load(),
    );
    expect(recapThroughSeq(game2)).toBe(20);
    // 恢复路径本身不得调度折叠（水位恢复前的折叠会把摘要追加第二遍）。
    expect((game2 as unknown as { recapInFlight: Promise<void> | null }).recapInFlight).toBeNull();
    await driveHistory(game2);
    expect(recentSummary(game2).match(/玩家选择4/g)).toHaveLength(1);
  });

  it("treats old snapshots without a watermark as covered up to the current window start", async () => {
    const ports = makeTestPorts();
    for (const event of makeEvents(101)) {
      await ports.store.append(event);
    }
    // 旧格式快照：无 recapThroughSeq 字段。
    await ports.store.saveSnapshot({
      state: createInitialState(),
      phase: "active",
    });
    const { snapshot } = await ports.store.load();
    expect(snapshot?.recapThroughSeq).toBeUndefined();

    const game2 = makeGame({ store: ports.store });
    (game2 as unknown as { restoreSession: (r: unknown) => void }).restoreSession(
      await ports.store.load(),
    );
    // 旧快照无水位：按当前窗口起点已覆盖处理（101 事件 → 起点 20）。
    expect(recapThroughSeq(game2)).toBe(20);
  });
});
