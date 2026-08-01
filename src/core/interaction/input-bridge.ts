/**
 * Holds materialized input bridge narration for open interactions.
 *
 * Bridges are materialized (stable line_ids assigned) when the terminal
 * interaction arrives, but they never enter the formal event log. They
 * are kept until the interaction resolves: discarded when the player
 * picks a preset option, or played after the player confirms their input
 * (before the NPC response).
 */
import type { RuntimeNarrationEvent } from "../../schema.js";

export class InputBridgeBuffer {
  private readonly bridges = new Map<string, RuntimeNarrationEvent[]>();

  store(interactionId: string, events: RuntimeNarrationEvent[]): void {
    this.bridges.set(interactionId, events);
  }

  /** Look up a bridge without removing it (e.g. across preview cancels). */
  peek(interactionId: string): RuntimeNarrationEvent[] | null {
    return this.bridges.get(interactionId) ?? null;
  }

  /** Retrieve and remove the bridge for an interaction. */
  take(interactionId: string): RuntimeNarrationEvent[] | null {
    const events = this.bridges.get(interactionId);
    if (events !== undefined) this.bridges.delete(interactionId);
    return events ?? null;
  }

  discard(interactionId: string): void {
    this.bridges.delete(interactionId);
  }
}
