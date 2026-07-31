import { describe, it, expect } from "vitest";
import { PlaybackBuffer } from "./playback-buffer.js";
import type { RuntimeModelEvent, RuntimePlayableEvent } from "../schema.js";

function narration(text: string): RuntimePlayableEvent {
  return { type: "narration", text, line_id: `line_test_${text}` };
}

function dialogue(speaker: string, text: string): RuntimePlayableEvent {
  return { type: "dialogue", speaker, text, line_id: `line_test_${text}` };
}

function choiceEvent(prompt: string): RuntimeModelEvent {
  return {
    type: "choice",
    prompt,
    options: [
      { id: "a", text: "Option A" },
      { id: "b", text: "Option B" },
    ],
  };
}

function endEvent(): RuntimeModelEvent {
  return { type: "end", ending_id: "end_1", text: "The end." };
}

describe("PlaybackBuffer", () => {
  it("should start empty", () => {
    const buffer = new PlaybackBuffer();
    expect(buffer.hasEvents()).toBe(false);
    expect(buffer.countTextLinesAhead()).toBe(0);
    expect(buffer.pendingCount()).toBe(0);
  });

  it("should enqueue and advance events in order", () => {
    const buffer = new PlaybackBuffer();
    const e1 = narration("First");
    const e2 = narration("Second");
    buffer.enqueue(e1);
    buffer.enqueue(e2);

    expect(buffer.hasEvents()).toBe(true);
    expect(buffer.pendingCount()).toBe(2);

    const advanced = buffer.advance();
    expect(advanced).toBe(e1);
    expect(buffer.pendingCount()).toBe(1);

    const advanced2 = buffer.advance();
    expect(advanced2).toBe(e2);
    expect(buffer.pendingCount()).toBe(0);
    expect(buffer.hasEvents()).toBe(false);
  });

  it("should return undefined when advancing past end", () => {
    const buffer = new PlaybackBuffer();
    expect(buffer.advance()).toBeUndefined();
  });

  it("should peek without consuming", () => {
    const buffer = new PlaybackBuffer();
    const e1 = narration("Peek me");
    buffer.enqueue(e1);

    expect(buffer.peek()).toBe(e1);
    expect(buffer.pendingCount()).toBe(1); // not consumed
    buffer.advance();
    expect(buffer.peek()).toBeUndefined();
  });

  it("should count only playable events ahead of cursor", () => {
    const buffer = new PlaybackBuffer();
    buffer.enqueue(narration("N1"));
    buffer.enqueue(dialogue("Alice", "D1"));
    buffer.enqueue(choiceEvent("Choose"));
    buffer.enqueue(narration("N2"));

    // All 3 playable events are ahead (choice is not playable)
    expect(buffer.countTextLinesAhead()).toBe(3);

    buffer.advance(); // consume N1
    expect(buffer.countTextLinesAhead()).toBe(2);

    buffer.advance(); // consume D1
    expect(buffer.countTextLinesAhead()).toBe(1);

    buffer.advance(); // consume choice (not counted)
    expect(buffer.countTextLinesAhead()).toBe(1); // N2 still ahead

    buffer.advance(); // consume N2
    expect(buffer.countTextLinesAhead()).toBe(0);
  });

  it("should detect unconsumed interaction/choice", () => {
    const buffer = new PlaybackBuffer();
    buffer.enqueue(narration("N1"));
    buffer.enqueue(choiceEvent("Choose"));

    expect(buffer.hasUnconsumedInteraction()).toBe(true);
    buffer.advance(); // consume N1
    expect(buffer.hasUnconsumedInteraction()).toBe(true);
    buffer.advance(); // consume choice
    expect(buffer.hasUnconsumedInteraction()).toBe(false);
  });

  it("should detect unconsumed end event", () => {
    const buffer = new PlaybackBuffer();
    buffer.enqueue(narration("Last"));
    buffer.enqueue(endEvent());

    expect(buffer.hasUnconsumedInteraction()).toBe(true);
    buffer.advance();
    expect(buffer.hasUnconsumedInteraction()).toBe(true);
    buffer.advance();
    expect(buffer.hasUnconsumedInteraction()).toBe(false);
  });

  it("should enqueueMany correctly", () => {
    const buffer = new PlaybackBuffer();
    const events = [narration("A"), narration("B"), narration("C")];
    buffer.enqueueMany(events);

    expect(buffer.pendingCount()).toBe(3);
    expect(buffer.totalCount()).toBe(3);
  });

  it("should getPendingEvents without advancing cursor", () => {
    const buffer = new PlaybackBuffer();
    const e1 = narration("A");
    const e2 = narration("B");
    buffer.enqueue(e1);
    buffer.enqueue(e2);
    buffer.advance(); // consume A

    const pending = buffer.getPendingEvents();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toBe(e2);
  });

  it("should clear all events and reset cursor", () => {
    const buffer = new PlaybackBuffer();
    buffer.enqueue(narration("A"));
    buffer.enqueue(narration("B"));
    buffer.advance();

    buffer.clear();
    expect(buffer.hasEvents()).toBe(false);
    expect(buffer.totalCount()).toBe(0);
    expect(buffer.pendingCount()).toBe(0);
  });
});
