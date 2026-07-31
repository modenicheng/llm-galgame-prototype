/**
 * Latency and cost metrics collector for the GalGame runtime.
 *
 * Tracks LLM request counts, token usage, generation latency, autocomplete
 * acceptance, prefetch hit rates, and player interaction timings.
 * interaction timings. The Game and UI classes import this module to
 * record observability data; a snapshot can be rendered in the TUI or
 * exported for analysis.
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Per-request-type counters emitted by the LLM. */
export interface LLMRequestCounts {
  opening: number;
  branch_prefetch: number;
  continuation: number;
  autocomplete: number;
  speculative: number;
}

/** Aggregated LLM token statistics. */
export interface LLMTokenStats {
  input: number;
  output: number;
}

/** Aggregated end-to-end generation latency (milliseconds). */
export interface LLMLatencyStats {
  p50: number;
  p95: number;
  max: number;
  samples: number;
}

/** Autocomplete acceptance tracking. */
export interface AutocompleteStats {
  accepted: number;
  ignored: number;
  /** accepted / (accepted + ignored), or 0 when neither. */
  acceptance_rate: number;
}

/** Branch prefetch hit-rate tracking. */
export interface PrefetchStats {
  branches_requested: number;
  branches_hit: number;
  branches_missed: number;
  /** branches_hit / (branches_hit + branches_missed), or 0 when neither. */
  hit_rate: number;
}

/** Pre-generated resources that were discarded. */
export interface WasteStats {
  /** Estimated bytes of pre-generated text that the player never saw. */
  text_bytes: number;
  /** Number of pre-generated audio files that were never played. */
  audio_files: number;
}

/** Text-input preview tracking. */
export interface InputStats {
  preview_count: number;
  /** Weighted-average dwell time in milliseconds. */
  avg_dwell_ms: number;
}

/** Schema / state-patch rejection counters. */
export interface ErrorStats {
  schema_validation_failures: number;
  state_patch_rejections: number;
}

/** Player interaction latency samples. */
export interface PlayerTimingStats {
  /** Milliseconds from choice confirmation to first playable line. */
  choice_to_next_line_ms: number[];
}

/** Immutable snapshot of all collected metrics. */
export interface MetricsSnapshot {
  llm: {
    requests: LLMRequestCounts;
    tokens: LLMTokenStats;
    latency_ms: LLMLatencyStats;
  };
  autocomplete: AutocompleteStats;
  prefetch: PrefetchStats;
  waste: WasteStats;
  input: InputStats;
  errors: ErrorStats;
  player: PlayerTimingStats;
}

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const index = p * (sorted.length - 1);
  const floor = Math.floor(index);
  const ceil = Math.ceil(index);
  if (floor === ceil) return sorted[floor]!;
  const fraction = index - floor;
  return sorted[floor]! * (1 - fraction) + sorted[ceil]! * fraction;
}

// ---------------------------------------------------------------------------
// Metrics class
// ---------------------------------------------------------------------------

export class Metrics {
  // --- LLM counters ---
  private requestCounts: LLMRequestCounts = {
    opening: 0,
    branch_prefetch: 0,
    continuation: 0,
    autocomplete: 0,
    speculative: 0,
  };
  private inputTokens = 0;
  private outputTokens = 0;
  private latencySamples: number[] = [];

  // --- Autocomplete ---
  private autocompleteAccepted = 0;
  private autocompleteIgnored = 0;

  // --- Prefetch ---
  private branchesRequested = 0;
  private branchesHit = 0;
  private branchesMissed = 0;

  // --- Waste ---
  private textWasteBytes = 0;
  private audioWasteCount = 0;

  // --- Input ---
  private previewCount = 0;
  private totalDwellMs = 0;

  // --- Errors ---
  private schemaValidationFailures = 0;
  private statePatchRejections = 0;

  // --- Player timing ---
  private choiceToNextLineSamples: number[] = [];

  // ------------------------------------------------------------------
  // Recording methods
  // ------------------------------------------------------------------

  /** Record a completed LLM generation request. */
  recordLLMRequest(
    type: LLMRequestCounts extends Record<infer K, number> ? K : never,
    tokens: { input: number; output: number },
    latencyMs: number,
  ): void {
    this.requestCounts[type] += 1;
    this.inputTokens += tokens.input;
    this.outputTokens += tokens.output;
    this.latencySamples.push(latencyMs);
  }

  /** Call when the player accepts an autocomplete suggestion. */
  recordAutocompleteAccept(): void {
    this.autocompleteAccepted += 1;
  }

  /** Call when the player ignores / dismisses an autocomplete suggestion. */
  recordAutocompleteIgnore(): void {
    this.autocompleteIgnored += 1;
  }

  /** Call when a branch prefetch is queued / started. */
  recordBranchRequested(count = 1): void {
    this.branchesRequested += count;
  }

  /** Call when a prefetched branch is selected by the player. */
  recordPrefetchHit(): void {
    this.branchesHit += 1;
  }

  /** Call when a prefetched branch is NOT selected. */
  recordPrefetchMiss(): void {
    this.branchesMissed += 1;
  }

  /**
   * Record pre-generated text that the player never saw.
   * @param bytes Estimated UTF-8 byte count of wasted text.
   */
  recordTextWaste(bytes: number): void {
    this.textWasteBytes += bytes;
  }

  /**
   * Record pre-generated audio files that were never played.
   * @param count Number of unused audio files.
   */
  recordAudioWaste(count: number): void {
    this.audioWasteCount += count;
  }

  /**
   * Record a text-input preview interaction.
   * @param dwellMs Time (ms) the player spent viewing the preview before
   *   accepting, modifying, or dismissing it.
   */
  recordInputPreview(dwellMs: number): void {
    this.previewCount += 1;
    this.totalDwellMs += dwellMs;
  }

  /** Call when a schema validation failure occurs (JSONL parse error, etc.). */
  recordSchemaValidationFailure(): void {
    this.schemaValidationFailures += 1;
  }

  /** Call when a StoryStatePatch is rejected during merge. */
  recordStatePatchRejection(): void {
    this.statePatchRejections += 1;
  }

  /**
   * Record the wall-clock latency from the moment the player confirms a
   * choice until the first playable line of the selected branch is
   * displayed.
   */
  recordChoiceToNextLine(ms: number): void {
    this.choiceToNextLineSamples.push(ms);
  }

  // ------------------------------------------------------------------
  // Snapshot
  // ------------------------------------------------------------------

  /**
   * Produce an immutable-feeling snapshot of all collected metrics.
   * The returned object is a shallow copy; numeric fields are primitives
   * and arrays are spread-copied so mutations to the snapshot will not
   * affect internal state.
   */
  snapshot(): MetricsSnapshot {
    const sortedLatency = [...this.latencySamples].sort((a, b) => a - b);

    return {
      llm: {
        requests: { ...this.requestCounts },
        tokens: {
          input: this.inputTokens,
          output: this.outputTokens,
        },
        latency_ms: {
          p50: percentile(sortedLatency, 0.5),
          p95: percentile(sortedLatency, 0.95),
          max: sortedLatency.length > 0 ? sortedLatency[sortedLatency.length - 1]! : 0,
          samples: sortedLatency.length,
        },
      },
      autocomplete: {
        accepted: this.autocompleteAccepted,
        ignored: this.autocompleteIgnored,
        acceptance_rate: this.computeRate(
          this.autocompleteAccepted,
          this.autocompleteAccepted + this.autocompleteIgnored,
        ),
      },
      prefetch: {
        branches_requested: this.branchesRequested,
        branches_hit: this.branchesHit,
        branches_missed: this.branchesMissed,
        hit_rate: this.computeRate(
          this.branchesHit,
          this.branchesHit + this.branchesMissed,
        ),
      },
      waste: {
        text_bytes: this.textWasteBytes,
        audio_files: this.audioWasteCount,
      },
      input: {
        preview_count: this.previewCount,
        avg_dwell_ms:
          this.previewCount > 0 ? this.totalDwellMs / this.previewCount : 0,
      },
      errors: {
        schema_validation_failures: this.schemaValidationFailures,
        state_patch_rejections: this.statePatchRejections,
      },
      player: {
        choice_to_next_line_ms: [...this.choiceToNextLineSamples],
      },
    };
  }

  /** Reset all counters. Useful for testing or between sessions. */
  reset(): void {
    this.requestCounts = {
      opening: 0,
      branch_prefetch: 0,
      continuation: 0,
      autocomplete: 0,
      speculative: 0,
    };
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.latencySamples = [];
    this.autocompleteAccepted = 0;
    this.autocompleteIgnored = 0;
    this.branchesRequested = 0;
    this.branchesHit = 0;
    this.branchesMissed = 0;
    this.textWasteBytes = 0;
    this.audioWasteCount = 0;
    this.previewCount = 0;
    this.totalDwellMs = 0;
    this.schemaValidationFailures = 0;
    this.statePatchRejections = 0;
    this.choiceToNextLineSamples = [];
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private computeRate(numerator: number, denominator: number): number {
    if (denominator === 0) return 0;
    return numerator / denominator;
  }
}
