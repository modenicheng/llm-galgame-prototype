/**
 * DslStreamObserver — a read-only tap into the writer LLM's streaming DSL
 * output (monitor dashboard).
 *
 * The StoryGenerator calls these hooks while it consumes the SSE stream;
 * observers must not throw and must not modify generation behavior. The
 * interface lives in core so the adapter depends on it (not the other way
 * round); MonitorHub (application layer) implements it.
 *
 * Attempts: one logical request (`taskId`, unique per nonce) may run several
 * repair attempts; each attempt gets its own `attemptId`
 * (`${taskId}#${attemptIndex}`) and a fresh text stream.
 */
export interface WriterAttemptInfo {
  attemptId: string;
  taskId: string;
  /** opening | continuation | branch_prefetch | input_response | input_bridge */
  taskType: string;
  index: number;
}

/** Parse outcome of one complete DSL line; `kind: null` marks fence lines. */
export interface WriterLineParse {
  kind: string | null;
  error?: string;
}

export type WriterAttemptEndState = "done" | "failed" | "retried";

export interface WriterAttemptEnd {
  state: WriterAttemptEndState;
  error?: string;
  /** SegmentEndReason when the attempt completed (@end reason). */
  segmentEnd?: string;
}

export interface WriterRepair {
  kind: "end_keyword" | "form_close" | "visual_swap";
  lineIndex: number;
  message: string;
}

export interface WriterAttemptUsage {
  input: number;
  output: number;
  cachedInput: number;
  source: "api" | "estimated";
  latencyMs: number;
}

export interface DslStreamObserver {
  /** A streaming attempt started; arrives before any delta. */
  onAttemptStart(info: WriterAttemptInfo): void;
  /** One raw SSE content delta, verbatim. */
  onDelta(attemptId: string, text: string): void;
  /** One complete DSL line was parsed (or rejected) by the generator. */
  onLine(attemptId: string, lineIndex: number, parse: WriterLineParse): void;
  /** One event group was committed and forwarded to the runtime. */
  onGroup(attemptId: string, groupIndex: number, kind: string, summary: string): void;
  /** One narrowly-scoped, deterministic DSL repair was applied. */
  onRepair?(attemptId: string, repair: WriterRepair): void;
  /** Provider-reported or fallback-estimated request usage. */
  onUsage?(attemptId: string, usage: WriterAttemptUsage): void;
  /** The attempt settled (complete / failed / repair-retry). */
  onAttemptEnd(attemptId: string, outcome: WriterAttemptEnd): void;
}
