/**
 * Monitor-state types — the read-only snapshot the monitor dashboard
 * renders (docs/monitor-dashboard.md).
 *
 * `Game.getMonitorState()` produces this shape; the MonitorHub polls it and
 * pushes changed frames to `/ws/monitor` browsers. Everything here is plain
 * JSON so it can cross the wire untouched.
 */
import type { StoredEvent } from "../../schema.js";
import type { StoryState } from "../../story/types.js";
import type { DslSourceLocation } from "../protocol/gal-dsl/types.js";

/** 分级收束（event mode ending ladder）的实时读数。 */
export interface MonitorEndingPressure {
  interactionCount: number;
  /** 0 无 / 1 wrapup（L1）/ 2 closing（L2）；forceEnding 即 L3。 */
  level: number;
  forceEnding: boolean;
  textEventsSinceInteraction: number;
  wrapupAt: number;
  closingPushAt: number;
  maxAt: number;
}

/** 播放缓冲与生成调度读数（PlaybackBuffer/GenerationScheduler 投影）。 */
export interface MonitorBufferState {
  pending: number;
  total: number;
  textLinesAhead: number;
}

export interface MonitorSchedulerState {
  active: boolean;
  status: string;
  owner: string;
}

/**
 * 已提交事件日志的紧凑投影。剧情图、事件流 tab 都从这里派生；文本统一
 * 截断，避免长段把帧撑爆。
 */
export interface MonitorTimelineEntry {
  seq: number;
  turn: number;
  at: string;
  source: "model" | "player";
  kind:
    | "dialogue"
    | "narration"
    | "interaction"
    | "player_choice"
    | "player_input"
    | "player_dialogue"
    | "end";
  speaker?: string;
  text?: string;
  prompt?: string;
  mode?: string;
  options?: { id: string; text: string }[];
  choiceId?: string;
  endingId?: string;
  /** @ending 结尾词（结局标题），截断同 text。 */
  endingTitle?: string;
  /** @ending 结局档位：TE | HE | NE | BE。 */
  endingGrade?: string;
}

export interface GameMonitorState {
  sessionId: string;
  /** DSL row/block currently presented to the player, when live provenance exists. */
  currentDsl: DslSourceLocation | null;
  buffer: MonitorBufferState;
  scheduler: MonitorSchedulerState;
  endingPressure: MonitorEndingPressure;
  storyState: StoryState;
  eventCount: number;
  lastSeq: number;
  timeline: MonitorTimelineEntry[];
}

const TEXT_MAX_CHARS = 160;

function truncate(text: string, max = TEXT_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Project one committed stored event into its compact timeline form.
 * Pure data mapping — safe to call on every monitor poll.
 */
export function toMonitorTimelineEntry(event: StoredEvent): MonitorTimelineEntry {
  const base: MonitorTimelineEntry = {
    seq: event.seq,
    turn: event.turn,
    at: event.timestamp,
    source: event.source,
    kind: "narration",
  };
  switch (event.type) {
    case "dialogue":
      return { ...base, kind: "dialogue", speaker: event.speaker, text: truncate(event.text) };
    case "narration":
      return { ...base, kind: "narration", text: truncate(event.text) };
    case "interaction": {
      const options =
        event.mode === "input"
          ? undefined
          : event.options.map((option) => ({ id: option.id, text: truncate(option.text) }));
      return {
        ...base,
        kind: "interaction",
        prompt: truncate(event.prompt),
        mode: event.mode,
        ...(options !== undefined ? { options } : {}),
      };
    }
    case "end":
      return {
        ...base,
        kind: "end",
        endingId: event.ending_id,
        text: truncate(event.text),
        ...(event.title !== undefined ? { endingTitle: truncate(event.title, 48) } : {}),
        ...(event.grade !== undefined ? { endingGrade: event.grade } : {}),
      };
    case "player_choice":
      return {
        ...base,
        kind: "player_choice",
        choiceId: event.choice_id,
        text: truncate(event.text),
      };
    case "player_input":
      return { ...base, kind: "player_input", text: truncate(event.text) };
    case "player_dialogue":
      return {
        ...base,
        kind: "player_dialogue",
        speaker: event.speaker,
        text: truncate(event.text),
      };
  }
}
