/**
 * AudioCacheCleaner — IndexedDB cache eviction (V2 §11.7).
 *
 * Cleanup order:
 *   1. partial / failed / corrupt assets idle longer than `partialTtlMinutes`
 *      (age measured from `lastAccessedAt`, so abandoned writes are reclaimed
 *      while active streaming keeps refreshing it);
 *   2. candidate / input_preview scope assets older than `candidateTtlHours`
 *      (age measured from `createdAt` — discarded branches and canceled
 *      previews age out);
 *   3. least-recently-accessed `complete` assets, oldest first, until total
 *      size is at or below `cleanupTargetBytes` — but only when the cache is
 *      over `maxBytes` in the first place;
 *   4. assets referenced by the CURRENT session (passed via `activeCacheKeys`)
 *      are never deleted, regardless of age or status.
 */
import type { AudioAssetRecord } from "./audio-db.js";
import { AudioDb } from "./audio-db.js";

export interface CleanerOptions {
  maxBytes: number;
  cleanupTargetBytes: number;
  partialTtlMinutes: number;
  candidateTtlHours: number;
}

export interface CleanupReport {
  removed: number;
  freedBytes: number;
}

const TERMINAL_STATUSES = new Set<AudioAssetRecord["status"]>(["partial", "failed", "corrupt"]);
const PREFETCH_SCOPES = new Set<AudioAssetRecord["scopeAtCreation"]>([
  "candidate",
  "input_preview",
]);

export class AudioCacheCleaner {
  constructor(
    private readonly db: AudioDb,
    private readonly options: CleanerOptions,
  ) {}

  run(activeCacheKeys?: Set<string>): Promise<CleanupReport> {
    return this.runInternal(activeCacheKeys ?? new Set<string>());
  }

  private async runInternal(activeCacheKeys: Set<string>): Promise<CleanupReport> {
    const { partialTtlMinutes, candidateTtlHours, maxBytes, cleanupTargetBytes } =
      this.options;
    const partialTtlMs = partialTtlMinutes * 60_000;
    const candidateTtlMs = candidateTtlHours * 3_600_000;
    const now = Date.now();

    const assets = await this.db.listAssets();
    const totalBytes = assets.reduce((sum, asset) => sum + asset.totalBytes, 0);

    const doomed = new Set<string>();
    const lruCandidates: AudioAssetRecord[] = [];

    for (const asset of assets) {
      if (activeCacheKeys.has(asset.cacheKey)) {
        // Current session: never delete, whatever its age or status.
        continue;
      }
      if (TERMINAL_STATUSES.has(asset.status)) {
        if (now - asset.lastAccessedAt > partialTtlMs) {
          doomed.add(asset.cacheKey);
          continue;
        }
      }
      if (PREFETCH_SCOPES.has(asset.scopeAtCreation)) {
        if (now - asset.createdAt > candidateTtlMs) {
          doomed.add(asset.cacheKey);
          continue;
        }
      }
      if (asset.status === "complete") {
        lruCandidates.push(asset);
      }
    }

    let removed = 0;
    let freedBytes = 0;
    for (const asset of assets) {
      if (!doomed.has(asset.cacheKey)) continue;
      await this.db.deleteAsset(asset.cacheKey);
      removed += 1;
      freedBytes += asset.totalBytes;
    }

    let remainingBytes = totalBytes - freedBytes;
    if (remainingBytes > maxBytes) {
      lruCandidates.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
      for (const asset of lruCandidates) {
        if (remainingBytes <= cleanupTargetBytes) break;
        await this.db.deleteAsset(asset.cacheKey);
        removed += 1;
        freedBytes += asset.totalBytes;
        remainingBytes -= asset.totalBytes;
      }
    }

    return { removed, freedBytes };
  }
}
