/**
 * AudioDb tests: schema creation, CRUD roundtrips, and the deleteAsset
 * cascade. Runs against fake-indexeddb in the node environment.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { AudioDb, type AudioAssetRecord } from "./audio-db.js";
import { resetDb, makeAsset } from "./test-utils.js";

describe("AudioDb", () => {
  let db: AudioDb;

  beforeEach(async () => {
    db?.close();
    db = new AudioDb();
    await resetDb(db);
  });

  it("creates the three object stores on upgrade", async () => {
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(AudioDb.DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const names = [...raw.objectStoreNames].sort();
    expect(names).toEqual([AudioDb.ASSETS, AudioDb.CHUNKS, AudioDb.META].sort());
    raw.close();
  });

  it("putAsset/getAsset roundtrips a record, missing key returns undefined", async () => {
    const asset = makeAsset("k1", {
      status: "complete",
      completedAt: 2_000,
      chunkCount: 3,
      totalBytes: 600,
      sampleCount: 300,
      durationMs: 13,
    });
    await db.putAsset(asset);
    expect(await db.getAsset("k1")).toEqual(asset);
    expect(await db.getAsset("missing")).toBeUndefined();
  });

  it("updateAsset merges a patch and preserves untouched fields", async () => {
    await db.putAsset(makeAsset("k1"));
    await db.updateAsset("k1", {
      status: "complete",
      completedAt: 5_000,
      totalBytes: 100,
      chunkCount: 1,
      sampleCount: 50,
      durationMs: 2,
    });
    const got = await db.getAsset("k1");
    expect(got?.status).toBe("complete");
    expect(got?.completedAt).toBe(5_000);
    expect(got?.totalBytes).toBe(100);
    expect(got?.chunkCount).toBe(1);
    expect(got?.lineId).toBe("line-k1");
  });

  it("updateAsset is a no-op for an unknown key", async () => {
    await expect(db.updateAsset("nope", { status: "failed" })).resolves.toBeUndefined();
    expect(await db.getAsset("nope")).toBeUndefined();
  });

  it("putChunk/getChunks/countChunks roundtrip ordered slices", async () => {
    await db.putChunk("k1", 0, new Uint8Array([1, 2]).buffer);
    await db.putChunk("k1", 1, new Uint8Array([3, 4]).buffer);
    await db.putChunk("k1", 5, new Uint8Array([9, 9]).buffer); // gap at 2..4

    const got = await db.getChunks("k1", 0, 2);
    expect(got.map((c) => c.sequence)).toEqual([0, 1]);
    expect([...new Uint8Array(got[0]!.data)]).toEqual([1, 2]);
    expect([...new Uint8Array(got[1]!.data)]).toEqual([3, 4]);
    expect(await db.countChunks("k1")).toBe(3);
    expect(await db.countChunks("unknown")).toBe(0);
  });

  it("getChunks starts at the requested sequence and respects the count", async () => {
    await db.putChunk("k1", 0, new Uint8Array([1]).buffer);
    await db.putChunk("k1", 1, new Uint8Array([2]).buffer);
    await db.putChunk("k1", 2, new Uint8Array([3]).buffer);
    const got = await db.getChunks("k1", 1, 1);
    expect(got.map((c) => c.sequence)).toEqual([1]);
  });

  it("deleteAsset removes the asset and cascades to its chunks only", async () => {
    await db.putAsset(makeAsset("k1"));
    await db.putAsset(makeAsset("k2"));
    await db.putChunk("k1", 0, new Uint8Array([1]).buffer);
    await db.putChunk("k1", 1, new Uint8Array([2]).buffer);
    await db.putChunk("k2", 0, new Uint8Array([3]).buffer);

    await db.deleteAsset("k1");

    expect(await db.getAsset("k1")).toBeUndefined();
    expect(await db.countChunks("k1")).toBe(0);
    expect(await db.getAsset("k2")).toBeDefined();
    expect(await db.countChunks("k2")).toBe(1);
  });

  it("listAssets returns every asset record", async () => {
    await db.putAsset(makeAsset("a"));
    await db.putAsset(makeAsset("b", { status: "complete" }));
    const keys = (await db.listAssets()).map((a) => a.cacheKey).sort();
    expect(keys).toEqual(["a", "b"]);
  });

  it("reports unsupported when indexedDB is absent", async () => {
    const saved = globalThis.indexedDB;
    Reflect.deleteProperty(globalThis, "indexedDB");
    try {
      const unsupported = new AudioDb();
      expect(unsupported.isSupported()).toBe(false);
      await unsupported.open();
      await unsupported.putAsset(makeAsset("k1"));
      expect(await unsupported.getAsset("k1")).toBeUndefined();
      expect(await unsupported.countChunks("k1")).toBe(0);
      expect(await unsupported.listAssets()).toEqual([]);
    } finally {
      Reflect.set(globalThis, "indexedDB", saved);
    }
  });
});
