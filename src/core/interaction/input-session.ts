/**
 * Streaming input response session.
 *
 * Tracks one NPC response generation for a frozen player input. Events
 * arrive line-by-line and are staged here (never in the formal log);
 * `commit()` promotes the session so later events flow into the formal
 * playback buffer; `cancel()` discards everything.
 *
 * State machine:
 *   generating ──(stream fails)──> failed
 *   generating ──(stream ends)───> ready
 *   generating/ready ──(confirm)─> committed
 *   generating/ready ──(cancel)──> canceled
 */
import type { RuntimeNarrationEvent, RuntimePlayableEvent } from "../../schema.js";

export type InputResponseStatus =
  | "generating"
  | "ready"
  | "committed"
  | "canceled"
  | "failed";

export interface InputResponseSessionInit {
  previewId: string;
  interactionId: string;
  generationId: string;
  frozenText: string;
  bridgeEvents: RuntimeNarrationEvent[];
}

export class InputResponseSession {
  readonly previewId: string;
  readonly interactionId: string;
  readonly generationId: string;
  readonly frozenText: string;
  readonly bridgeEvents: RuntimeNarrationEvent[];
  readonly responseEvents: RuntimePlayableEvent[] = [];
  status: InputResponseStatus = "generating";
  failure: Error | null = null;

  private readonly listeners = new Set<(event: RuntimePlayableEvent) => void>();
  private readonly donePromise: Promise<void>;
  private doneResolve!: () => void;
  private settledInternal = false;

  constructor(init: InputResponseSessionInit) {
    this.previewId = init.previewId;
    this.interactionId = init.interactionId;
    this.generationId = init.generationId;
    this.frozenText = init.frozenText;
    this.bridgeEvents = init.bridgeEvents;
    this.donePromise = new Promise<void>((resolve) => {
      this.doneResolve = resolve;
    });
  }

  /** Stage one arrived response event. Dropped after cancellation. */
  appendResponseEvent(event: RuntimePlayableEvent): void {
    if (this.status === "canceled") return;
    this.responseEvents.push(event);
    for (const listener of this.listeners) listener(event);
  }

  /** Whether the generation stream has ended (ready or failed). */
  get settled(): boolean {
    return this.settledInternal;
  }

  /** The generation stream ended cleanly. */
  markReady(): void {
    this.settledInternal = true;
    // A committed session must not be downgraded by a late stream end.
    if (this.status === "canceled" || this.status === "committed") {
      this.doneResolve();
      return;
    }
    this.status = "ready";
    this.doneResolve();
  }

  /** The generation stream failed. */
  markFailed(error: Error): void {
    this.settledInternal = true;
    // Keep the committed status (the confirmed prefix stays valid) but
    // still record the failure for diagnostics.
    this.failure = error;
    if (this.status === "canceled" || this.status === "committed") {
      this.doneResolve();
      return;
    }
    this.status = "failed";
    this.doneResolve();
  }

  /** Player confirmed: later events may enter the formal path. */
  commit(): void {
    if (this.status === "canceled") return;
    this.status = "committed";
  }

  /** Player cancelled: drop events forever. */
  cancel(): void {
    this.status = "canceled";
    this.responseEvents.length = 0;
    this.doneResolve();
  }

  /** Subscribe to events arriving after `commit()` (live promotion). */
  subscribe(listener: (event: RuntimePlayableEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when the generation stream ends (ready or failed). */
  get done(): Promise<void> {
    return this.donePromise;
  }

  get events(): readonly RuntimePlayableEvent[] {
    return this.responseEvents;
  }
}
