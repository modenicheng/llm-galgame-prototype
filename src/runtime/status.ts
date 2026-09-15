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

type Listener = (snapshot: RuntimeStatusSnapshot) => void;

export class RuntimeStatus {
  private phase = "启动";
  private message = "正在初始化";
  private bufferedEvents = 0;
  private bufferedDialogueLines = 0;
  private readonly jobs = new Map<string, JobStatus>();
  private readonly branches = new Map<string, BranchStatus>();
  private media: MediaStatus = {
    enabled: false,
    provider: "disabled",
    currentLineId: null,
    readyAhead: 0,
    queued: 0,
    generating: 0,
    targetAhead: 0,
    refillThreshold: 0,
    branchReady: 0,
    note: "仅文本模式"
  };
  private readonly listeners = new Set<Listener>();

  snapshot(): RuntimeStatusSnapshot {
    return {
      phase: this.phase,
      message: this.message,
      bufferedEvents: this.bufferedEvents,
      bufferedDialogueLines: this.bufferedDialogueLines,
      jobs: Object.fromEntries(
        [...this.jobs.entries()].map(([key, value]) => [key, { ...value }])
      ),
      branches: Object.fromEntries(
        [...this.branches.entries()].map(([key, value]) => [key, { ...value }])
      ),
      media: { ...this.media }
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPhase(phase: string, message: string): void {
    this.phase = phase;
    this.message = message;
    this.emit();
  }

  setBuffer(events: number, dialogueLines: number): void {
    this.bufferedEvents = events;
    this.bufferedDialogueLines = dialogueLines;
    this.emit();
  }

  setJob(id: string, label: string, state: JobState, error: string | null = null): void {
    this.jobs.set(id, { label, state, error });
    this.emit();
  }

  removeJob(id: string): void {
    if (this.jobs.delete(id)) this.emit();
  }

  setBranch(
    id: string,
    label: string,
    state: JobState,
    eventCount = 0,
    dialogueCount = 0,
    error: string | null = null
  ): void {
    this.branches.set(id, {
      label,
      state,
      eventCount,
      dialogueCount,
      error
    });
    this.emit();
  }

  clearBranches(): void {
    if (this.branches.size === 0) return;
    this.branches.clear();
    this.emit();
  }

  setMedia(patch: Partial<MediaStatus>): void {
    this.media = { ...this.media, ...patch };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
