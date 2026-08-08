/**
 * UiProjection — the lightweight server-side projection of the runtime
 * that the browser restores from on reconnect.
 *
 * Lives in shared/wire because both the Node application layer (which
 * maintains it from RuntimeOutput) and the browser (which consumes it)
 * need the same shape. It is pure data; type-only imports from core are
 * erased at compile time.
 */
import type { RuntimePlayableEvent } from "../../schema.js";
import type { RuntimeInteractionEvent } from "../../core/runtime/runtime-output.js";
import type { EndEvent } from "../../schema.js";
import type { RuntimeStatusSnapshot } from "../../status.js";
import type { VisualState } from "../../core/presentation/types.js";

export interface UiProjection {
  sessionId?: string;
  phase: "idle" | "running" | "ended" | "error";

  currentLine?: RuntimePlayableEvent;
  currentInteraction?: RuntimeInteractionEvent;
  currentPreview?: {
    previewId: string;
    text: string;
  };

  /**
   * Authoritative stage state — restored on reconnect so the browser does
   * not have to replay stage cues from the first line (docs §64, §107).
   */
  visualState?: VisualState;

  recentLines: RuntimePlayableEvent[];
  status?: RuntimeStatusSnapshot;
  ending?: EndEvent;
}
