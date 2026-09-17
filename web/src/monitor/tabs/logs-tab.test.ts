// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { MonitorTimelineEntry } from "@core/runtime/monitor-state.js";
import { renderEvents } from "./logs-tab.js";

describe("renderEvents", () => {
  it("uses quiet styles for routine events and stronger styles for interaction and ending events", () => {
    const container = document.createElement("div");
    const base = { turn: 1, at: "2026-09-17T00:00:00.000Z", source: "model" as const };
    const timeline: MonitorTimelineEntry[] = [
      { ...base, seq: 1, kind: "narration", text: "风吹过窗边。" },
      { ...base, seq: 2, kind: "dialogue", speaker: "苏遥", text: "来了？" },
      { ...base, seq: 3, kind: "interaction", prompt: "你要怎么接话？", mode: "hybrid" },
      { ...base, seq: 4, kind: "end", endingId: "after_school", text: "灯灭了。" },
    ];

    renderEvents(container, timeline);

    expect(container.querySelectorAll(".event-row.event-tone-routine")).toHaveLength(2);
    expect(container.querySelector(".event-kind-interaction")?.classList).toContain("event-tone-interactive");
    expect(container.querySelector(".event-kind-end")?.classList).toContain("event-tone-terminal");
  });
});
