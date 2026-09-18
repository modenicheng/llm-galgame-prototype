/**
 * BacklogStore — the player's reading history for the 回看 panel.
 *
 * Appends one entry per presented line (playback_ready), deduplicating by
 * line_id: a reconnect projection re-presents the current line, and the
 * entry must not double. Each entry carries the audio identity needed for
 * replay (cacheKey + sampleRate, captured from the AudioDescriptor) so a
 * past line can be re-played from the IndexedDB performance cache; a
 * discarded line (audio.invalidated) loses its replayable audio but its
 * text stays — the words the player already read remain canon.
 *
 * Pure module: no DOM, no IndexedDB, no server messages beyond the caller-
 * extracted fields — trivially testable.
 */

export interface BacklogEntryInput {
  type: "dialogue" | "narration" | "player_dialogue";
  lineId: string;
  speaker?: string;
  text: string;
}

export interface BacklogEntry {
  type: "dialogue" | "narration" | "player_dialogue";
  lineId: string;
  speaker?: string;
  text: string;
  /** Present when the line's audio descriptor is (or was) known and valid. */
  cacheKey: string | null;
  /** Synthesis sample rate for playback; 0 while cacheKey is unknown. */
  sampleRate: number;
}

/** History cap: a booth session is hours, not days; 400 entries is plenty
 * and keeps the DOM list cheap. Oldest entries fall off first. */
export const MAX_BACKLOG_ENTRIES = 400;

export class BacklogStore {
  private readonly entries: BacklogEntry[] = [];
  private readonly byLineId = new Map<string, BacklogEntry>();

  /**
   * Append a presented line. A repeated line_id (reconnect re-presentation)
   * is a no-op — the first presentation is the history.
   */
  push(line: BacklogEntryInput): void {
    if (this.byLineId.has(line.lineId)) return;
    const entry: BacklogEntry = {
      type: line.type,
      lineId: line.lineId,
      text: line.text,
      cacheKey: null,
      sampleRate: 0,
    };
    if (line.speaker !== undefined) entry.speaker = line.speaker;
    this.entries.push(entry);
    this.byLineId.set(line.lineId, entry);
    if (this.entries.length > MAX_BACKLOG_ENTRIES) {
      const dropped = this.entries.splice(0, this.entries.length - MAX_BACKLOG_ENTRIES);
      for (const old of dropped) this.byLineId.delete(old.lineId);
    }
  }

  /** Attach replay identity from an AudioDescriptor (idempotent). */
  attachAudio(lineId: string, cacheKey: string, sampleRate: number): void {
    const entry = this.byLineId.get(lineId);
    if (entry === undefined) return;
    entry.cacheKey = cacheKey;
    entry.sampleRate = sampleRate;
  }

  /** The line's audio was invalidated — replay is gone, text remains. */
  invalidateAudio(lineId: string): void {
    const entry = this.byLineId.get(lineId);
    if (entry === undefined) return;
    entry.cacheKey = null;
    entry.sampleRate = 0;
  }

  get(lineId: string): BacklogEntry | undefined {
    return this.byLineId.get(lineId);
  }

  /** Oldest-first snapshot (a fresh array — callers may hold it across ticks). */
  list(): readonly BacklogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
    this.byLineId.clear();
  }
}
