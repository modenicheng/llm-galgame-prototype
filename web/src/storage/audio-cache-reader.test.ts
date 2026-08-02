/**
 * AudioCacheReader tests: only `complete` assets are cross-page readable
 * (§22 invariant 14); reads yield chunks in sequence order without loading
 * the whole asset. Runs against fake-indexeddb in the node environment.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { AudioDb } from "./audio-db.js";
import { AudioCacheWriter, type StartAssetMeta } from "./audio-cache-writer.js";
import { AudioCacheReader } from "./audio-cache-reader.js";
import { resetDb } from "./test-utils.js";

const META: StartAssetMeta = {
  encoding: "pcm_s16le",
  sampleRate: 22050,
  channels: 1,
  bitDepth: 16,
  scopeAtCreation: "active",
};

async function collect(reader: AudioCacheReader, cacheKey: string): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of reader.readChunks(cacheKey)) out.push(chunk);
  return out;
}

describe("AudioCacheReader", () => {
  let db: AudioDb;
  let writer: AudioCacheWriter;
  let reader: AudioCacheReader;
  beforeEach(async () => {
    db?.close();
    db = new AudioDb();
    await resetDb(db);
    writer = new AudioCacheWriter(db, { writeBatchBytes: 1_000_000, flushIntervalMs: 300 });
    reader = new AudioCacheReader(db);
  });

  it("lookup reports complete with the asset record for a finished asset", async () => {
    await writer.startAsset("k1", "line-1", META);
    writer.append("k1", new Uint8Array([1, 2, 3, 4]));
    await writer.finishComplete("k1");

    const result = await reader.lookup("k1");
    expect(result.status).toBe("complete");
    expect(result.asset?.cacheKey).toBe("k1");
    expect(result.asset?.totalBytes).toBe(4);
  });

  it("lookup reports partial with the record for an interrupted asset", async () => {
    await writer.startAsset("k1", "line-1", META);
    writer.append("k1", new Uint8Array([1, 2, 3, 4]));
    await writer.markPartial("k1");

    const result = await reader.lookup("k1");
    expect(result.status).toBe("partial");
    expect(result.asset).toBeDefined();
  });

  it("lookup for an unknown key is not a complete hit and has no record", async () => {
    const result = await reader.lookup("nope");
    expect(result.status).not.toBe("complete");
    expect(result.asset).toBeUndefined();
  });

  it("readChunks yields a complete asset's chunks in sequence order", async () => {
    await writer.startAsset("k1", "line-1", META);
    writer.append("k1", new Uint8Array([1, 2, 3, 4]));
    writer.append("k1", new Uint8Array([5, 6, 7, 8]));
    await writer.finishComplete("k1");

    const out = await collect(reader, "k1");
    expect(out.length).toBe(2);
    expect([...out[0]!]).toEqual([1, 2, 3, 4]);
    expect([...out[1]!]).toEqual([5, 6, 7, 8]);
  });

  it("readChunks reads across batches without dropping or duplicating chunks", async () => {
    const batchSize = 16; // AudioCacheReader.READ_BATCH
    await writer.startAsset("k1", "line-1", META);
    for (let i = 0; i < batchSize + 3; i += 1) {
      writer.append("k1", new Uint8Array([i]));
    }
    await writer.finishComplete("k1");

    const out = await collect(reader, "k1");
    expect(out.length).toBe(batchSize + 3);
    expect(out.map((c) => c[0])).toEqual(
      Array.from({ length: batchSize + 3 }, (_, i) => i),
    );
  });

  it("readChunks yields nothing for a partial asset", async () => {
    await writer.startAsset("k1", "line-1", META);
    writer.append("k1", new Uint8Array([1, 2]));
    await writer.markPartial("k1");

    expect(await collect(reader, "k1")).toEqual([]);
  });

  it("readChunks yields nothing for an unknown key", async () => {
    expect(await collect(reader, "nope")).toEqual([]);
  });
});
