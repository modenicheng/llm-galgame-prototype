/**
 * Structured events published by the runtime. A driver subscribes to
 * these and translates them into rendering and commands; it never reads
 * runtime internals.
 */
import type {
  ChoiceEvent,
  EndEvent,
  InteractionEvent,
  RuntimePlayableEvent,
} from "../../schema.js";
import type { RuntimeStatusSnapshot } from "../../status.js";
import type { StageCue, VisualState } from "../presentation/types.js";

/** Interaction surface the runtime exposes to the driver. */
export type RuntimeInteractionEvent = ChoiceEvent | InteractionEvent;

/**
 * Stage changes applied together with a playback step (docs
 * llm-outputs-refactor.md §65). `cues` are the atomic cue set; `visualState`
 * is the authoritative full state AFTER applying them (reconnect-safe).
 */
export interface StagePresentationDelta {
  cues: StageCue[];
  visualState: VisualState;
}

export type RuntimeOutput =
  /** Session storage is ready; includes the host-specific location. */
  | { type: "session_started"; sessionId: string; location: string }
  /** One playable line is ready to be presented; await `advance`. */
  | {
      type: "playback_ready";
      event: RuntimePlayableEvent;
      /** Stage cues that apply together with this line, plus the new state. */
      presentation?: StagePresentationDelta;
    }
  /** A choice/input/hybrid interaction is open and awaits a command. */
  | {
      type: "interaction_opened";
      interactionId: string;
      interaction: RuntimeInteractionEvent;
      /** Stage cues that apply when the form opens, plus the new state. */
      presentation?: StagePresentationDelta;
    }
  /** A bare stage node (no text): cues applied, no advance required. */
  | { type: "stage_beat_ready"; presentation: StagePresentationDelta }
  /** The interaction can no longer be submitted; browsers close the form. */
  | {
      type: "interaction_resolved";
      interactionId: string;
      resolution: "choice" | "input";
    }
  /** Input draft frozen; the response generation is running in the background. */
  | { type: "input_preview_opened"; previewId: string; text: string }
  /** The preview was cancelled; the same interaction may reopen. */
  | { type: "input_preview_canceled"; previewId: string }
  /** The preview was confirmed and its response events are committed. */
  | { type: "input_committed"; previewId: string }
  /** Observability snapshot changed (phase, jobs, buffers, media). */
  | { type: "status_changed"; status: RuntimeStatusSnapshot }
  /** The story reached an end event. */
  | { type: "session_ended"; ending: EndEvent }
  /** Non-fatal runtime failure; the run loop may still continue. */
  | { type: "runtime_error"; code: string; message: string };
