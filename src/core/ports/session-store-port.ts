/**
 * Session persistence abstraction.
 *
 * The runtime only knows *that* a session is stored somewhere — a JSONL
 * file on disk (Node adapter), an in-memory buffer (tests), or a remote
 * sync service (future web backend). It never touches paths or the
 * filesystem itself.
 */
import type { StoredEvent } from "../../schema.js";
import type { StoryState } from "../../story/types.js";

/** Everything the store needs to know before the session starts. */
export interface SessionMetadata {
  sessionId: string;
}

/** Point-in-time state the runtime wants persisted between event logs. */
export interface RuntimeSnapshot {
  state: StoryState;
}

export interface SessionStorePort {
  /** Human-readable location of this session (file path, "memory", ...). */
  readonly location: string;

  /** Prepare storage and derive any host-specific paths. */
  initialize(metadata: SessionMetadata): Promise<void>;

  /** Append one already-sequenced stored event to the session log. */
  append(event: StoredEvent): Promise<void>;

  /** Persist a full state snapshot (e.g. alongside the event log). */
  saveSnapshot(snapshot: RuntimeSnapshot): Promise<void>;
}
