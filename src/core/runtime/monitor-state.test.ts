import { describe, it, expect } from "vitest";
import { toMonitorTimelineEntry } from "./monitor-state.js";
import type { StoredEvent } from "../../schema.js";

function endEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    seq: 7,
    turn: 3,
    timestamp: "2026-09-17T12:00:00.000Z",
    source: "model",
    type: "end",
    ending_id: "ending_042",
    text: "故事到此结束。",
    ...overrides,
  } as StoredEvent;
}

describe("toMonitorTimelineEntry — end entry", () => {
  it("projects the @ending grade and title", () => {
    const entry = toMonitorTimelineEntry(
      endEvent({ grade: "HE", title: "樱花与约定的终章" }),
    );
    expect(entry.kind).toBe("end");
    expect(entry.endingId).toBe("ending_042");
    expect(entry.endingGrade).toBe("HE");
    expect(entry.endingTitle).toBe("樱花与约定的终章");
  });

  it("omits both fields for legacy endings without epilogue data", () => {
    const entry = toMonitorTimelineEntry(endEvent());
    expect(entry.endingGrade).toBeUndefined();
    expect(entry.endingTitle).toBeUndefined();
  });
});
