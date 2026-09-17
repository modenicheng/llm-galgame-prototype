// @vitest-environment happy-dom
/**
 * DslStreamView + WriterPanel DOM tests — the live writer stream must
 * render rows for completed DSL lines, keep the partial tail visible, and
 * replay snapshot text on task switch. Regression coverage for the
 * "DSL 面板什么都不显示" report.
 */
import { describe, expect, it, vi } from "vitest";
import { Metrics } from "@core/../runtime/metrics.js";
import { RuntimeStatus } from "@core/../status.js";
import { DslStreamView } from "./dsl-stream-view.js";
import { MonitorModel } from "./monitor-model.js";
import type { MonitorServerEvent, MonitorServerMessage } from "@shared/wire/monitor-message.js";

function makeContainer(): HTMLElement {
  const container = document.createElement("div");
  container.className = "mon-stream";
  document.body.appendChild(container);
  return container;
}

function countRows(container: HTMLElement): number {
  return container.querySelectorAll(".dsl-row:not(.is-partial)").length;
}

describe("DslStreamView", () => {
  it("renders completed lines and the partial tail while streaming", () => {
    const container = makeContainer();
    const view = new DslStreamView(container);
    view.reset(new Set(["苏遥"]));

    view.append("bg classroom_day\n苏遥[smile](苏遥): 你来了。\n雨点敲在窗");
    expect(countRows(container)).toBe(2);
    const partial = container.querySelector(".is-partial .dsl-code");
    expect(partial?.textContent).toBe("雨点敲在窗");

    view.append("上。");
    expect(countRows(container)).toBe(2);
    expect(container.querySelector(".is-partial .dsl-code")?.textContent).toBe("雨点敲在窗上。");

    view.finish();
    expect(countRows(container)).toBe(3);
    expect(container.querySelector(".is-partial .dsl-code")?.textContent).toBe("");
  });

  it("replays a finished attempt's whole text", () => {
    const container = makeContainer();
    const view = new DslStreamView(container);
    view.reset(undefined);
    view.replay("beat\n? 去哪？\n+ 天台\n+ 机房\n/?\n@end ab12 buffer\n");
    expect(countRows(container)).toBe(6);
    const badges = [...container.querySelectorAll(".dsl-badge")].map((b) => b.textContent);
    expect(badges).toContain("@end");
  });

  it("tokenizes dialogue into speaker/slot/text spans", () => {
    const container = makeContainer();
    const view = new DslStreamView(container);
    view.reset(new Set(["苏遥"]));
    view.append("苏遥[smile]: 早安。\n");
    const code = container.querySelector(".dsl-row:not(.is-partial) .dsl-code")!;
    const classes = [...code.children].map((span) => span.className);
    expect(classes).toContain("tok-speaker");
    expect(classes).toContain("tok-slot");
    expect(code.textContent).toBe("苏遥[smile]: 早安。");
  });

  it("highlights the player's current interaction as one DSL block", () => {
    const container = makeContainer();
    const view = new DslStreamView(container);
    view.reset(undefined);
    view.replay("? 你要怎么接话？\n+ 凑过去看看\n= 你想说点什么\n/?\n");

    const current = view.highlight(1);
    expect(current?.classList.contains("is-current-player")).toBe(true);
    expect(container.querySelectorAll(".dsl-row.is-current-block")).toHaveLength(4);
    expect(current?.getAttribute("aria-current")).toBe("true");

    view.highlight(null);
    expect(container.querySelector(".dsl-row.is-current-player")).toBeNull();
  });
});

describe("MonitorModel → WriterPanel live flow", () => {
  it("keeps every request in one chronological document with request telemetry", () => {
    const model = new MonitorModel();
    const container = makeContainer();
    const toolbar = document.createElement("div");
    const foot = document.createElement("div");

    // WriterPanel imports resolve; construct it the same way boot.ts does.
    return import("./writer-panel.js").then(({ WriterPanel }) => {
      const panel = new WriterPanel(model, { toolbar, stream: container, foot });

      const start = 1_700_000_000_000;
      model.applyServerMessage({
        type: "monitor.event",
        events: [
          {
            type: "writer.start",
            task: {
              taskId: "continuation-nonce1",
              taskType: "continuation",
              startedAt: start,
              lastActivityAt: start,
              attempts: [
                {
                  attemptId: "continuation-nonce1#0",
                  index: 0,
                  state: "streaming",
                  startedAt: start,
                  endedAt: null,
                  chars: 0,
                  lines: 0,
                  groups: 0,
                  error: null,
                  segmentEnd: null,
                  firstTokenMs: 420,
                },
              ],
            },
          },
          { type: "writer.delta", attemptId: "continuation-nonce1#0", text: "bg club_room\n苏遥：来了？\n" },
          { type: "writer.line", attemptId: "continuation-nonce1#0", lineIndex: 1, kind: "background", error: null },
          { type: "writer.line", attemptId: "continuation-nonce1#0", lineIndex: 2, kind: "dialogue", error: null },
          {
            type: "writer.usage",
            attemptId: "continuation-nonce1#0",
            usage: { input: 120, output: 34, cachedInput: 80, source: "api", latencyMs: 900 },
          },
          {
            type: "writer.end",
            taskId: "continuation-nonce1",
            attemptId: "continuation-nonce1#0",
            state: "done",
            error: null,
            segmentEnd: "buffer",
          },
        ],
      });

      expect(container.querySelectorAll(".writer-request")).toHaveLength(1);
      expect(countRows(container)).toBe(2);
      expect(container.querySelector(".writer-request-boundary")?.textContent).toContain("输入 120");
      expect(container.querySelector(".writer-request-boundary")?.textContent).toContain("首字 420ms");
      const firstRequest = container.querySelector(".writer-request");

      model.applyServerMessage({
        type: "monitor.event",
        events: [
          {
            type: "writer.start",
            task: {
              taskId: "input-response-nonce2",
              taskType: "input_response",
              startedAt: start + 2_000,
              lastActivityAt: start + 2_000,
              attempts: [
                {
                  attemptId: "input-response-nonce2#0",
                  index: 0,
                  state: "streaming",
                  startedAt: start + 2_000,
                  endedAt: null,
                  chars: 0,
                  lines: 0,
                  groups: 0,
                  error: null,
                  segmentEnd: null,
                  firstTokenMs: 260,
                },
              ],
            },
          },
          { type: "writer.delta", attemptId: "input-response-nonce2#0", text: "beat\n" },
        ],
      });

      expect(container.querySelectorAll(".writer-request")).toHaveLength(2);
      expect(container.querySelector(".writer-request")).toBe(firstRequest);
      expect(countRows(container)).toBe(3);
      expect(container.textContent?.indexOf("bg club_room")).toBeLessThan(
        container.textContent?.indexOf("beat") ?? -1,
      );

      // A reconnect snapshot can keep the same request ids while carrying
      // text that arrived during the disconnect. Existing DOM must catch up.
      const active = model.writerTasks.find((task) => task.taskId === "input-response-nonce2")!
        .attempts[0]!;
      active.text += "苏遥：快照补发。\n";
      active.chars = active.text.length;
      panel.render();
      expect(countRows(container)).toBe(4);
      expect(container.textContent).toContain("快照补发");
    });
  });

  it("tracks the current player line from the game-state frame", () => {
    const model = new MonitorModel();
    const container = makeContainer();
    const toolbar = document.createElement("div");
    const foot = document.createElement("div");

    return import("./writer-panel.js").then(({ WriterPanel }) => {
      new WriterPanel(model, { toolbar, stream: container, foot });
      const startedAt = 1_700_000_000_000;
      model.applyServerMessage({
        type: "monitor.event",
        events: [
          {
            type: "writer.start",
            task: {
              taskId: "opening-nonce3",
              taskType: "opening",
              startedAt,
              lastActivityAt: startedAt,
              attempts: [{
                attemptId: "opening-nonce3#0",
                index: 0,
                state: "streaming",
                startedAt,
                endedAt: null,
                chars: 0,
                lines: 0,
                groups: 0,
                error: null,
                segmentEnd: null,
              }],
            },
          },
          {
            type: "writer.delta",
            attemptId: "opening-nonce3#0",
            text: "? 你要怎么接话？\n+ 先看看\n= 自己说\n/?\n",
          },
        ],
      });
      Object.defineProperty(container, "scrollHeight", { value: 500, configurable: true });
      const formStartRow = container.querySelector(".dsl-row:not(.is-partial)") as HTMLElement;
      formStartRow.scrollIntoView = vi.fn(() => {
        container.scrollTop = 123;
      });
      const previous = model.state;
      model.applyServerMessage({
        type: "monitor.state",
        state: {
          ...(previous ?? {
            at: startedAt,
            session: {
              sessionId: "s",
              buffer: { pending: 0, total: 0, textLinesAhead: 0 },
              scheduler: { active: false, status: "idle", owner: "active_path" },
              endingPressure: { interactionCount: 0, level: 0, forceEnding: false, textEventsSinceInteraction: 0, wrapupAt: 6, closingPushAt: 8, maxAt: 10 },
              storyState: { scene: { id: "", location: "", purpose: "" }, canon: {}, characters: {}, open_threads: [], recent_summary: "", player_profile: { recent_tendencies: [] } },
              eventCount: 0,
              lastSeq: 0,
              timeline: [],
            },
            status: new RuntimeStatus().snapshot(),
            metrics: new Metrics().snapshot(),
          }),
          at: startedAt + 1,
          session: {
            ...(previous?.session ?? {
              sessionId: "s",
              buffer: { pending: 0, total: 0, textLinesAhead: 0 },
              scheduler: { active: false, status: "idle", owner: "active_path" },
              endingPressure: { interactionCount: 0, level: 0, forceEnding: false, textEventsSinceInteraction: 0, wrapupAt: 6, closingPushAt: 8, maxAt: 10 },
              storyState: { scene: { id: "", location: "", purpose: "" }, canon: {}, characters: {}, open_threads: [], recent_summary: "", player_profile: { recent_tendencies: [] } },
              eventCount: 0,
              lastSeq: 0,
              timeline: [],
            }),
            currentDsl: { attemptId: "opening-nonce3#0", lineIndex: 1 },
          },
        },
      });
      expect(container.querySelectorAll(".dsl-row.is-current-block")).toHaveLength(4);
      expect(container.querySelector(".dsl-row.is-current-player")?.getAttribute("aria-current")).toBe("true");
      expect(formStartRow.scrollIntoView).toHaveBeenCalledOnce();
      expect(container.scrollTop).toBe(123);
    });
  });
});

describe("WriterPanel auto-follow", () => {
  it("stays following when the programmatic current-row scroll fires a scroll event", async () => {
    const { WriterPanel } = await import("./writer-panel.js");
    const model = new MonitorModel();
    const container = makeContainer();
    const toolbar = document.createElement("div");
    const foot = document.createElement("div");
    new WriterPanel(model, { toolbar, stream: container, foot });

    const start = 1_700_000_000_000;
    const startEvent: MonitorServerEvent = {
      type: "writer.start",
      task: {
        taskId: "continuation-nonceF",
        taskType: "continuation",
        startedAt: start,
        lastActivityAt: start,
        attempts: [
          {
            attemptId: "continuation-nonceF#0",
            index: 0,
            state: "streaming",
            startedAt: start,
            endedAt: null,
            chars: 0,
            lines: 0,
            groups: 0,
            error: null,
            segmentEnd: null,
            firstTokenMs: 420,
          },
        ],
      },
    };
    model.applyServerMessage({ type: "monitor.event", events: [startEvent] });
    const deltaEvent: MonitorServerEvent = {
      type: "writer.delta",
      attemptId: "continuation-nonceF#0",
      text: "苏遥：来了？\n",
    };
    model.applyServerMessage({ type: "monitor.event", events: [deltaEvent] });

    // The current row scrolls into view programmatically; the resulting
    // scroll event must NOT look like user scrolling.
    const row = container.querySelector(".dsl-row:not(.is-partial)") as HTMLElement;
    row.scrollIntoView = vi.fn();
    model.applyServerMessage({
      type: "monitor.state",
      state: {
        at: start + 1,
        session: {
          sessionId: "s",
          buffer: { pending: 0, total: 0, textLinesAhead: 0 },
          scheduler: { active: false, status: "idle", owner: "active_path" },
          endingPressure: { interactionCount: 0, level: 0, forceEnding: false, textEventsSinceInteraction: 0, wrapupAt: 6, closingPushAt: 8, maxAt: 10 },
          storyState: { scene: { id: "", location: "", purpose: "" }, canon: {}, characters: {}, open_threads: [], recent_summary: "", player_profile: { recent_tendencies: [] } },
          eventCount: 0,
          lastSeq: 0,
          timeline: [],
          currentDsl: { attemptId: "continuation-nonceF#0", lineIndex: 1 },
        },
        status: { phase: "x", message: "", startedAt: 0 } as never,
        metrics: new Metrics().snapshot(),
      },
    });
    expect(row.scrollIntoView).toHaveBeenCalledOnce();

    container.dispatchEvent(new Event("scroll"));
    const follow = toolbar.querySelector(".writer-follow");
    expect(follow?.className).toContain("is-active");
    expect(follow?.textContent).toBe("自动跟随中");
  });
});

describe("MonitorModel snapshot", () => {
  it("exposes snapshot text for replay through the panel", () => {
    const model = new MonitorModel();
    const snapshot: MonitorServerMessage = {
      type: "monitor.snapshot",
      snapshot: {
        at: 1,
        info: {
          model: "m",
          narrativeMode: "event",
          apiBaseUrl: "http://x",
          knownSpeakers: ["苏遥"],
          textBuffer: { startThresholdLines: 2, targetLines: 6, refillThresholdLines: 4 },
          eventMode: { wrapupInteractions: 6, closingPushInteractions: 8, maxInteractions: 10 },
        },
        writer: {
          tasks: [
            {
              taskId: "opening-nonce0",
              taskType: "opening",
              startedAt: 1,
              lastActivityAt: 2,
              attempts: [
                {
                  attemptId: "opening-nonce0#0",
                  index: 0,
                  state: "done",
                  startedAt: 1,
                  endedAt: 2,
                  chars: 12,
                  lines: 2,
                  groups: 2,
                  error: null,
                  segmentEnd: "buffer",
                  text: "bg club_room\n苏遥：开场白。\n",
                  truncated: false,
                },
              ],
            },
          ],
        },
        context: { tasks: [] },
        diagnostics: [],
        state: {
          at: 1,
          session: {
            sessionId: "s",
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
          },
          // Real producers keep this fixture field-complete as the
          // snapshots grow (no hand-maintained metric lists).
          status: new RuntimeStatus().snapshot(),
          metrics: new Metrics().snapshot(),
        },
      },
    };
    model.applyServerMessage(snapshot);
    const attempt = model.writerTasks[0]!.attempts[0]!;
    expect(attempt.text).toContain("苏遥");
    expect(model.knownSpeakers()?.has("苏遥")).toBe(true);
  });
});
