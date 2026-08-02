/**
 * Shared helpers for the storage test suites. Tests run against
 * fake-indexeddb in the node environment; every suite resets the database
 * between tests (deleteDatabase + reopen) so suites are independent.
 */
import type { AudioAssetRecord } from "./audio-db.js";
import { AudioDb } from "./audio-db.js";

/** Reset the database: close the connection, delete, reopen fresh. */
export async function resetDb(db: AudioDb): Promise<void> {
  db.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(AudioDb.DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("deleteDatabase blocked by an open connection"));
  });
  await db.open();
}

/** Build a minimal valid asset record; `overrides` wins over defaults. */
export function makeAsset(
  cacheKey: string,
  overrides: Partial<AudioAssetRecord> = {},
): AudioAssetRecord {
  const base: AudioAssetRecord = {
    cacheKey,
    lineId: `line-${cacheKey}`,
    status: "streaming",
    encoding: "pcm_s16le",
    sampleRate: 22050,
    channels: 1,
    bitDepth: 16,
    chunkCount: 0,
    totalBytes: 0,
    sampleCount: 0,
    durationMs: 0,
    createdAt: 1_000,
    lastAccessedAt: 1_000,
    scopeAtCreation: "active",
  };
  return { ...base, ...overrides } as AudioAssetRecord;
}
/** Delete one chunk record directly (bypasses AudioDb) — used to simulate gaps. */
export async function deleteChunkRaw(cacheKey: string, sequence: number): Promise<void> {
  const open = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(AudioDb.DB_NAME);
  request.onsuccess = () => open.resolve(request.result);
  request.onerror = () => open.reject(request.error);
  const database = await open.promise;

  const deleted = Promise.withResolvers<void>();
  const tx = database.transaction(AudioDb.CHUNKS, "readwrite");
  tx.objectStore(AudioDb.CHUNKS).delete([cacheKey, sequence]);
  tx.oncomplete = () => deleted.resolve();
  tx.onerror = () => deleted.reject(tx.error);
  await deleted.promise;
  database.close();
}
