/**
 * ContextLlmRecorder — audit port for the background (non-streaming) LLM
 * agents: the memory agent, the recap summarizer, the narrative
 * consolidator and the plot planner. The writer's DSL streams have their
 * own observer-based recorder (DslStreamObserver + LlmStreamRecorder);
 * these four adapters call `chat.completions.create` directly, so the
 * exact request body only exists inside them — they hand it to this port
 * around their single provider call.
 *
 * Contract: `recordContextRequest` returns the `call()` result verbatim,
 * rethrows `call()` errors verbatim (after recording the failure), and a
 * recorder malfunction must never alter the call's outcome — audit is
 * best-effort, the agent's own error handling stays authoritative.
 */

export type ContextLlmTaskType =
  | "memory_agent"
  | "recap_summarization"
  | "narrative_consolidation"
  | "plot_plan";

/** Chat messages as sent (these agents only ever use plain-text content). */
export interface ContextLlmMessage {
  role: string;
  content: string;
}

/** Provider-reported token usage, normalized like parseLLMUsage's reading. */
export interface ContextLlmUsage {
  input: number;
  output: number;
  /** Input tokens served from the provider prefix cache (subset of input). */
  cachedInput: number;
  /** Completion tokens spent on thinking; absent when not reported. */
  reasoningTokens?: number;
}

/**
 * The request body exactly as it goes to the provider (`messages` plus
 * model/sampling/thinking parameters) — recorded verbatim, no truncation.
 */
export type ContextLlmRequestBody = {
  model: string;
  messages: ContextLlmMessage[];
  [parameter: string]: unknown;
};

export interface ContextLlmRecorderRequest {
  taskType: ContextLlmTaskType;
  body: ContextLlmRequestBody;
  /** Trigger context (event counts, checkpoint…) — lands in the index row. */
  meta?: Record<string, unknown>;
}

/** Provider call result handed back through the recorder. */
export interface ContextLlmResult {
  /** Assistant message content, verbatim (untrimmed). */
  raw: string;
  /** Normalized usage; null when the provider did not report counters. */
  usage: ContextLlmUsage | null;
}

export interface ContextLlmRecorder {
  recordContextRequest(
    request: ContextLlmRecorderRequest,
    call: () => Promise<ContextLlmResult>,
  ): Promise<ContextLlmResult>;
}
