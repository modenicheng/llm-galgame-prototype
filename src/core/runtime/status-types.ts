/**
 * Pure data shapes of the runtime status snapshot. They live in core so
 * `core/runtime/runtime-output.ts` can reference them without a reverse
 * dependency on the `src/runtime/` machinery; `RuntimeStatus` (the mutable
 * hub) stays in `src/runtime/status.ts` and re-exports these.
 */

export type JobState = "queued" | "running" | "ready" | "failed" | "cancelled";

export interface JobStatus {
  label: string;
  state: JobState;
  error: string | null;
}

export interface BranchStatus {
  label: string;
  state: JobState;
  eventCount: number;
  dialogueCount: number;
  error: string | null;
}

export interface MediaStatus {
  enabled: boolean;
  provider: string;
  currentLineId: string | null;
  readyAhead: number;
  queued: number;
  generating: number;
  targetAhead: number;
  refillThreshold: number;
  branchReady: number;
  note: string;
}

export interface RuntimeStatusSnapshot {
  phase: string;
  message: string;
  bufferedEvents: number;
  bufferedDialogueLines: number;
  jobs: Record<string, JobStatus>;
  branches: Record<string, BranchStatus>;
  media: MediaStatus;
}
