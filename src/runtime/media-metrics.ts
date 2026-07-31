/**
 * Media scheduling metrics for observability and waste analysis.
 *
 * These counters are maintained by MediaPrefetchScheduler and exposed
 * via getMetrics(). The wasteRatio measures how many synthesized lines
 * were never used (e.g. cancelled branch prefetches).
 */

export interface MediaMetrics {
  /** How many synthesize() calls were started. */
  totalSynthesisRequests: number;
  /** How many lines successfully reached the "ready" state. */
  totalLinesSynthesized: number;
  /** How many lines failed (non-abort errors during synthesis). */
  totalSynthesisFailures: number;
  /** How many lines were cancelled (aborted before completion). */
  totalLinesCancelled: number;
  /** How many prefetchBranch() calls were made. */
  totalBranchesPrefetched: number;
  /** How many synthesized lines belong to the active path. */
  totalActiveLinesSynthesized: number;
  /** Cumulative synthesis latency in milliseconds. */
  totalSynthesisLatencyMs: number;
  /** Number of completed synthesis batches (for computing average). */
  synthesisCount: number;
}

/**
 * Compute the waste ratio: fraction of synthesized lines that were wasted
 * (canceled or belonged to unselected branches).
 *
 * Returns a value in [0, 1], or 0 if no lines were synthesized.
 */
export function computeWasteRatio(metrics: MediaMetrics): number {
  if (metrics.totalLinesSynthesized === 0) return 0;
  const wasted =
    metrics.totalLinesSynthesized - metrics.totalActiveLinesSynthesized;
  return Math.max(0, wasted / metrics.totalLinesSynthesized);
}

/**
 * Compute the average synthesis latency in milliseconds.
 *
 * Returns 0 if no batches have completed.
 */
export function averageLatencyMs(metrics: MediaMetrics): number {
  if (metrics.synthesisCount === 0) return 0;
  return metrics.totalSynthesisLatencyMs / metrics.synthesisCount;
}
