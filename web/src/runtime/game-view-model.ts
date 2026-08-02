/**
 * GameViewModel — the browser's pure projection of ServerMessages into UI
 * state (design doc §9.2).
 *
 * The browser never replicates the Game state machine; it only mirrors what
 * Node publishes. This module is a pure projection: applying a message never
 * mutates Game internals, never calls TTS, never touches the DOM or
 * IndexedDB. `applyProjection` restores the full state after a reconnect.
 *
 * Wire-local types mirror the core shapes (RuntimeOutput etc.) so this module
 * imports ONLY `@shared/wire`, DOM, and sibling runtime modules.
 */
import type { ServerMessage } from "@shared/wire/server-message.js";
import type { UiProjection } from "@shared/wire/ui-projection.js";

export type FrontendMode =
  | "BOOTSTRAP"
  | "PLAYING"
  | "CHOICE_SELECTING"
  | "INPUT_EDITING"
  | "INPUT_PREVIEW"
  | "CONTENT_WAITING"
  | "ENDING"
  | "ERROR";

/**
 * Playable line as rendered by the UI: dialogue, narration, or the player's
 * own confirmed line. Structurally compatible with the core
 * `RuntimePlayableEvent` that flows through the wire.
 */
export interface RuntimePlayableEventWire {
  type: "dialogue" | "narration" | "player_dialogue";
  line_id: string;
  speaker?: string;
  text: string;
  portrait?:
    | {
        character: string;
        expression: string;
        position: "left" | "center" | "right";
      }
    | null;
  /** Present on player-originated lines. */
  interaction_id?: string;
}

export interface ViewModelState {
  mode: FrontendMode;
  sessionId?: string;
  currentLine?: RuntimePlayableEventWire;
  /** Rendered by the UI from the RuntimeOutput wire interaction. */
  currentInteraction?: unknown;
  currentPreview?: { previewId: string; text: string };
  recentLines: RuntimePlayableEventWire[];
  /** RuntimeStatusSnapshot wire. */
  status?: unknown;
  /** EndEvent wire. */
  ending?: unknown;
  lastError?: string;
}

export const MAX_RECENT_LINES = 8;

/** A runtime.output variant type, extracted without importing core. */
type RuntimeOutputWire = Extract<
  ServerMessage,
  { type: "runtime.output" }
>["output"];

export class GameViewModel {
  private mode: FrontendMode = "BOOTSTRAP";
  private sessionId: string | undefined;
  private currentLine: RuntimePlayableEventWire | undefined;
  private currentInteraction: unknown;
  private currentPreview: { previewId: string; text: string } | undefined;
  private recentLines: RuntimePlayableEventWire[] = [];
  private status: unknown;
  private ending: unknown;
  private lastError: string | undefined;
  private readonly listeners = new Set<(s: ViewModelState) => void>();

  applyServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "projection.snapshot":
        this.applyProjection(msg.projection);
        return;
      case "runtime.output":
        this.applyOutput(msg.output);
        return;
      default:
        // audio.* messages carry no UI projection; ignore.
        return;
    }
  }

  /** Full-state restore after a reconnect (§9.1). */
  applyProjection(projection: UiProjection): void {
    this.sessionId = projection.sessionId;
    this.currentLine = projection.currentLine;
    this.currentInteraction = projection.currentInteraction;
    this.currentPreview = projection.currentPreview;
    this.recentLines = projection.recentLines.slice(-MAX_RECENT_LINES);
    this.status = projection.status;
    this.ending = projection.ending;
    this.mode = this.deriveModeFromProjection(projection);
    this.notify();
  }

  state(): ViewModelState {
    const state: ViewModelState = {
      mode: this.mode,
      recentLines: [...this.recentLines],
    };
    if (this.sessionId !== undefined) state.sessionId = this.sessionId;
    if (this.currentLine !== undefined) state.currentLine = this.currentLine;
    if (this.currentInteraction !== undefined) state.currentInteraction = this.currentInteraction;
    if (this.currentPreview !== undefined) state.currentPreview = this.currentPreview;
    if (this.status !== undefined) state.status = this.status;
    if (this.ending !== undefined) state.ending = this.ending;
    if (this.lastError !== undefined) state.lastError = this.lastError;
    return state;
  }

  subscribe(listener: (s: ViewModelState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------------------

  private applyOutput(output: RuntimeOutputWire): void {
    switch (output.type) {
      case "session_started":
        this.sessionId = output.sessionId;
        break;
      case "playback_ready":
        this.mode = "PLAYING";
        this.currentLine = output.event;
        this.currentInteraction = undefined;
        this.currentPreview = undefined;
        this.pushRecentLine(output.event);
        break;
      case "interaction_opened":
        this.mode =
          output.interaction?.type === "interaction" && output.interaction.mode === "input"
            ? "INPUT_EDITING"
            : "CHOICE_SELECTING";
        this.currentInteraction = output.interaction;
        this.currentPreview = undefined;
        break;
      case "input_preview_opened":
        this.mode = "INPUT_PREVIEW";
        this.currentPreview = { previewId: output.previewId, text: output.text };
        break;
      case "input_preview_canceled":
        // The same input interaction reopens for editing.
        this.mode = "INPUT_EDITING";
        this.currentPreview = undefined;
        break;
      case "input_committed":
        // Input confirmed; awaiting the LLM response.
        this.mode = "CONTENT_WAITING";
        this.currentPreview = undefined;
        break;
      case "status_changed":
        this.status = output.status;
        break;
      case "session_ended":
        this.mode = "ENDING";
        this.ending = output.ending;
        this.currentLine = undefined;
        this.currentInteraction = undefined;
        this.currentPreview = undefined;
        break;
      case "runtime_error":
        this.mode = "ERROR";
        this.lastError = `${output.code}: ${output.message}`;
        break;
    }
    this.notify();
  }

  private pushRecentLine(line: RuntimePlayableEventWire): void {
    this.recentLines.push(line);
    if (this.recentLines.length > MAX_RECENT_LINES) {
      this.recentLines.splice(0, this.recentLines.length - MAX_RECENT_LINES);
    }
  }

  private deriveModeFromProjection(projection: UiProjection): FrontendMode {
    if (projection.phase === "ended") return "ENDING";
    if (projection.phase === "error") return "ERROR";
    if (projection.currentPreview !== undefined) return "INPUT_PREVIEW";
    if (projection.currentInteraction !== undefined) {
      const interaction = projection.currentInteraction as
        | { type?: string; mode?: string }
        | undefined;
      return interaction?.type === "interaction" && interaction?.mode === "input"
        ? "INPUT_EDITING"
        : "CHOICE_SELECTING";
    }
    if (projection.currentLine !== undefined) return "PLAYING";
    return projection.phase === "running" ? "CONTENT_WAITING" : "BOOTSTRAP";
  }

  private notify(): void {
    const snapshot = this.state();
    for (const listener of [...this.listeners]) {
      listener(snapshot);
    }
  }
}
