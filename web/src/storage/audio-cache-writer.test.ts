/**
 * AudioCacheWriter tests: batching + flush thresholds, two-phase completion,
 * interruption handling, key-restart-during-flush isolation, and the
 * fire-and-forget playback path (§22 invariant 13). Runs against
 * fake-indexeddb in the node environment.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AudioDb, type AudioAssetRecord, type WriteChunkInput } from "./audio-db.js";
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

  it("restarting a key during an in-flight flush never writes the stale batch into the new session", async () => {
    const writer = new AudioCacheWriter(db, {
      writeBatchBytes: 1_000_000,
      flushIntervalMs: 30_000,
    });
    await writer.startAsset("k1", "line-1", META);
    await writer.startAsset("k2", "line-2", META);
    writer.append("k1", new Uint8Array([1, 2])); // k1: seq 0
    writer.append("k2", new Uint8Array([3, 4])); // k2 (old session): seq 0
    writer.append("k2", new Uint8Array([5, 6])); // k2 (old session): seq 1
    writer.append("k2", new Uint8Array([7, 8])); // k2 (old session): seq 2

    // Gate k1's write so the flush loop parks inside its await; k2's job is
    // only processed after we restart k2.
    let releaseK1!: () => void;
    const k1Gate = new Promise<void>((resolve) => {
      releaseK1 = resolve;
    });
    const realWrite = db.writeChunkBatch.bind(db);
    const writeSpy = vi.spyOn(db, "writeChunkBatch").mockImplementation(
      async (cacheKey: string, chunks: WriteChunkInput[], asset: AudioAssetRecord) => {
        if (cacheKey === "k1") await k1Gate;
        return realWrite(cacheKey, chunks, asset);
      },
    );

    const flushPromise = writer.flush();
    await vi.waitFor(() => {
      expect(writeSpy.mock.calls.some(([cacheKey]) => cacheKey === "k1")).toBe(true);
    });

    // Restart k2 while k1's write is still in flight: startAsset cascade-wipes
    // k2 and installs a fresh session; the new stream appends its own chunk.
    await writer.startAsset("k2", "line-2b", META);
    writer.append("k2", new Uint8Array([9, 9])); // new session: seq 0

    releaseK1();
    await flushPromise;

    // finishComplete for the new session sees only its own chunk: no stale
    // sequences remain to make the count-based contiguity check spuriously
    // mark the fully-streamed line partial.
    await writer.finishComplete("k2");
    const asset = await db.getAsset("k2");
    expect(asset?.status).toBe("complete");
    expect(asset?.lineId).toBe("line-2b");
    expect(asset?.chunkCount).toBe(1);
    expect(asset?.totalBytes).toBe(2);
    const chunks = await db.getChunks("k2", 0, 10);
    expect(chunks.map((c) => Array.from(new Uint8Array(c.data)))).toEqual([[9, 9]]);

    // The old batch was captured under the pre-restart session, which
    // startAsset wiped: the flush must not write it — its sequences would
    // pollute the new session's space and finishComplete would over-count.
    const k2Writes = writeSpy.mock.calls.filter(([cacheKey]) => cacheKey === "k2");
    expect(k2Writes).toHaveLength(1); // only finishComplete's flush of the new chunk
    expect(k2Writes[0]![1].every((chunk) => chunk.sequence === 0)).toBe(true);
    expect(k2Writes[0]![2].lineId).toBe("line-2b");
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
