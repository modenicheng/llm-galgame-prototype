/**
 * MonitorHub tests — writer task lifecycle (attempts, caps, text capping),
 * context tasks, diagnostics ring, coalesced event broadcast, and the
 * changed-only state frame push.
 */
import { describe, expect, it, vi } from "vitest";
import { MonitorHub, type MonitorGameView } from "./monitor-hub.js";
import { RuntimeStatus } from "../../status.js";
import { Metrics } from "../../runtime/metrics.js";
import type { GameMonitorState } from "../../core/runtime/monitor-state.js";
import type { MonitorServerMessage } from "../../shared/wire/monitor-message.js";

function makeGameView(state: Partial<GameMonitorState> = {}): MonitorGameView & {
  state: GameMonitorState;
} {
  const full: GameMonitorState = {
    sessionId: "sess-1",
    currentDsl: null,
    buffer: { pending: 0, total: 0, textLinesAhead: 0 },
    scheduler: { active: false, status: "idle", owner: "active_path" },
    endingPressure: {
      interactionCount: 0,
      level: 0,
      forceEnding: false,
      textEventsSinceInteraction: 0,
      wrapupAt: 6,
      closingPushAt: 8,
      maxAt: 10,
    },
    storyState: {
      scene: { id: "", location: "", purpose: "" },
      canon: {},
      characters: {},
      open_threads: [],
      recent_summary: "",
      player_profile: { recent_tendencies: [] },
    },
    eventCount: 0,
    lastSeq: 0,
    timeline: [],
    ...state,
  };
  return { getMonitorState: () => full, state: full };
}

function makeHub(game: MonitorGameView) {
  return makeHubWithClock(game, () => 1_000);
}

function makeHubWithClock(game: MonitorGameView, now: () => number) {
  return new MonitorHub({
    status: new RuntimeStatus(),
    metrics: new Metrics(),
    info: {
      model: "test-model",
      narrativeMode: "event",
      apiBaseUrl: "https://example.invalid",
      knownSpeakers: ["苏遥"],
      textBuffer: { startThresholdLines: 2, targetLines: 6, refillThresholdLines: 4 },
      eventMode: { wrapupInteractions: 6, closingPushInteractions: 8, maxInteractions: 10 },
    },
    game: () => game,
    now,
    flushIntervalMs: 10,
    pollIntervalMs: 50,
  });
}

describe("MonitorHub", () => {
  it("tracks a writer attempt end-to-end and snapshots its text", () => {
    const hub = makeHub(makeGameView());
    const observer = hub.writerObserver;

    observer.onAttemptStart({ attemptId: "continuation-ab12#0", taskId: "continuation-ab12", taskType: "continuation", index: 0 });
    observer.onDelta("continuation-ab12#0", "苏遥：你来了。\n");
    observer.onLine("continuation-ab12#0", 1, { kind: "dialogue" });
    observer.onGroup("continuation-ab12#0", 0, "dialogue", "苏遥：你来了。");
    observer.onAttemptEnd("continuation-ab12#0", { state: "done", segmentEnd: "buffer" });

    const snapshot = hub.snapshot();
    const task = snapshot.writer.tasks.find((t) => t.taskId === "continuation-ab12");
    expect(task).toBeDefined();
    const attempt = task!.attempts[0]!;
    expect(attempt.state).toBe("done");
    expect(attempt.segmentEnd).toBe("buffer");
    expect(attempt.chars).toBe("苏遥：你来了。\n".length);
    expect(attempt.lines).toBe(1);
    expect(attempt.groups).toBe(1);
    expect(attempt.text).toBe("苏遥：你来了。\n");
  });

  it("records first-token latency exactly once plus request usage and repairs", () => {
    let now = 1_000;
    const hub = makeHubWithClock(makeGameView(), () => now);
    const observer = hub.writerObserver as any;

    observer.onAttemptStart({
      attemptId: "continuation-latency#0",
      taskId: "continuation-latency",
      taskType: "continuation",
      index: 0,
    });
    expect(hub.snapshot().writer.tasks[0]!.attempts[0]!.firstTokenMs).toBeNull();

    now = 1_420;
    observer.onDelta("continuation-latency#0", "第一");
    now = 1_900;
    observer.onDelta("continuation-latency#0", "行\n");
    observer.onRepair("continuation-latency#0", {
      kind: "end_keyword",
      lineIndex: 2,
      message: "已规范化 @end。",
    });
    observer.onUsage("continuation-latency#0", {
      input: 2_481,
      output: 316,
      cachedInput: 2_048,
      source: "api",
      latencyMs: 1_230,
    });

    const attempt = hub.snapshot().writer.tasks[0]!.attempts[0]!;
    expect(attempt.firstTokenMs).toBe(420);
    expect(attempt.usage).toEqual({
      input: 2_481,
      output: 316,
      cachedInput: 2_048,
      source: "api",
      latencyMs: 1_230,
    });
    expect(attempt.repairs).toEqual([
      { kind: "end_keyword", lineIndex: 2, message: "已规范化 @end。" },
    ]);
  });

  it("files repair retries as new attempts on the same task", () => {
    const hub = makeHub(makeGameView());
    const observer = hub.writerObserver;
    observer.onAttemptStart({ attemptId: "continuation-cd34#0", taskId: "continuation-cd34", taskType: "continuation", index: 0 });
    observer.onAttemptEnd("continuation-cd34#0", { state: "retried", error: "第 1 行不是合法 DSL：x" });
    observer.onAttemptStart({ attemptId: "continuation-cd34#1", taskId: "continuation-cd34", taskType: "continuation", index: 1 });
    observer.onDelta("continuation-cd34#1", "bg classroom\n");
    observer.onAttemptEnd("continuation-cd34#1", { state: "done", segmentEnd: "ending" });

    const snapshot = hub.snapshot();
    const task = snapshot.writer.tasks.find((t) => t.taskId === "continuation-cd34")!;
    expect(task.attempts).toHaveLength(2);
    expect(task.attempts[0]!.state).toBe("retried");
    expect(task.attempts[0]!.error).toContain("合法 DSL");
    expect(task.attempts[1]!.state).toBe("done");
  });

  it("caps writer task text and evicts the oldest tasks beyond the ring", () => {
    const hub = makeHub(makeGameView());
    const observer = hub.writerObserver;
    for (let i = 0; i < 14; i += 1) {
      observer.onAttemptStart({ attemptId: `opening-${i}#0`, taskId: `opening-${i}`, taskType: "opening", index: 0 });
      observer.onDelta(`opening-${i}#0`, "x".repeat(49_000));
    }
    const snapshot = hub.snapshot();
    expect(snapshot.writer.tasks).toHaveLength(12);
    expect(snapshot.writer.tasks.some((t) => t.taskId === "opening-0")).toBe(false);
    const newest = snapshot.writer.tasks.find((t) => t.taskId === "opening-13")!;
    expect(newest.attempts[0]!.truncated).toBe(true);
    expect(newest.attempts[0]!.text.length).toBeLessThanOrEqual(48_000);
    expect(newest.attempts[0]!.chars).toBe(49_000);
  });

  it("settles a mid-flight attempt as cancelled when the ring evicts its task", async () => {
    const hub = makeHub(makeGameView());
    const events: MonitorServerMessage[] = [];
    hub.subscribe((message) => events.push(message));
    const observer = hub.writerObserver;

    observer.onAttemptStart({ attemptId: "branch-pre-zz#0", taskId: "branch-pre-zz", taskType: "branch_prefetch", index: 0 });
    observer.onDelta("branch-pre-zz#0", "预取中");
    for (let i = 0; i < 14; i += 1) {
      observer.onAttemptStart({ attemptId: `opening-${i}#0`, taskId: `opening-${i}`, taskType: "opening", index: 0 });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    const end = events.find(
      (m) => m.type === "monitor.event" && m.events.some((e) => e.type === "writer.end" && e.attemptId === "branch-pre-zz#0"),
    );
    expect(end).toBeDefined();
    const snapshot = hub.snapshot();
    const ghost = snapshot.writer.tasks.find((t) => t.taskId === "branch-pre-zz");
    expect(ghost).toBeUndefined();
    expect(snapshot.writer.tasks).toHaveLength(12);
  });

  it("clearWriterHistory settles streaming attempts and empties the rings", () => {
    const hub = makeHub(makeGameView());
    const observer = hub.writerObserver;
    observer.onAttemptStart({ attemptId: "continuation-live#0", taskId: "continuation-live", taskType: "continuation", index: 0 });
    observer.onDelta("continuation-live#0", "生成中");
    hub.contextStart("recap", "事件 1-20");

    hub.clearWriterHistory();

    const snapshot = hub.snapshot();
    expect(snapshot.writer.tasks).toHaveLength(0);
    expect(snapshot.context.tasks).toHaveLength(0);
  });

  it("records context task lifecycle including the fallback state", () => {
    const hub = makeHub(makeGameView());
    const id = hub.contextStart("recap", "事件 1–20（20 条）");
    hub.contextEnd(id, { state: "done", output: "社团招新夜……" });
    const id2 = hub.contextStart("recap", "事件 21–40（20 条）");
    hub.contextEnd(id2, { state: "fallback" });

    const tasks = hub.snapshot().context.tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.state).toBe("fallback");
    expect(tasks[0]!.output).toBeNull();
    expect(tasks[1]!.state).toBe("done");
    expect(tasks[1]!.output).toBe("社团招新夜……");
  });

  it("coalesces events into batched broadcasts and pushes state only on change", () => {
    vi.useFakeTimers();
    try {
      const view = makeGameView();
      const hub = makeHub(view);
      const messages: MonitorServerMessage[] = [];
      hub.subscribe((message) => messages.push(message));

      hub.writerObserver.onAttemptStart({ attemptId: "a#0", taskId: "a", taskType: "opening", index: 0 });
      hub.writerObserver.onDelta("a#0", "beat\n");
      hub.pushDiagnostic("info", "Game", "recap 已覆盖事件 1-20");
      // Nothing flushed yet (coalescing window).
      expect(messages).toHaveLength(0);

      vi.advanceTimersByTime(11);
      const eventMessages = messages.filter((m) => m.type === "monitor.event");
      expect(eventMessages).toHaveLength(1);
      if (eventMessages[0]!.type !== "monitor.event") throw new Error("unreachable");
      expect(eventMessages[0]!.events.map((e) => e.type)).toEqual([
        "writer.start",
        "writer.delta",
        "diagnostics",
      ]);
      const delta = eventMessages[0]!.events.find((event) => event.type === "writer.delta");
      expect(delta?.firstTokenMs).toBe(0);

      // First poll pushes the frame; identical state does not push again.
      vi.advanceTimersByTime(51);
      expect(messages.filter((m) => m.type === "monitor.state")).toHaveLength(1);
      vi.advanceTimersByTime(101);
      expect(messages.filter((m) => m.type === "monitor.state")).toHaveLength(1);

      // A changed state pushes exactly one more frame.
      view.state.eventCount = 5;
      vi.advanceTimersByTime(51);
      expect(messages.filter((m) => m.type === "monitor.state")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
