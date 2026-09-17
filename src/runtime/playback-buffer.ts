import type { RuntimeBufferEvent } from "../schema.js";

/**
 * Cursor-based playback buffer for the active story path.
 *
 * Maintains an ordered list of runtime events and a cursor that
 * tracks which events have already been presented to the player.
 *
 * events[0 .. cursor-1]     → already shown
 * events[cursor .. end]     → waiting to play
 */
export class PlaybackBuffer {
  private events: RuntimeBufferEvent[] = [];
  private cursor = 0;
  /** Shared change signal; null while nobody waits. See changed(). */
  private nextChange: Promise<void> | null = null;
  private resolveNextChange: (() => void) | undefined;

  /**
   * Resolve when the buffer next mutates (enqueue / advance / clear).
   * All concurrent waiters share ONE promise, and a waiter that arrives
   * after a mutation waits for the NEXT one — no accumulation of stale
   * race losers. Lets callers await buffer levels event-driven instead
   * of polling (e.g. the start-threshold gate).
   */
  changed(): Promise<void> {
    if (this.nextChange === null) {
      this.nextChange = new Promise<void>((resolve) => {
        this.resolveNextChange = resolve;
      });
    }
    return this.nextChange;
  }

  private fireChange(): void {
    if (this.nextChange === null) return;
    const resolve = this.resolveNextChange;
    this.nextChange = null;
    this.resolveNextChange = undefined;
    resolve?.();
  }

  /** Append a single event to the end of the buffer. */
  enqueue(event: RuntimeBufferEvent): void {
    this.events.push(event);
    this.fireChange();
  }

  /** Append multiple events to the end of the buffer. */
  enqueueMany(events: RuntimeBufferEvent[]): void {
    if (events.length === 0) return;
    for (const event of events) this.events.push(event);
    this.fireChange();
  }

  /** Return the next event and advance the cursor. */
  advance(): RuntimeBufferEvent | undefined {
    if (this.cursor >= this.events.length) return undefined;
    const event = this.events[this.cursor]!;
    this.cursor += 1;
    this.fireChange();
    return event;
  }

  /** Peek at the next event without consuming it. */
  peek(): RuntimeBufferEvent | undefined {
    return this.events[this.cursor];
  }

  /**
   * Count playable text lines (dialogue + narration) that are ahead
   * of the current cursor position.
   */
  countTextLinesAhead(): number {
    let count = 0;
    for (let i = this.cursor; i < this.events.length; i += 1) {
      const event = this.events[i]!;
      if (event.type === "dialogue" || event.type === "narration") count += 1;
    }
    return count;
  }

  /**
   * Check whether there is an unconsumed terminal event
   * (choice, interaction, or end) in the buffer.
   */
  hasUnconsumedInteraction(): boolean {
    for (let i = this.cursor; i < this.events.length; i += 1) {
      const event = this.events[i]!;
      if (event.type === "interaction" || event.type === "end") {
        return true;
      }
    }
    return false;
  }

  /** Whether the buffer has events remaining to play. */
  hasEvents(): boolean {
    return this.cursor < this.events.length;
  }

  /** Number of events still ahead of the cursor. */
  pendingCount(): number {
    return this.events.length - this.cursor;
  }

  /** Total events in the buffer (including already consumed). */
  totalCount(): number {
    return this.events.length;
  }

  /** Get all pending events without consuming them. */
  getPendingEvents(): RuntimeBufferEvent[] {
    return this.events.slice(this.cursor);
  }

  /**
   * Remove all events from the buffer and reset the cursor.
   * Used after a terminal event is handled and before the next
   * segment is loaded.
   */
  clear(): void {
    this.events = [];
    this.cursor = 0;
    this.fireChange();
  }
}
