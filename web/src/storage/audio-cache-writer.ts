/**
 * AudioCacheWriter — the IndexedDB BatchWriter (V2 §11.4/§11.5).
 *
 * The playback path feeds PCM chunks via `append()`, which is synchronous and
 * fire-and-forget: it never returns a promise and never blocks playback on an
 * IndexedDB transaction (§22 invariant 13). Bytes accumulate in a batch
 * buffer; the batch is persisted in ONE transaction when it reaches
 * `writeBatchBytes` or when `flushIntervalMs` elapses.
 *
 * Completion is two-phase: `startAsset` creates a `streaming` asset, chunks
 * are written while streaming, and `finishComplete` promotes the asset to
 * `complete` only when the sequence is contiguous (every chunk 0..n-1 landed)
 * and the accumulated byte count matches what was appended. Anything short of
 * that (interrupt, mismatch) becomes `partial`.
 */
import type { AudioAssetRecord } from "./audio-db.js";
import { AudioDb, type WriteChunkInput } from "./audio-db.js";

export interface CacheWriteOptions {
  /** Persist a batch once this many bytes have accumulated. */
  writeBatchBytes: number;
  /** Fallback timer: flush the batch this long after the first pending byte. */
  flushIntervalMs: number;
}

export interface StartAssetMeta {
  encoding: "pcm_s16le";
  sampleRate: number;
  channels: 1;
  bitDepth: 16;
  scopeAtCreation: AudioAssetRecord["scopeAtCreation"];
}

interface PendingBatch {
  chunks: WriteChunkInput[];
  bytes: number;
}

interface WriterSession {
  asset: AudioAssetRecord;
  appendedBytes: number;
  nextSequence: number;
  finished: boolean;
}

export class AudioCacheWriter {
  private readonly sessions = new Map<string, WriterSession>();
  private pending = new Map<string, PendingBatch>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: AudioDb,
    private readonly options: CacheWriteOptions,
  ) {}

  /**
   * Begin caching a synthesized line. Any prior state for the same cacheKey
   * (e.g. an aborted earlier attempt) is discarded so chunk sequences always
   * start clean at 0.
   */
  async startAsset(cacheKey: string, lineId: string, meta: StartAssetMeta): Promise<void> {
    const now = Date.now();
    const asset: AudioAssetRecord = {
      cacheKey,
      lineId,
      status: "streaming",
      encoding: meta.encoding,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
      bitDepth: meta.bitDepth,
      chunkCount: 0,
      totalBytes: 0,
      sampleCount: 0,
      durationMs: 0,
      createdAt: now,
      lastAccessedAt: now,
      scopeAtCreation: meta.scopeAtCreation,
    };
    this.sessions.set(cacheKey, {
      asset,
      appendedBytes: 0,
      nextSequence: 0,
      finished: false,
    });
    await this.db.deleteAsset(cacheKey);
    await this.db.putAsset(asset);
  }

  /**
   * Accumulate one PCM chunk into the batch buffer. Synchronous and
   * fire-and-forget — the playback path NEVER awaits this.
   */
  append(cacheKey: string, chunk: Uint8Array): void {
    const session = this.sessions.get(cacheKey);
    if (!session || session.finished || chunk.byteLength === 0) return;

    // Copy so the caller may reuse/detach its buffer; store exact bytes.
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    const data = copy.buffer as ArrayBuffer;

    let batch = this.pending.get(cacheKey);
    if (!batch) {
      batch = { chunks: [], bytes: 0 };
      this.pending.set(cacheKey, batch);
    }
    batch.chunks.push({ sequence: session.nextSequence, data });
    batch.bytes += data.byteLength;

    session.nextSequence += 1;
    session.appendedBytes += data.byteLength;
    session.asset.chunkCount = session.nextSequence;
    session.asset.totalBytes = session.appendedBytes;
    session.asset.sampleCount = Math.floor(session.appendedBytes / 2);
    session.asset.durationMs = Math.floor(
      (session.asset.sampleCount / session.asset.sampleRate) * 1000,
    );
    session.asset.lastAccessedAt = Date.now();

    if (batch.bytes >= this.options.writeBatchBytes) {
      this.cancelFlushTimer();
      void this.flush().catch(() => {
        /* cache write failure is non-fatal */
      });
    } else {
      this.scheduleFlushTimer();
    }
  }

  /**
   * Two-phase completion: mark the asset `complete` when the chunk sequence is
   * contiguous and the stored bytes match the appended bytes; otherwise mark
   * it `partial` (§11.5). The caller invokes this only after the HTTP stream
   * ended normally.
   */
  async finishComplete(cacheKey: string): Promise<void> {
    await this.flush();
    const session = this.sessions.get(cacheKey);
    if (!session || session.finished) return;

    const asset = await this.db.getAsset(cacheKey);
    if (!asset || asset.status !== "streaming") return;

    const storedChunkCount = await this.db.countChunks(cacheKey);
    const contiguous = storedChunkCount === session.nextSequence;
    const bytesMatch = asset.totalBytes === session.appendedBytes;

    session.finished = true;
    try {
      if (contiguous && bytesMatch) {
        await this.db.updateAsset(cacheKey, {
          status: "complete",
          completedAt: Date.now(),
          chunkCount: session.nextSequence,
          totalBytes: session.appendedBytes,
          sampleCount: session.asset.sampleCount,
          durationMs: session.asset.durationMs,
        });
      } else {
        await this.db.updateAsset(cacheKey, { status: "partial" });
      }
    } finally {
      this.sessions.delete(cacheKey);
    }
  }

  /** Interrupted stream → `partial`. Never downgrades a completed asset. */
  markPartial(cacheKey: string): Promise<void> {
    return this.markTerminal(cacheKey, "partial");
  }

  /** Failed stream → `failed`. Never downgrades a completed asset. */
  markFailed(cacheKey: string): Promise<void> {
    return this.markTerminal(cacheKey, "failed");
  }

  /** Force-persist the pending batch now. */
  async flush(): Promise<void> {
    this.cancelFlushTimer();
    const pending = this.pending;
    this.pending = new Map();
    if (pending.size === 0) return;

    for (const [cacheKey, batch] of pending) {
      const session = this.sessions.get(cacheKey);
      if (!session || batch.chunks.length === 0) continue;
      try {
        await this.db.writeChunkBatch(cacheKey, batch.chunks, session.asset);
      } catch (error) {
        // Non-fatal by design: a failed cache write must never break playback.
        console.warn(`[audio-cache] flush failed for ${cacheKey}`, error);
      }
    }
  }

  private async markTerminal(
    cacheKey: string,
    status: "partial" | "failed",
  ): Promise<void> {
    await this.flush();
    const session = this.sessions.get(cacheKey);
    if (!session || session.finished) return;

    const asset = await this.db.getAsset(cacheKey);
    if (!asset || asset.status === "complete") return;

    session.finished = true;
    try {
      await this.db.updateAsset(cacheKey, { status });
    } finally {
      this.sessions.delete(cacheKey);
    }
  }

  private scheduleFlushTimer(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => {
        /* cache write failure is non-fatal */
      });
    }, this.options.flushIntervalMs);
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
