/**
 * AudioDb — the browser's IndexedDB audio performance cache (V2 §11.3).
 *
 * A performance cache only: nothing here is story truth, and deleting the
 * whole database only costs re-synthesis of audio. Three object stores:
 *
 *   - audio_assets  (keyPath `cacheKey`)       — one record per synthesized line
 *   - audio_chunks  (keyPath [cacheKey, sequence]) — PCM chunk records
 *   - cache_meta    (explicit keys)            — reserved for cache-level metadata
 *
 * Only assets with status `complete` are cross-page readable (§22 invariant 14).
 * Environments without IndexedDB degrade gracefully: `isSupported()` returns
 * false and every operation resolves without touching a database.
 */

export interface AudioAssetRecord {
  cacheKey: string;
  lineId: string;

  status: "streaming" | "complete" | "partial" | "failed" | "corrupt";

  encoding: "pcm_s16le";
  sampleRate: number;
  channels: 1;
  bitDepth: 16;

  chunkCount: number;
  totalBytes: number;
  sampleCount: number;
  durationMs: number;

  createdAt: number;
  completedAt?: number;
  lastAccessedAt: number;

  scopeAtCreation: "active" | "candidate" | "input_preview";
}

export interface AudioChunkRecord {
  cacheKey: string;
  sequence: number;
  data: ArrayBuffer;
  byteLength: number;
}

export interface WriteChunkInput {
  sequence: number;
  data: ArrayBuffer;
}

export class AudioDb {
  static readonly DB_NAME = "llm-galgame-audio-v2";
  static readonly ASSETS = "audio_assets";
  static readonly CHUNKS = "audio_chunks";
  static readonly META = "cache_meta";

  private db: IDBDatabase | null = null;
  private available = false;

  /** True when IndexedDB exists in this environment (browser, or fake-indexeddb in tests). */
  isSupported(): boolean {
    return typeof indexedDB !== "undefined";
  }

  /**
   * Open (and on first run, create) the database. Resolves without creating
   * anything when IndexedDB is unavailable; every operation then no-ops.
   */
  open(): Promise<void> {
    if (!this.isSupported()) {
      this.available = false;
      return Promise.resolve();
    }
    if (this.db) return Promise.resolve();

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const request = indexedDB.open(AudioDb.DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(AudioDb.ASSETS)) {
        database.createObjectStore(AudioDb.ASSETS, { keyPath: "cacheKey" });
      }
      if (!database.objectStoreNames.contains(AudioDb.CHUNKS)) {
        database.createObjectStore(AudioDb.CHUNKS, {
          keyPath: ["cacheKey", "sequence"],
        });
      }
      if (!database.objectStoreNames.contains(AudioDb.META)) {
        database.createObjectStore(AudioDb.META);
      }
    };
    request.onsuccess = () => {
      this.db = request.result;
      this.available = true;
      resolve();
    };
    request.onerror = () => reject(request.error);
    return promise;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.available = false;
  }

  putAsset(record: AudioAssetRecord): Promise<void> {
    if (!this.available || !this.db) return Promise.resolve();
    const db = this.db;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const tx = db.transaction([AudioDb.ASSETS], "readwrite");
    tx.objectStore(AudioDb.ASSETS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    return promise;
  }

  getAsset(cacheKey: string): Promise<AudioAssetRecord | undefined> {
    if (!this.available || !this.db) return Promise.resolve(undefined);
    const db = this.db;
    const { promise, resolve, reject } = Promise.withResolvers<AudioAssetRecord | undefined>();
    const tx = db.transaction([AudioDb.ASSETS], "readonly");
    const request = tx.objectStore(AudioDb.ASSETS).get(cacheKey);
    request.onsuccess = () => resolve(request.result as AudioAssetRecord | undefined);
    request.onerror = () => reject(request.error);
    return promise;
  }

  putChunk(cacheKey: string, sequence: number, data: ArrayBuffer): Promise<void> {
    if (!this.available || !this.db) return Promise.resolve();
    const db = this.db;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const tx = db.transaction([AudioDb.CHUNKS], "readwrite");
    tx.objectStore(AudioDb.CHUNKS).put({
      cacheKey,
      sequence,
      data,
      byteLength: data.byteLength,
    } satisfies AudioChunkRecord);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    return promise;
  }

  /**
   * Write a batch of chunks plus the refreshed asset record in ONE
   * transaction — the BatchWriter flush path (§11.4/§11.5). Either the whole
   * batch lands or none of it does.
   */
  writeChunkBatch(
    cacheKey: string,
    chunks: WriteChunkInput[],
    asset: AudioAssetRecord,
  ): Promise<void> {
    if (!this.available || !this.db) return Promise.resolve();
    const db = this.db;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const tx = db.transaction([AudioDb.ASSETS, AudioDb.CHUNKS], "readwrite");
    tx.objectStore(AudioDb.ASSETS).put(asset);
    const chunkStore = tx.objectStore(AudioDb.CHUNKS);
    for (const chunk of chunks) {
      chunkStore.put({
        cacheKey,
        sequence: chunk.sequence,
        data: chunk.data,
        byteLength: chunk.data.byteLength,
      } satisfies AudioChunkRecord);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    return promise;
  }

  /** Read up to `count` chunks starting at `from`, in ascending sequence order. */
  getChunks(
    cacheKey: string,
    from: number,
    count: number,
  ): Promise<Array<{ sequence: number; data: ArrayBuffer }>> {
    if (!this.available || !this.db) return Promise.resolve([]);
    const db = this.db;
    const { promise, resolve, reject } = Promise.withResolvers<
      Array<{ sequence: number; data: ArrayBuffer }>
    >();
    const tx = db.transaction([AudioDb.CHUNKS], "readonly");
    const range = IDBKeyRange.bound([cacheKey, from], [cacheKey, Infinity]);
    const request = tx.objectStore(AudioDb.CHUNKS).getAll(range, count);
    request.onsuccess = () => {
      const rows = request.result as AudioChunkRecord[];
      resolve(rows.map((row) => ({ sequence: row.sequence, data: row.data })));
    };
    request.onerror = () => reject(request.error);
    return promise;
  }

  countChunks(cacheKey: string): Promise<number> {
    if (!this.available || !this.db) return Promise.resolve(0);
    const db = this.db;
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const tx = db.transaction([AudioDb.CHUNKS], "readonly");
    const range = IDBKeyRange.bound([cacheKey, -Infinity], [cacheKey, Infinity]);
    const request = tx.objectStore(AudioDb.CHUNKS).count(range);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    return promise;
  }

  /** Remove an asset record and ALL of its chunks (cascade, one transaction). */
  deleteAsset(cacheKey: string): Promise<void> {
    if (!this.available || !this.db) return Promise.resolve();
    const db = this.db;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const tx = db.transaction([AudioDb.ASSETS, AudioDb.CHUNKS], "readwrite");
    tx.objectStore(AudioDb.ASSETS).delete(cacheKey);
    const range = IDBKeyRange.bound([cacheKey, -Infinity], [cacheKey, Infinity]);
    tx.objectStore(AudioDb.CHUNKS).delete(range);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    return promise;
  }

  listAssets(): Promise<AudioAssetRecord[]> {
    if (!this.available || !this.db) return Promise.resolve([]);
    const db = this.db;
    const { promise, resolve, reject } = Promise.withResolvers<AudioAssetRecord[]>();
    const tx = db.transaction([AudioDb.ASSETS], "readonly");
    const request = tx.objectStore(AudioDb.ASSETS).getAll();
    request.onsuccess = () => resolve(request.result as AudioAssetRecord[]);
    request.onerror = () => reject(request.error);
    return promise;
  }

  /**
   * Merge `patch` into the stored asset record. Unknown keys are a no-op.
   * `completedAt` is only ever written when explicitly supplied.
   */
  updateAsset(cacheKey: string, patch: Partial<AudioAssetRecord>): Promise<void> {
    if (!this.available || !this.db) return Promise.resolve();
    const db = this.db;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const tx = db.transaction([AudioDb.ASSETS], "readwrite");
    const store = tx.objectStore(AudioDb.ASSETS);
    const getRequest = store.get(cacheKey);
    getRequest.onsuccess = () => {
      const existing = getRequest.result as AudioAssetRecord | undefined;
      if (!existing) return;
      store.put({
        cacheKey: existing.cacheKey,
        lineId: patch.lineId ?? existing.lineId,
        status: patch.status ?? existing.status,
        encoding: patch.encoding ?? existing.encoding,
        sampleRate: patch.sampleRate ?? existing.sampleRate,
        channels: patch.channels ?? existing.channels,
        bitDepth: patch.bitDepth ?? existing.bitDepth,
        chunkCount: patch.chunkCount ?? existing.chunkCount,
        totalBytes: patch.totalBytes ?? existing.totalBytes,
        sampleCount: patch.sampleCount ?? existing.sampleCount,
        durationMs: patch.durationMs ?? existing.durationMs,
        createdAt: patch.createdAt ?? existing.createdAt,
        lastAccessedAt: patch.lastAccessedAt ?? existing.lastAccessedAt,
        scopeAtCreation: patch.scopeAtCreation ?? existing.scopeAtCreation,
        ...(patch.completedAt !== undefined
          ? { completedAt: patch.completedAt }
          : existing.completedAt !== undefined
            ? { completedAt: existing.completedAt }
            : {}),
      });
    };
    getRequest.onerror = () => reject(getRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    return promise;
  }
}
