import { describe, expect, it } from "vitest";
import { AudioTimeline, type TimelineSegment } from "./audio-timeline.js";

const SAMPLE_RATE = 22050;

function segment(lineId: string, pauseBeforeMs: number, pauseAfterMs: number): TimelineSegment {
  return { lineId, cacheKey: `cache-${lineId}`, pauseBeforeMs, pauseAfterMs };
}

describe("AudioTimeline", () => {
  it("contiguousBufferedMs sums queued samples at the injected sample rate", () => {
    const timeline = new AudioTimeline(SAMPLE_RATE);
    timeline.append(segment("a", 0, 0));
    timeline.queueSamples("a", 22050); // 1s
    expect(timeline.contiguousBufferedMs()).toBeCloseTo(1000, 1);
  });

  it("counts pause gaps before and between lines", () => {
    const timeline = new AudioTimeline(SAMPLE_RATE);
    timeline.append(segment("a", 0, 200));
    timeline.append(segment("b", 100, 0));
    timeline.queueSamples("a", 22050); // 1000ms
    timeline.queueSamples("b", 22050); // 1000ms
    // a(1000) + a.pauseAfter(200) + b.pauseBefore(100) + b(1000)
    expect(timeline.contiguousBufferedMs()).toBeCloseTo(2300, 1);
  });

  it("stops at the first line with no queued samples (buffer hole)", () => {
    const timeline = new AudioTimeline(SAMPLE_RATE);
    timeline.append(segment("a", 0, 200));
    timeline.append(segment("b", 100, 0));
    timeline.append(segment("c", 50, 0));
    timeline.queueSamples("a", 22050);
    timeline.queueSamples("c", 22050); // b has none → buffer ends at b
    // a(1000) + a.pauseAfter(200) + b.pauseBefore(100)
    expect(timeline.contiguousBufferedMs()).toBeCloseTo(1300, 1);
  });

  it("returns 0 when the line at the play head has no samples", () => {
    const timeline = new AudioTimeline(SAMPLE_RATE);
    timeline.append(segment("a", 100, 0));
    expect(timeline.contiguousBufferedMs()).toBe(0);
  });

  it("skipTo drops earlier segments and keeps the target's samples", () => {
    const timeline = new AudioTimeline(SAMPLE_RATE);
    timeline.append(segment("a", 0, 200));
    timeline.append(segment("b", 100, 0));
    timeline.queueSamples("a", 22050);
    timeline.queueSamples("b", 22050);
    timeline.skipTo("b");
    expect(timeline.currentLineId()).toBe("b");
    expect(timeline.hasSegment("a")).toBe(false);
    expect(timeline.contiguousBufferedMs()).toBeCloseTo(1000, 1);
  });

  it("skipTo for an unknown line is a no-op", () => {
    const timeline = new AudioTimeline(SAMPLE_RATE);
    timeline.append(segment("a", 0, 0));
    timeline.queueSamples("a", 22050);
    timeline.skipTo("nope");
    expect(timeline.currentLineId()).toBeNull();
    expect(timeline.contiguousBufferedMs()).toBeCloseTo(1000, 1);
  });

  it("currentLineId is null before the first skipTo and tracks it after", () => {
    const timeline = new AudioTimeline(SAMPLE_RATE);
    expect(timeline.currentLineId()).toBeNull();
    timeline.append(segment("a", 0, 0));
    timeline.skipTo("a");
    expect(timeline.currentLineId()).toBe("a");
  });

  it("hasSegment and clear behave as expected", () => {
    const timeline = new AudioTimeline(SAMPLE_RATE);
    timeline.append(segment("a", 0, 0));
    expect(timeline.hasSegment("a")).toBe(true);
    expect(timeline.hasSegment("b")).toBe(false);
    timeline.queueSamples("a", 22050);
    timeline.clear();
    expect(timeline.hasSegment("a")).toBe(false);
    expect(timeline.contiguousBufferedMs()).toBe(0);
  });

  it("append is idempotent per lineId", () => {
    const timeline = new AudioTimeline(SAMPLE_RATE);
    timeline.append(segment("a", 0, 100));
    timeline.append(segment("a", 999, 999));
    expect(timeline.pauseAfterMsFor("a")).toBe(100);
  });
});
