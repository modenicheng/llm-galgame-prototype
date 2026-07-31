/**
 * Manages active-path text generation lifecycle.
 *
 * Ensures at most one active-path generation task is running at any time.
 * Tracks the task status as idle / streaming / canceling so the reconciler
 * can decide whether to start a new generation request.
 */

export type ActivePathTaskStatus = "idle" | "streaming" | "canceling";

export class GenerationScheduler {
  private status: ActivePathTaskStatus = "idle";
  private abortController: AbortController | null = null;
  private readonly listeners = new Set<() => void>();

  /** Whether a generation task is currently active (streaming or canceling). */
  hasActivePathTask(): boolean {
    return this.status !== "idle";
  }

  /** Current status of the active-path task. */
  getActivePathStatus(): ActivePathTaskStatus {
    return this.status;
  }

  /**
   * Transition to streaming status and return an AbortController
   * for the caller to associate with the HTTP request.
   *
   * Throws if a task is already active.
   */
  startActivePath(): AbortController {
    if (this.status !== "idle") {
      throw new Error(
        `Cannot start active-path generation: current status is "${this.status}"`,
      );
    }
    this.status = "streaming";
    this.abortController = new AbortController();
    this.emit();
    return this.abortController;
  }

  /** Transition back to idle after a generation task completes. */
  completeActivePath(): void {
    this.status = "idle";
    this.abortController = null;
    this.emit();
  }

  /**
   * Request cancellation of the active generation task.
   * The underlying AbortController is signaled; the caller
   * should catch the resulting AbortError and call
   * `completeActivePath()` when the request is actually torn down.
   */
  cancelActivePath(): void {
    if (this.status === "idle") return;
    this.status = "canceling";
    this.abortController?.abort();
    this.emit();
  }

  /** Get the signal for the current task, if any. */
  getSignal(): AbortSignal | null {
    return this.abortController?.signal ?? null;
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
