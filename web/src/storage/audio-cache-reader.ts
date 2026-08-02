/**
 * AudioCacheReader — chunked, incremental reads from the IndexedDB cache
 * (V2 §11.6).
 *
 * `readChunks` yields PCM chunks by sequence without ever loading the whole
 * asset into memory. Only `complete` assets are readable (§22 invariant 14):
 * a streaming/partial/failed/corrupt asset yields nothing.
 *
 * `lookup` is the cross-page hit test — status `complete` (with the record)
 * means playable; anything else is a cache miss. Reads touch `lastAccessedAt`
 * so LRU cleanup can tell live audio from abandoned audio.
 */
import type { AudioAssetRecord } from "./audio-db.js";
import { AudioDb } from "./audio-db.js";

export interface AssetLookup {
  status: AudioAssetRecord["status"];
  /** Present only when an asset record exists for the key. */
  asset?: AudioAssetRecord;
}

export class AudioCacheReader {
  /** Chunks fetched per IDB read — small enough to keep memory bounded. */
  private static readonly READ_BATCH = 16;

  constructor(private readonly db: AudioDb) {}

  /**
   * Look up an asset by cacheKey. A missing key returns `status: "partial"`
   * without an asset record: not a complete hit, so the caller treats it as a
   * cache miss (only `complete` is cross-page readable).
   */
  async lookup(cacheKey: string): Promise<AssetLookup> {
    const asset = await this.db.getAsset(cacheKey);
    if (!asset) return { status: "partial" };
    if (asset.status === "complete") {
      void this.db.updateAsset(cacheKey, { lastAccessedAt: Date.now() }).catch(() => {
        /* read-time access touch is best-effort */
      });
    }
    return { status: asset.status, asset };
  }

  /**
   * Yield the asset's chunks in ascending sequence order, reading a bounded
   * batch at a time. Yields nothing unless the asset is `complete`.
   */
  async *readChunks(cacheKey: string): AsyncGenerator<Uint8Array> {
    const { status } = await this.lookup(cacheKey);
    if (status !== "complete") return;

    let from = 0;
    for (;;) {
      const batch = await this.db.getChunks(cacheKey, from, AudioCacheReader.READ_BATCH);
      if (batch.length === 0) return;
      for (const chunk of batch) {
        yield new Uint8Array(chunk.data);
      }
      if (batch.length < AudioCacheReader.READ_BATCH) return;
      from += batch.length;
    }
  }
}
