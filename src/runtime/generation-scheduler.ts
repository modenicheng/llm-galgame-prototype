/**
 * Manages active-path text generation lifecycle.
 *
 * Ensures at most one active-path generation task is running at any time.
 * Tracks the task status as idle / streaming / canceling so the reconciler
 * can decide whether to start a new generation request.
 */

export type ActivePathTaskStatus = "idle" | "streaming" | "canceling";
export type ActivePathTaskOwner = "active_path" | { type: "candidate_branch"; branchId: string };

export class GenerationScheduler {
  private status: ActivePathTaskStatus = "idle";
  private abortController: AbortController | null = null;
  private taskId: string | null = null;
  private owner: ActivePathTaskOwner | null = null;
  private readonly listeners = new Set<() => void>();

  /** Whether a generation task is currently active (streaming or canceling). */
  hasActivePathTask(): boolean {
    return this.status !== "idle";
  }

  /** Current status of the active-path task. */
  getActivePathStatus(): ActivePathTaskStatus {
    return this.status;
  }

  /** Identifier of the task currently owning the active path. */
  getTaskId(): string | null {
    return this.taskId;
  }

  /** Owner of the task currently occupying the active path. */
  getOwner(): ActivePathTaskOwner | null {
    return this.owner;
  }

  /**
   * Transition to streaming status and return an AbortController
   * for the caller to associate with the HTTP request.
   *
   * Throws if a task is already active.
   */
  startActivePath(taskId = `active:${Date.now()}`): AbortController {
    if (this.status !== "idle") {
      throw new Error(
        `Cannot start active-path generation: current status is "${this.status}"`,
      );
    }
    this.status = "streaming";
    this.taskId = taskId;
    this.owner = "active_path";
    this.abortController = new AbortController();
    this.emit();
    return this.abortController;
  }

  /**
   * Promote an already-running candidate branch to the active path.
   * The HTTP request and AbortController are retained; no second request is
   * created and no restart is required.
   */
  adoptCandidateBranch(taskId: string, branchId: string, controller: AbortController): void {
    if (this.status !== "idle") {
      throw new Error(
        `Cannot adopt candidate branch: current status is "${this.status}"`,
      );
    }
    this.status = "streaming";
    this.taskId = taskId;
    this.owner = { type: "candidate_branch", branchId };
    this.abortController = controller;
    this.emit();
  }

  /** Transition back to idle only for the task that currently owns the path. */
  completeActivePath(taskId?: string): void {
    if (taskId !== undefined && this.taskId !== taskId) return;
    this.status = "idle";
    this.taskId = null;
    this.owner = null;
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
