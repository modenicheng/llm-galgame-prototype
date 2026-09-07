/**
 * Session persistence abstraction.
 *
 * The runtime only knows *that* a session is stored somewhere — a JSONL
 * file on disk (Node adapter), an in-memory buffer (tests), or a remote
 * sync service (future web backend). It never touches paths or the
 * filesystem itself.
 */
import type { EndEvent, InteractionEvent, StoredEvent } from "../../schema.js";
import type { StoryState } from "../../story/types.js";
import type { StageCue, VisualState } from "../presentation/types.js";

/** Everything the store needs to know before the session starts. */
export interface SessionMetadata {
  sessionId: string;
}

/** Point-in-time state the runtime wants persisted between event logs. */
export interface RuntimeSnapshot {
  state: StoryState;
  /** The last rendered stage state, used to resume without replaying cues. */
  visualState?: VisualState;
  /** Whether the persisted session has already reached its terminal ending. */
  phase?: "active" | "ended";
  /** The next generation turn when the session resumes. */
  nextTurn?: number;
  /** The last committed event included in this snapshot. */
  lastEventSeq?: number;
  /** The terminal ending, when this snapshot represents an ended session. */
  ending?: EndEvent;
  /** A form that was open when the process was interrupted. */
  resumeInteraction?: {
    turn: number;
    interaction: InteractionEvent;
    stage?: StageCue[];
  };
}

export interface SessionRestore {
  /** Valid events in append order; malformed JSONL lines are ignored. */
  events: StoredEvent[];
  /** Missing or invalid snapshot files produce no snapshot. */
  snapshot?: RuntimeSnapshot;
}

export interface SessionStorePort {
  /** Human-readable location of this session (file path, "memory", ...). */
  readonly location: string;

  /** Prepare storage and derive any host-specific paths. */
  initialize(metadata: SessionMetadata): Promise<void>;

  /** Append one already-sequenced stored event to the session log. */
  append(event: StoredEvent): Promise<void>;

  /** Load the persisted event log and latest runtime snapshot. */
  load(): Promise<SessionRestore>;

  /** Persist a full state snapshot (e.g. alongside the event log). */
  saveSnapshot(snapshot: RuntimeSnapshot): Promise<void>;
}
