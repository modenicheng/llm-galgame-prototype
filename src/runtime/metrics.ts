/**
 * Latency and cost metrics collector for the GalGame runtime.
 *
 * Tracks LLM request counts, token usage, generation latency, prefetch hit
 * rates, and player interaction timings. The Game and UI classes import
 * this module to record observability data; a snapshot can be rendered in
 * the TUI or exported for analysis.
 */

import type { AssetDiagnosticCode } from "../core/protocol/gal-dsl/types.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Per-request-type counters emitted by the LLM. */
export interface LLMRequestCounts {
  opening: number;
  branch_prefetch: number;
  continuation: number;
  /** Scene-transition narration after a confirmed free-text input. */
  input_bridge: number;
  /** NPC response to a confirmed free-text input. */
  input_response: number;
  /** Longform mode: director plan generation. */
  plot_plan: number;
  /** Longform mode: memory consolidation. */
  narrative_consolidation: number;
  /** Rolling recap of history events that slid out of the window. */
  recap_summarization: number;
  speculative: number;
}

/** Discriminator for one LLM request type (key of LLMRequestCounts). */
export type LLMRequestType = keyof LLMRequestCounts;

/** Aggregated LLM token statistics. */
export interface LLMTokenStats {
  input: number;
  output: number;
  /** Input tokens served from the provider prefix cache (subset of input). */
  cached_input: number;
  /** Output tokens spent on thinking (subset of output). */
  reasoning: number;
}

/** Aggregated end-to-end generation latency (milliseconds). */
export interface LLMLatencyStats {
  p50: number;
  p95: number;
  max: number;
  samples: number;
}

/** Deterministic DSL repair counters (kind → occurrences). */
export interface WriterRepairStats {
  total: number;
  by_kind: Record<string, number>;
}

/** Writer attempt outcome counters (one per settled attempt). */
export interface WriterOutcomeStats {
  done: number;
  failed: number;
  retried: number;
  cancelled: number;
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
  /** Times the bridge narration ran out before the response's first line. */
  response_underrun_count: number;
  /** Confirm → first response line arrived, in ms. */
  confirm_to_first_response_line_ms: number[];
  /** Bridge playback started → first response line played, in ms. */
  bridge_cover_duration_ms: number[];
  /** Previewed inputs cancelled with Esc. */
  response_canceled_count: number;
  /** Events dropped because they belonged to a stale/cancelled session. */
  stale_input_event_dropped_count: number;
  /** Confirmed while the response stream was still generating (promoted). */
  response_promoted_live_count: number;
}

/** Schema validation failure counters. */
export interface ErrorStats {
  schema_validation_failures: number;
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
    /** tokens.cached_input / tokens.input, or 0 when no input was billed. */
    cache_hit_rate: number;
    latency_ms: LLMLatencyStats;
    /** Request start → first CONTENT delta (thinking time included). */
    ttft_ms: LLMLatencyStats;
    /** First reasoning delta → first content delta; samples only when
     * thinking ran (thinking off → samples: 0). */
    thinking_ms: LLMLatencyStats;
  };
  prefetch: PrefetchStats;
  waste: WasteStats;
  input: InputStats;
  errors: ErrorStats;
  player: PlayerTimingStats;
  /** Writer DSL repair / attempt-outcome counters (monitor dashboard). */
  writer: {
    repairs: WriterRepairStats;
    outcomes: WriterOutcomeStats;
  };
  /** Asset diagnostic counts (spec §7), code → occurrences. */
  asset_diagnostics?: Record<string, number>;
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
    input_bridge: 0,
    input_response: 0,
    plot_plan: 0,
    narrative_consolidation: 0,
    recap_summarization: 0,
    speculative: 0,
  };
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private reasoningTokens = 0;
  private latencySamples: number[] = [];
  private ttftSamples: number[] = [];
  private thinkingMsSamples: number[] = [];

  // --- Writer repairs / outcomes ---
  private repairCounts = new Map<string, number>();
  private repairTotal = 0;
  private outcomeCounts: WriterOutcomeStats = {
    done: 0,
    failed: 0,
    retried: 0,
    cancelled: 0,
  };

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
  private responseUnderrunCount = 0;
  private confirmToFirstResponseLineSamples: number[] = [];
  private bridgeCoverDurationSamples: number[] = [];
  private responseCanceledCount = 0;
  private staleInputEventDroppedCount = 0;
  private responsePromotedLiveCount = 0;

  // --- Errors ---
  private schemaValidationFailures = 0;

  // --- Player timing ---
  private choiceToNextLineSamples: number[] = [];

  // --- Asset diagnostics (spec §7) ---
  private readonly assetDiagnostics = new Map<string, number>();

  // ------------------------------------------------------------------
  // Recording methods
  // ------------------------------------------------------------------

  /** Record a completed LLM generation request. */
  recordLLMRequest(
    type: LLMRequestType,
    tokens: { input: number; output: number; cachedInput?: number; reasoningTokens?: number },
    latencyMs: number,
  ): void {
    this.requestCounts[type] += 1;
    this.inputTokens += tokens.input;
    this.outputTokens += tokens.output;
    this.cachedInputTokens += tokens.cachedInput ?? 0;
    this.reasoningTokens += tokens.reasoningTokens ?? 0;
    this.latencySamples.push(latencyMs);
  }

  /** Record request start → first CONTENT delta (thinking time included). */
  recordFirstToken(ms: number): void {
    this.ttftSamples.push(ms);
  }

  /** Record first reasoning delta → first content delta (thinking runs only). */
  recordThinkingMs(ms: number): void {
    this.thinkingMsSamples.push(ms);
  }

  /** Count one deterministic DSL repair applied to the writer's output. */
  recordDslRepair(kind: string): void {
    this.repairCounts.set(kind, (this.repairCounts.get(kind) ?? 0) + 1);
    this.repairTotal += 1;
  }

  /** Count one settled writer attempt outcome. */
  recordWriterOutcome(state: "done" | "failed" | "retried" | "cancelled"): void {
    this.outcomeCounts[state] += 1;
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

  /** Call when the bridge narration runs out before the response's first line. */
  recordInputResponseUnderrun(): void {
    this.responseUnderrunCount += 1;
  }

  /** Call when the first response line arrives after the confirm. */
  recordInputConfirmToFirstResponseLine(ms: number): void {
    this.confirmToFirstResponseLineSamples.push(ms);
  }

  /** Call when the bridge cover window (bridge start → first response line) ends. */
  recordInputBridgeCoverDuration(ms: number): void {
    this.bridgeCoverDurationSamples.push(ms);
  }

  /** Call when a previewed input is cancelled with Esc. */
  recordInputResponseCanceled(): void {
    this.responseCanceledCount += 1;
  }

  /** Call when an event from a stale/cancelled input session is dropped. */
  recordStaleInputEventDropped(): void {
    this.staleInputEventDroppedCount += 1;
  }

  /** Call when a confirmed input response is promoted to the live path. */
  recordInputResponsePromotedLive(): void {
    this.responsePromotedLiveCount += 1;
  }

  /** Call when a schema validation failure occurs (DSL parse error, etc.). */
  recordSchemaValidationFailure(): void {
    this.schemaValidationFailures += 1;
  }

  /**
   * Record the wall-clock latency from the moment the player confirms a
   * choice until the first playable line of the selected branch is
   * displayed.
   */
  recordChoiceToNextLine(ms: number): void {
    this.choiceToNextLineSamples.push(ms);
  }

  /** Count one dropped-cue asset diagnostic (spec §7). */
  recordAssetDiagnostic(code: AssetDiagnosticCode): void {
    this.assetDiagnostics.set(code, (this.assetDiagnostics.get(code) ?? 0) + 1);
  }

  /**
   * Current asset-diagnostic counts (code → occurrences). Returns a copy;
   * mutating it never affects internal state.
   */
  assetDiagnosticCounts(): Record<string, number> {
    return Object.fromEntries(this.assetDiagnostics);
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
    const sortedTtft = [...this.ttftSamples].sort((a, b) => a - b);
    const sortedThinking = [...this.thinkingMsSamples].sort((a, b) => a - b);

    return {
      llm: {
        requests: { ...this.requestCounts },
        tokens: {
          input: this.inputTokens,
          output: this.outputTokens,
          cached_input: this.cachedInputTokens,
          reasoning: this.reasoningTokens,
        },
        cache_hit_rate: this.computeRate(
          this.cachedInputTokens,
          this.inputTokens,
        ),
        latency_ms: {
          p50: percentile(sortedLatency, 0.5),
          p95: percentile(sortedLatency, 0.95),
          max: sortedLatency.length > 0 ? sortedLatency[sortedLatency.length - 1]! : 0,
          samples: sortedLatency.length,
        },
        ttft_ms: {
          p50: percentile(sortedTtft, 0.5),
          p95: percentile(sortedTtft, 0.95),
          max: sortedTtft.length > 0 ? sortedTtft[sortedTtft.length - 1]! : 0,
          samples: sortedTtft.length,
        },
        thinking_ms: {
          p50: percentile(sortedThinking, 0.5),
          p95: percentile(sortedThinking, 0.95),
          max: sortedThinking.length > 0
            ? sortedThinking[sortedThinking.length - 1]!
            : 0,
          samples: sortedThinking.length,
        },
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
        response_underrun_count: this.responseUnderrunCount,
        confirm_to_first_response_line_ms: [...this.confirmToFirstResponseLineSamples],
        bridge_cover_duration_ms: [...this.bridgeCoverDurationSamples],
        response_canceled_count: this.responseCanceledCount,
        stale_input_event_dropped_count: this.staleInputEventDroppedCount,
        response_promoted_live_count: this.responsePromotedLiveCount,
      },
      errors: {
        schema_validation_failures: this.schemaValidationFailures,
      },
      player: {
        choice_to_next_line_ms: [...this.choiceToNextLineSamples],
      },
      writer: {
        repairs: {
          total: this.repairTotal,
          by_kind: Object.fromEntries(this.repairCounts),
        },
        outcomes: { ...this.outcomeCounts },
      },
      asset_diagnostics: this.assetDiagnosticCounts(),
    };
  }

  /** Reset all counters. Useful for testing or between sessions. */
  reset(): void {
    this.requestCounts = {
      opening: 0,
      branch_prefetch: 0,
      continuation: 0,
      input_bridge: 0,
      input_response: 0,
      plot_plan: 0,
      narrative_consolidation: 0,
      recap_summarization: 0,
      speculative: 0,
    };
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cachedInputTokens = 0;
    this.reasoningTokens = 0;
    this.latencySamples = [];
    this.ttftSamples = [];
    this.thinkingMsSamples = [];
    this.repairCounts.clear();
    this.repairTotal = 0;
    this.outcomeCounts = { done: 0, failed: 0, retried: 0, cancelled: 0 };
    this.branchesRequested = 0;
    this.branchesHit = 0;
    this.branchesMissed = 0;
    this.textWasteBytes = 0;
    this.audioWasteCount = 0;
    this.previewCount = 0;
    this.totalDwellMs = 0;
    this.responseUnderrunCount = 0;
    this.confirmToFirstResponseLineSamples = [];
    this.bridgeCoverDurationSamples = [];
    this.responseCanceledCount = 0;
    this.staleInputEventDroppedCount = 0;
    this.responsePromotedLiveCount = 0;
    this.schemaValidationFailures = 0;
    this.choiceToNextLineSamples = [];
    this.assetDiagnostics.clear();
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private computeRate(numerator: number, denominator: number): number {
    if (denominator === 0) return 0;
    return numerator / denominator;
  }
}
