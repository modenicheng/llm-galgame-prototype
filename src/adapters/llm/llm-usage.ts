/**
 * Parse the `usage` object returned by OpenAI-compatible chat APIs.
 *
 * Providers express prompt-cache hits differently: the OpenAI standard
 * reports `prompt_tokens_details.cached_tokens`, DeepSeek reports a flat
 * `prompt_cache_hit_tokens`. Both count input tokens whose prompt prefix
 * was served from the provider cache, so they normalize into one
 * `cachedInput` value (always a subset of `input`). Returns null when the
 * payload lacks the required counters so callers can fall back to their
 * own estimates.
 */

export interface LLMUsageReading {
  /** Prompt tokens billed for the request (includes cachedInput). */
  input: number;
  /** Completion tokens generated for the request. */
  output: number;
  /** Input tokens served from the provider prefix cache (subset of input). */
  cachedInput: number;
  /**
   * Completion tokens spent on thinking (subset of output); undefined when
   * the provider does not report the breakdown (thinking off / gateway
   * strips it).
   */
  reasoningTokens?: number;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseLLMUsage(raw: unknown): LLMUsageReading | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usage = raw as Record<string, unknown>;
  if (!finiteNonNegative(usage.prompt_tokens)) return null;
  if (!finiteNonNegative(usage.completion_tokens)) return null;

  const details =
    typeof usage.prompt_tokens_details === "object" &&
    usage.prompt_tokens_details !== null
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : undefined;
  const openAI =
    details && finiteNonNegative(details.cached_tokens)
      ? details.cached_tokens
      : 0;
  const deepseek = finiteNonNegative(usage.prompt_cache_hit_tokens)
    ? usage.prompt_cache_hit_tokens
    : 0;
  const cachedInput = Math.min(openAI || deepseek, usage.prompt_tokens);

  // DeepSeek thinking mode reports reasoning tokens here; absent when
  // thinking is off or the gateway strips details.
  const completionDetails =
    typeof usage.completion_tokens_details === "object" &&
    usage.completion_tokens_details !== null
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : undefined;
  const reasoningTokens =
    completionDetails && finiteNonNegative(completionDetails.reasoning_tokens)
      ? completionDetails.reasoning_tokens
      : undefined;

  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
    cachedInput,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}
