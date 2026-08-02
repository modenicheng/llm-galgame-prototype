/**
 * UiProjectionStore — the server-side projection of runtime state
 * maintained purely from RuntimeOutput events (§7.7).
 *
 * Lets a reconnecting browser restore its page without restarting the
 * Game: `projection.snapshot` is sent on WebSocket connect.
 */
import type { UiProjection } from "../../shared/wire/ui-projection.js";

export interface UiProjectionStore {
  /** Feed one runtime output into the projection. */
  applyOutput(output: unknown): void;

  /** Current immutable snapshot. */
  snapshot(): UiProjection;

  subscribe(listener: (projection: UiProjection) => void): () => void;
}
