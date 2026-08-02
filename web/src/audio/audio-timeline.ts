/**
 * AudioTimeline — the cross-line playback timeline (§10.4).
 *
 * All lines share one AudioContext + one Worklet, so the coordinator needs
 * a single ordered view of what is queued ahead of the current play
 * position. Each line contributes its queued sample count plus the pause
 * gaps around it; bufferedMs (§10.3) is derived from those counts.
 */
export interface TimelineSegment {
  lineId: string;
  cacheKey: string;
  pauseBeforeMs: number; // gap before this line's audio
  pauseAfterMs: number;
}

interface TimelineEntry {
  segment: TimelineSegment;
  queuedSamples: number;
}

export class AudioTimeline {
  private readonly entries: TimelineEntry[] = [];
  /** Index of the line currently at the play head; -1 before the first start. */
  private currentIndex = -1;

  constructor(private readonly sampleRate: number) {}

  append(segment: TimelineSegment): void {
    if (this.hasSegment(segment.lineId)) {
      return; // a line appears on the timeline exactly once
    }
    this.entries.push({ segment, queuedSamples: 0 });
  }

  /** Record that `count` samples were fed for a line. */
  queueSamples(lineId: string, count: number): void {
    const entry = this.find(lineId);
    if (entry) {
      entry.queuedSamples += count;
    }
  }

  currentLineId(): string | null {
    const entry = this.entries[this.currentIndex];
    return entry ? entry.segment.lineId : null;
  }

  hasSegment(lineId: string): boolean {
    return this.find(lineId) !== undefined;
  }

  pauseAfterMsFor(lineId: string): number | null {
    return this.find(lineId)?.segment.pauseAfterMs ?? null;
  }

  /**
   * Contiguous buffered time (ms) from the current play position (§10.3):
   * queued samples plus the pause gaps between consecutive lines, stopping
   * at the first line that has no samples queued (a hole in the buffer).
   */
  contiguousBufferedMs(): number {
    if (this.entries.length === 0 || this.sampleRate <= 0) {
      return 0;
    }
    const start = this.currentIndex < 0 ? 0 : this.currentIndex;
    const first = this.entries[start]!;
    if (first.queuedSamples === 0) {
      return 0; // nothing playable at the play head
    }
    let totalMs = 0;
    if (this.currentIndex < 0) {
      totalMs += first.segment.pauseBeforeMs; // not yet consumed
    }
    for (let i = start; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      totalMs += (entry.queuedSamples / this.sampleRate) * 1000;
      const next = this.entries[i + 1];
      if (!next) {
        break;
      }
      totalMs += entry.segment.pauseAfterMs + next.segment.pauseBeforeMs;
      if (next.queuedSamples === 0) {
        break; // silence beyond this point — the buffer is not contiguous
      }
    }
    return totalMs;
  }

  /** Drop everything before `lineId`; it becomes the current line. */
  skipTo(lineId: string): void {
    const index = this.entries.findIndex((e) => e.segment.lineId === lineId);
    if (index < 0) {
      return;
    }
    this.entries.splice(0, index);
    this.currentIndex = 0;
  }

  /**
   * Drop one line's segment and its queued sample count (§12.5 invalidation).
   * The play head adjusts when the removed line sits at or before it.
   */
  remove(lineId: string): void {
    const index = this.entries.findIndex((e) => e.segment.lineId === lineId);
    if (index < 0) {
      return;
    }
    this.entries.splice(index, 1);
    if (this.currentIndex < 0) {
      return; // no play head yet — nothing to adjust
    }
    if (index < this.currentIndex) {
      this.currentIndex -= 1; // entries before the head shifted left
    } else if (index === this.currentIndex) {
      // The head line itself is gone: point at the successor (or -1 if none).
      this.currentIndex = Math.min(index, this.entries.length - 1);
    }
  }

  clear(): void {
    this.entries.length = 0;
    this.currentIndex = -1;
  }

  private find(lineId: string): TimelineEntry | undefined {
    return this.entries.find((e) => e.segment.lineId === lineId);
  }
}
