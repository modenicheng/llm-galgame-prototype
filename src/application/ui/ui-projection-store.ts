/**
 * UiProjectionStore — the server-side projection of runtime state
 * maintained purely from RuntimeOutput events (§7.7).
 *
 * Lets a reconnecting browser restore its page without restarting the
 * Game: `projection.snapshot` is sent on WebSocket connect.
 */
import type { UiProjection } from "../../shared/wire/ui-projection.js";
import type {
  RuntimeInteractionEvent,
  RuntimeOutput,
} from "../../core/runtime/runtime-output.js";

/** Read the normalized interaction id from a projected interaction. */
function interactionIdOf(value: RuntimeInteractionEvent | undefined): string | null {
  if (value === undefined) return null;
  if ("interaction_id" in value) {
    const id = value.interaction_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return null;
}

export interface UiProjectionStore {
  /** Feed one runtime output into the projection. */
  applyOutput(output: unknown): void;

  /** Current immutable snapshot. */
  snapshot(): UiProjection;

  subscribe(listener: (projection: UiProjection) => void): () => void;
}

/**
 * UiProjectionStoreImpl — maintains the projection purely from
 * RuntimeOutput events (§7.7).
 *
 * Rules:
 * - currentLine from `playback_ready`
 * - currentInteraction from `interaction_opened`
 * - currentPreview from `input_preview_opened`, cleared on
 *   `input_committed` / `input_preview_canceled`
 * - recentLines = the last 8 playable events
 * - status from `status_changed`; ending from `session_ended`
 * - sessionId from `session_started`
 * - phase: running once started, ended on session_ended, error on
 *   runtime_error, idle otherwise
 * - currentInteraction cleared on `interaction_resolved` (matching id) and
 *   defensively on `playback_ready`
 * - currentPreview cleared on `input_committed` / `input_preview_canceled`
 *   and defensively on `playback_ready`
 */
export class UiProjectionStoreImpl implements UiProjectionStore {
  private projection: UiProjection = { phase: "idle", recentLines: [] };
  private readonly listeners = new Set<(projection: UiProjection) => void>();

  /** Keep this many playable events in recentLines. */
  private static readonly RECENT_LINES_LIMIT = 8;

  applyOutput(output: RuntimeOutput): void {
    const next: UiProjection = { ...this.projection };
    switch (output.type) {
      case "session_started":
        next.sessionId = output.sessionId;
        next.phase = "running";
        break;
      case "playback_ready":
        next.currentLine = output.event;
        // Defensive cleanup: entering playback means no form may remain
        // open; a reconnect restores the play state, not a stale form.
        delete next.currentInteraction;
        delete next.currentPreview;
        if (output.presentation !== undefined) {
          next.visualState = output.presentation.visualState;
        }
        next.recentLines = [
          ...next.recentLines.slice(-(UiProjectionStoreImpl.RECENT_LINES_LIMIT - 1)),
          output.event,
        ];
        break;
      case "stage_beat_ready":
        // A bare stage node updates the visual state without a line.
        next.visualState = output.presentation.visualState;
        break;
      case "interaction_opened":
        // Normalize: the top-level interactionId is the authoritative id.
        // Synthetic choice events (type: "choice") carry no interaction_id,
        // so stamp it on so the browser can render and address the
        // interaction after a reconnect.
        next.currentInteraction = {
          ...output.interaction,
          interaction_id: output.interactionId,
        } as RuntimeInteractionEvent;
        if (output.presentation !== undefined) {
          next.visualState = output.presentation.visualState;
        }
        break;
      case "interaction_resolved":
        // The interaction can no longer be submitted; a reconnect must not
        // restore its form. Do NOT clear on input_preview_opened: cancelling
        // the preview reopens the same interaction.
        if (
          next.currentInteraction &&
          interactionIdOf(next.currentInteraction) === output.interactionId
        ) {
          delete next.currentInteraction;
        }
        break;
      case "input_preview_opened":
        next.currentPreview = { previewId: output.previewId, text: output.text };
        break;
      case "input_preview_canceled":
      case "input_committed":
        delete next.currentPreview;
        break;
      case "status_changed":
        next.status = output.status;
        break;
      case "session_ended":
        next.ending = output.ending;
        next.phase = "ended";
        break;
      case "runtime_error":
        next.phase = "error";
        break;
    }
    this.projection = next;
    for (const listener of this.listeners) listener(this.projection);
  }

  snapshot(): UiProjection {
    return this.projection;
  }

  subscribe(listener: (projection: UiProjection) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
