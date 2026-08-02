/**
 * AudioCacheCleaner tests: expired partial and abandoned streaming
 * reclamation, candidate TTL, LRU eviction to the cleanup target, and
 * current-session preservation (§11.7). Runs against fake-indexeddb in the
 * node environment.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { AudioDb } from "./audio-db.js";
import { AudioCacheCleaner, type CleanerOptions } from "./audio-cache-cleaner.js";
import { resetDb, makeAsset } from "./test-utils.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;

const BASE_OPTIONS: CleanerOptions = {
  maxBytes: 1_000_000_000,
  cleanupTargetBytes: 500_000_000,
  partialTtlMinutes: 10,
  candidateTtlHours: 1,
};

describe("AudioCacheCleaner", () => {
  let db: AudioDb;

  beforeEach(async () => {
    db?.close();
    db = new AudioDb();
    await resetDb(db);
  });

  it("removes expired partial assets and frees their bytes", async () => {
    const cleaner = new AudioCacheCleaner(db, BASE_OPTIONS);
    await db.putAsset(
      makeAsset("old-partial", {
        status: "partial",
        totalBytes: 100,
        lastAccessedAt: Date.now() - 11 * MINUTE,
      }),
    );
    await db.putAsset(
      makeAsset("fresh-partial", {
        status: "partial",
        totalBytes: 50,
        lastAccessedAt: Date.now() - 1 * MINUTE,
      }),
    );

    const report = await cleaner.run();

    expect(report.removed).toBe(1);
    expect(report.freedBytes).toBe(100);
    expect(await db.getAsset("old-partial")).toBeUndefined();
    expect(await db.getAsset("fresh-partial")).toBeDefined();
  });

  it("reclaims abandoned streaming assets and frees their chunks", async () => {
    const cleaner = new AudioCacheCleaner(db, BASE_OPTIONS);
    await db.putAsset(
      makeAsset("abandoned-stream", {
        status: "streaming",
        totalBytes: 60,
        lastAccessedAt: Date.now() - 11 * MINUTE, // older than partialTtlMinutes
      }),
    );
    await db.putChunk("abandoned-stream", 0, new Uint8Array([1, 2]).buffer);
    await db.putAsset(
      makeAsset("fresh-stream", {
        status: "streaming",
        totalBytes: 40,
        lastAccessedAt: Date.now() - 1 * MINUTE, // actively streaming
      }),
    );

    const report = await cleaner.run();

    expect(report.removed).toBe(1);
    expect(report.freedBytes).toBe(60);
    expect(await db.getAsset("abandoned-stream")).toBeUndefined();
    expect(await db.countChunks("abandoned-stream")).toBe(0); // chunks cascade
    expect(await db.getAsset("fresh-stream")).toBeDefined();
  });

  it("never deletes abandoned streaming assets referenced by the current session", async () => {
    const cleaner = new AudioCacheCleaner(db, BASE_OPTIONS);
    await db.putAsset(
      makeAsset("active-stream", {
        status: "streaming",
        totalBytes: 100,
        lastAccessedAt: 1, // would be reclaimed by the streaming TTL
      }),
    );
    await db.putAsset(
      makeAsset("inactive-stream", {
        status: "streaming",
        totalBytes: 100,
        lastAccessedAt: 1,
      }),
    );

    const report = await cleaner.run(new Set(["active-stream"]));

    expect(report.removed).toBe(1);
    expect(await db.getAsset("active-stream")).toBeDefined();
    expect(await db.getAsset("inactive-stream")).toBeUndefined();
  });

  it("removes expired candidate-scope assets", async () => {
    const cleaner = new AudioCacheCleaner(db, BASE_OPTIONS);
    await db.putAsset(
      makeAsset("old-candidate", {
        status: "complete",
        scopeAtCreation: "candidate",
        totalBytes: 80,
        createdAt: Date.now() - 2 * HOUR,
      }),
    );
    await db.putAsset(
      makeAsset("fresh-candidate", {
        status: "complete",
        scopeAtCreation: "candidate",
        totalBytes: 80,
        createdAt: Date.now() - 1 * MINUTE,
      }),
    );

    const report = await cleaner.run();

    expect(report.removed).toBe(1);
    expect(await db.getAsset("old-candidate")).toBeUndefined();
    expect(await db.getAsset("fresh-candidate")).toBeDefined();
  });

  it("evicts least-recently-accessed complete assets down to the cleanup target", async () => {
    const cleaner = new AudioCacheCleaner(db, {
      ...BASE_OPTIONS,
      maxBytes: 250,
      cleanupTargetBytes: 150,
    });
    await db.putAsset(
      makeAsset("oldest", { status: "complete", totalBytes: 100, lastAccessedAt: 1_000 }),
    );
    await db.putAsset(
      makeAsset("middle", { status: "complete", totalBytes: 100, lastAccessedAt: 2_000 }),
    );
    await db.putAsset(
      makeAsset("newest", { status: "complete", totalBytes: 100, lastAccessedAt: 3_000 }),
    );

    const report = await cleaner.run();

    // total 300 > maxBytes 250 → evict oldest first until ≤ 150.
    expect(report.removed).toBe(2);
    expect(report.freedBytes).toBe(200);
    expect(await db.getAsset("oldest")).toBeUndefined();
    expect(await db.getAsset("middle")).toBeUndefined();
    expect(await db.getAsset("newest")).toBeDefined();
  });

  it("leaves the cache alone when it is under maxBytes and has no expired entries", async () => {
    const cleaner = new AudioCacheCleaner(db, BASE_OPTIONS);
    await db.putAsset(
      makeAsset("fresh-complete", {
        status: "complete",
        totalBytes: 10,
        lastAccessedAt: Date.now(),
      }),
    );

    const report = await cleaner.run();

    expect(report.removed).toBe(0);
    expect(report.freedBytes).toBe(0);
    expect(await db.getAsset("fresh-complete")).toBeDefined();
  });

  it("never deletes assets referenced by the current session", async () => {
    const cleaner = new AudioCacheCleaner(db, {
      ...BASE_OPTIONS,
      maxBytes: 10,
      cleanupTargetBytes: 0,
    });
    await db.putAsset(
      makeAsset("active-old", { status: "complete", totalBytes: 100, lastAccessedAt: 1 }),
    );
    await db.putAsset(
      makeAsset("active-partial", {
        status: "partial",
        totalBytes: 100,
        lastAccessedAt: 1, // would be expired by TTL
      }),
    );

    const report = await cleaner.run(new Set(["active-old", "active-partial"]));

    expect(report.removed).toBe(0);
    expect(await db.getAsset("active-old")).toBeDefined();
    expect(await db.getAsset("active-partial")).toBeDefined();
  });

  it("evicts inactive complete assets before the current session's assets", async () => {
    const cleaner = new AudioCacheCleaner(db, {
      ...BASE_OPTIONS,
      maxBytes: 150,
      cleanupTargetBytes: 100,
    });
    await db.putAsset(
      makeAsset("active", { status: "complete", totalBytes: 100, lastAccessedAt: 1 }),
    );
    await db.putAsset(
      makeAsset("inactive", { status: "complete", totalBytes: 100, lastAccessedAt: 2 }),
    );

    const report = await cleaner.run(new Set(["active"]));

    expect(report.removed).toBe(1);
    expect(await db.getAsset("inactive")).toBeUndefined();
    expect(await db.getAsset("active")).toBeDefined();
  });
});
