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
  | "HYBRID_SELECTING"
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
  /**
   * Monotonic counter incremented on every projection.snapshot restore.
   * The UI uses it to detect a reconnect-driven re-projection and force a
   * panel re-open, which resets the one-shot submit lock (§10.3).
   */
  projectionSeq: number;
}

function isInteraction(
  value: unknown,
): value is { mode: "choice" | "hybrid" | "input" } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "interaction") return false;
  return record.mode === "choice" || record.mode === "hybrid" || record.mode === "input";
}

function isLegacyChoice(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "choice" &&
    typeof record.prompt === "string" &&
    Array.isArray(record.options)
  );
}

/** Derive the frontend mode for an interaction wire object (§11.2). */
export function interactionModeToFrontendMode(interaction: unknown): FrontendMode {
  if (isInteraction(interaction)) {
    switch (interaction.mode) {
      case "choice":
        return "CHOICE_SELECTING";
      case "hybrid":
        return "HYBRID_SELECTING";
      case "input":
        return "INPUT_EDITING";
    }
  }
  if (isLegacyChoice(interaction)) {
    return "CHOICE_SELECTING";
  }
  return "ERROR";
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
  /** Monotonic projection-restore counter (§10.3); 0 until first snapshot. */
  private projectionSeq = 0;
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
    this.projectionSeq += 1;
    this.notify();
  }

  state(): ViewModelState {
    const state: ViewModelState = {
      mode: this.mode,
      recentLines: [...this.recentLines],
      projectionSeq: this.projectionSeq,
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
        // Normalize: the top-level interactionId is the authoritative id.
        // Synthetic choice events (type: "choice") carry no interaction_id,
        // so stamp it on — the UI's asChoiceInteraction and app's
        // interactionIdOf both read interaction_id.
        this.currentInteraction = { ...output.interaction, interaction_id: output.interactionId };
        this.mode = this.deriveModeFromInteraction(this.currentInteraction);
        this.currentPreview = undefined;
        break;
      case "interaction_resolved":
        // The form can no longer be submitted; close it. If a preview is
        // still on screen (resolved is emitted before input_committed), keep
        // INPUT_PREVIEW until the commit lands.
        this.currentInteraction = undefined;
        if (this.mode !== "INPUT_PREVIEW") {
          this.mode = "CONTENT_WAITING";
        }
        break;
      case "input_preview_opened":
        this.mode = "INPUT_PREVIEW";
        this.currentPreview = { previewId: output.previewId, text: output.text };
        break;
      case "input_preview_canceled":
        // The same interaction reopens in its ORIGINAL form — input stays
        // INPUT_EDITING, hybrid stays HYBRID_SELECTING (§11.6).
        this.currentPreview = undefined;
        this.mode = this.deriveModeFromInteraction(this.currentInteraction);
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

  private deriveModeFromInteraction(interaction: unknown): FrontendMode {
    return interactionModeToFrontendMode(interaction);
  }

  private deriveModeFromProjection(projection: UiProjection): FrontendMode {
    if (projection.phase === "ended") return "ENDING";
    if (projection.phase === "error") return "ERROR";
    if (projection.currentPreview !== undefined) return "INPUT_PREVIEW";
    if (projection.currentInteraction !== undefined) {
      return interactionModeToFrontendMode(projection.currentInteraction);
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
