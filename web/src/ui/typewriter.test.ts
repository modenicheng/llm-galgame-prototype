/**
 * Typewriter tests — pacing, punctuation beats, skip and speed changes.
 * Pure timing logic: fake timers, no DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Typewriter } from "./typewriter.js";

describe("Typewriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reveals characters one at a time at charsPerSec", () => {
    const updates: string[] = [];
    const done = vi.fn();
    const tw = new Typewriter("你好", { onUpdate: (t) => updates.push(t), onDone: done }, 10);
    tw.start();
    vi.advanceTimersByTime(100); // first char
    expect(updates).toEqual(["你"]);
    vi.advanceTimersByTime(100); // second char
    expect(updates).toEqual(["你", "你好"]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(tw.isDone).toBe(true);
  });

  it("pauses longer on sentence-end punctuation", () => {
    const updates: string[] = [];
    const tw = new Typewriter("好。", { onUpdate: (t) => updates.push(t), onDone: () => {} }, 10);
    tw.start();
    // First char at 100ms; the punctuation takes 250ms (100 * 2.5).
    vi.advanceTimersByTime(100);
    expect(updates).toEqual(["好"]);
    vi.advanceTimersByTime(99);
    expect(updates).toEqual(["好"]); // still not revealed
    vi.advanceTimersByTime(160); // crosses the 250ms beat
    expect(updates).toEqual(["好", "好。"]);
  });

  it("skip reveals everything immediately and reports done", () => {
    const updates: string[] = [];
    const done = vi.fn();
    const tw = new Typewriter("很长的一段台词", { onUpdate: (t) => updates.push(t), onDone: done }, 5);
    tw.start();
    tw.skip();
    expect(updates).toEqual(["很长的一段台词"]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(tw.isDone).toBe(true);
    // Skipping again is a no-op.
    tw.skip();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("restarts pacing from the current position on speed change", () => {
    const updates: string[] = [];
    const tw = new Typewriter("甲乙丙", { onUpdate: (t) => updates.push(t), onDone: () => {} }, 10);
    tw.start();
    vi.advanceTimersByTime(100); // 甲
    tw.setCharsPerSecond(20);
    vi.advanceTimersByTime(50); // 乙 at the faster 50ms cadence
    expect(updates).toEqual(["甲", "甲乙"]);
    vi.advanceTimersByTime(50); // 丙
    expect(updates).toEqual(["甲", "甲乙", "甲乙丙"]);
  });

  it("finishes immediately for empty text", () => {
    const done = vi.fn();
    const tw = new Typewriter("", { onUpdate: () => {}, onDone: done }, 10);
    tw.start();
    expect(done).toHaveBeenCalledTimes(1);
    expect(tw.isDone).toBe(true);
  });

  it("stop halts the reveal without completing", () => {
    const updates: string[] = [];
    const done = vi.fn();
    const tw = new Typewriter("一二三四", { onUpdate: (t) => updates.push(t), onDone: done }, 10);
    tw.start();
    vi.advanceTimersByTime(100);
    tw.stop();
    vi.advanceTimersByTime(5000);
    expect(updates).toEqual(["一"]);
    expect(done).not.toHaveBeenCalled();
    expect(tw.isDone).toBe(false);
  });
});
