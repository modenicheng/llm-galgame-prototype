/**
 * Core input state machine for the two-phase free-text commit flow.
 *
 * Flow:
 *   editing ──(first Enter)──> preview ──(Enter)──> committed
 *     ^                          |
 *     └──────(Esc/cancel)────────┘
 *
 * Revision is a monotonic counter incremented on every draft mutation
 * and every cancel → re-edit cycle.
 */

import type { InteractionEvent, RuntimePlayableEvent } from "../schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InputPhase = "editing" | "preview" | "committed" | "cancelled";

export interface InputSession {
  /** Links back to the InteractionEvent that triggered this session. */
  interaction_id: string;
  /** Current phase of the two-phase commit. */
  phase: InputPhase;
  /** Current draft text being edited. */
  draft: string;
  /** Monotonic counter incremented on every mutation. */
  revision: number;
  /** Frozen text captured when entering preview. */
  preview_text: string;
  /** NPC response events generated during the preview phase. */
  response_events?: RuntimePlayableEvent[];
  /** Timestamps for tracking session lifecycle. */
  created_at: number;
  previewed_at?: number;
  committed_at?: number;
}

// ---------------------------------------------------------------------------
// InputEngine
// ---------------------------------------------------------------------------

export class InputEngine {
  private sessions = new Map<string, InputSession>();

  /**
   * Begin a new input session for the given interaction event.
   * If a session already exists for this interaction_id, it is discarded.
   */
  startEditing(interaction: InteractionEvent): InputSession {
    const session: InputSession = {
      interaction_id: interaction.interaction_id,
      phase: "editing",
      draft: "",
      revision: 0,
      preview_text: "",
      created_at: Date.now(),
    };
    this.sessions.set(interaction.interaction_id, session);
    return session;
  }

  /**
   * Update the draft text. Increments revision.
   * Only valid in "editing" phase.
   */
  updateDraft(session: InputSession, newText: string): InputSession {
    this.assertPhase(session, "editing");
    session.draft = newText;
    session.revision += 1;
    return session;
  }

  /**
   * Freeze the draft text and transition to preview.
   * Only valid in "editing" phase.
   */
  requestPreview(session: InputSession): InputSession {
    this.assertPhase(session, "editing");
    session.preview_text = session.draft;
    session.phase = "preview";
    session.previewed_at = Date.now();
    session.revision += 1;
    return session;
  }

  /**
   * Finalize the input and transition to committed.
   * Only valid in "preview" phase.
   */
  commit(session: InputSession): InputSession {
    this.assertPhase(session, "preview");
    session.phase = "committed";
    session.committed_at = Date.now();
    session.revision += 1;
    return session;
  }

  /**
   * Return to editing from preview. Increments revision.
   * Only valid in "preview" phase.
   */
  cancel(session: InputSession): InputSession {
    this.assertPhase(session, "preview");
    session.phase = "editing";
    delete session.response_events;
    session.revision += 1;
    return session;
  }

  /**
   * The text that should be displayed in the input box.
   * - editing: current draft
   * - preview: frozen preview_text
   */
  getDisplayText(session: InputSession): string {
    if (session.phase === "preview") return session.preview_text;
    return session.draft;
  }

  /**
   * Current phase of the session.
   */
  getPhase(session: InputSession): InputPhase {
    return session.phase;
  }

  /**
   * Attach NPC response events to the session (called when generation completes).
   */
  setResponseEvents(
    session: InputSession,
    events: RuntimePlayableEvent[]
  ): InputSession {
    session.response_events = events;
    return session;
  }

  /**
   * Get the committed text (only valid in committed phase).
   */
  getCommittedText(session: InputSession): string {
    this.assertPhase(session, "committed");
    return session.preview_text;
  }

  private assertPhase(
    session: InputSession,
    expected: InputPhase
  ): void {
    if (session.phase !== expected) {
      throw new Error(
        `InputEngine: expected phase "${expected}" but got "${session.phase}" for interaction ${session.interaction_id}`
      );
    }
  }
}
