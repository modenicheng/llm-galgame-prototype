/**
 * AudioCacheWriter tests: batching + flush thresholds, two-phase completion,
 * interruption handling, and the fire-and-forget playback path (§22
 * invariant 13). Runs against fake-indexeddb in the node environment.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AudioDb } from "./audio-db.js";
import { AudioCacheWriter, type StartAssetMeta } from "./audio-cache-writer.js";
import { resetDb, deleteChunkRaw } from "./test-utils.js";

const META: StartAssetMeta = {
  encoding: "pcm_s16le",
  sampleRate: 22050,
  channels: 1,
  bitDepth: 16,
  scopeAtCreation: "active",
};

describe("AudioCacheWriter", () => {
  let db: AudioDb;

  beforeEach(async () => {
    db?.close();
    db = new AudioDb();
    await resetDb(db);
  });

  it("startAsset creates a streaming asset and wipes prior state for the key", async () => {
    const writer = new AudioCacheWriter(db, { writeBatchBytes: 1_000, flushIntervalMs: 300 });
    await writer.startAsset("k1", "line-1", META);
    await writer.startAsset("k2", "line-2", { ...META, scopeAtCreation: "candidate" });

    const a1 = await db.getAsset("k1");
    expect(a1?.status).toBe("streaming");
    expect(a1?.lineId).toBe("line-1");
    expect(a1?.chunkCount).toBe(0);
    expect(a1?.totalBytes).toBe(0);
    const a2 = await db.getAsset("k2");
    expect(a2?.scopeAtCreation).toBe("candidate");
  });

  it("append batches and flushes when the byte threshold is reached", async () => {
    const writer = new AudioCacheWriter(db, { writeBatchBytes: 8, flushIntervalMs: 300 });
    await writer.startAsset("k1", "line-1", META);

    writer.append("k1", new Uint8Array([1, 2, 3, 4]));
    expect(await db.countChunks("k1")).toBe(0); // below threshold: nothing persisted

    writer.append("k1", new Uint8Array([5, 6, 7, 8])); // hits 8 bytes → batch flush
    await vi.waitFor(async () => {
      expect(await db.countChunks("k1")).toBe(2);
    });

    const asset = await db.getAsset("k1");
    expect(asset?.chunkCount).toBe(2);
    expect(asset?.totalBytes).toBe(8);
    expect(asset?.sampleCount).toBe(4);
  });

  it("flushes when the flush interval elapses", async () => {
    const writer = new AudioCacheWriter(db, { writeBatchBytes: 1_000_000, flushIntervalMs: 300 });
    await writer.startAsset("k1", "line-1", META);

    writer.append("k1", new Uint8Array([1, 2, 3]));
    expect(await db.countChunks("k1")).toBe(0); // below threshold, nothing yet

    await vi.waitFor(
      async () => {
        expect(await db.countChunks("k1")).toBe(1);
      },
      { timeout: 2_000 },
    );
  });

  it("flush() force-persists the pending batch", async () => {
    const writer = new AudioCacheWriter(db, { writeBatchBytes: 1_000_000, flushIntervalMs: 300 });
    await writer.startAsset("k1", "line-1", META);

    writer.append("k1", new Uint8Array([1, 2]));
    expect(await db.countChunks("k1")).toBe(0);

    await writer.flush();
    expect(await db.countChunks("k1")).toBe(1);
  });

  it("finishComplete is not fooled by an in-flight threshold flush", async () => {
    const writer = new AudioCacheWriter(db, { writeBatchBytes: 8, flushIntervalMs: 300 });
    await writer.startAsset("k1", "line-1", META);

    writer.append("k1", new Uint8Array([1, 2, 3, 4]));
    writer.append("k1", new Uint8Array([5, 6, 7, 8])); // hits threshold → fire-and-forget flush
    await writer.finishComplete("k1"); // must wait for that flush, not race past it

    expect((await db.getAsset("k1"))?.status).toBe("complete");
  });

  it("finishComplete marks complete when chunks are contiguous and bytes match", async () => {
    const writer = new AudioCacheWriter(db, { writeBatchBytes: 1_000_000, flushIntervalMs: 300 });
    await writer.startAsset("k1", "line-1", META);

    writer.append("k1", new Uint8Array([1, 2, 3, 4]));
    writer.append("k1", new Uint8Array([5, 6]));
    await writer.finishComplete("k1");

    const asset = await db.getAsset("k1");
    expect(asset?.status).toBe("complete");
    expect(asset?.completedAt).toBeDefined();
    expect(asset?.chunkCount).toBe(2);
    expect(asset?.totalBytes).toBe(6);
    expect(asset?.sampleCount).toBe(3);
    expect(asset?.durationMs).toBe(Math.floor((3 / 22050) * 1000));
  });

  it("finishComplete marks partial when the chunk sequence has a gap", async () => {
    const writer = new AudioCacheWriter(db, { writeBatchBytes: 8, flushIntervalMs: 300 });
    await writer.startAsset("k1", "line-1", META);

    writer.append("k1", new Uint8Array([1, 2, 3, 4]));
    writer.append("k1", new Uint8Array([5, 6, 7, 8]));
    await writer.flush();
    await deleteChunkRaw("k1", 0); // break contiguity behind the writer's back

    await writer.finishComplete("k1");
    expect((await db.getAsset("k1"))?.status).toBe("partial");
  });

  it("markPartial marks an interrupted stream partial", async () => {
    const writer = new AudioCacheWriter(db, { writeBatchBytes: 1_000_000, flushIntervalMs: 300 });
    await writer.startAsset("k1", "line-1", META);

    writer.append("k1", new Uint8Array([1, 2, 3, 4]));
    await writer.markPartial("k1");

    const asset = await db.getAsset("k1");
    expect(asset?.status).toBe("partial");
    expect(asset?.completedAt).toBeUndefined();
  });

  it("markFailed marks a failed stream failed", async () => {
    const writer = new AudioCacheWriter(db, { writeBatchBytes: 1_000_000, flushIntervalMs: 300 });
    await writer.startAsset("k1", "line-1", META);

    writer.append("k1", new Uint8Array([1, 2]));
    await writer.markFailed("k1");

    expect((await db.getAsset("k1"))?.status).toBe("failed");
  });

  it("append is synchronous and never blocks the playback path", async () => {
    const writer = new AudioCacheWriter(db, { writeBatchBytes: 1_000_000, flushIntervalMs: 300 });
    await writer.startAsset("k1", "line-1", META);

    const returned = writer.append("k1", new Uint8Array([1, 2, 3, 4]));
    expect(returned).toBeUndefined(); // no promise handed back to the caller
    expect(await db.countChunks("k1")).toBe(0); // nothing written synchronously

    await vi.waitFor(async () => {
      expect(await db.countChunks("k1")).toBe(1); // interval flush lands it later
    });
  });

  it("appends after the stream ended are dropped", async () => {
    const writer = new AudioCacheWriter(db, { writeBatchBytes: 1_000_000, flushIntervalMs: 300 });
    await writer.startAsset("k1", "line-1", META);

    writer.append("k1", new Uint8Array([1, 2]));
    await writer.finishComplete("k1");

    writer.append("k1", new Uint8Array([3, 4]));
    await writer.flush();
    expect(await db.countChunks("k1")).toBe(1);
    expect((await db.getAsset("k1"))?.totalBytes).toBe(2);
  });
});
