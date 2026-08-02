/**
 * Tests for AudioCatalogServiceImpl: upsert/get, invalidation events,
 * fetch-request validation (§22 invariant 10), priority changes, and
 * subscription lifecycle.
 */
import { describe, it, expect } from "vitest";
import { AudioCatalogServiceImpl } from "./audio-catalog-service.js";
import type { AudioDescriptor } from "../../shared/wire/audio-descriptor.js";
import type { InternalAudioRecipe } from "./internal-audio-recipe.js";
import type { AudioCatalogEvent } from "./audio-catalog-service.js";

function makeDescriptor(lineId: string, cacheKey = `key-${lineId}`): AudioDescriptor {
  return {
    lineId,
    cacheKey,
    scope: { type: "active" },
    priority: "current",
    speakerId: "suyao",
    displaySpeaker: "苏遥",
    format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
  };
}

function makeRecipe(lineId: string, cacheKey = `key-${lineId}`): InternalAudioRecipe {
  return {
    lineId,
    cacheKey,
    text: "你好",
    model: "cosyvoice-v2",
    voiceId: "voice-1",
    voiceRevision: 1,
    rate: 1,
    pitch: 1,
    volume: 1,
    pauseBeforeMs: 0,
    pauseAfterMs: 0,
    seed: 42,
  };
}

describe("AudioCatalogServiceImpl", () => {
  it("upserts and retrieves a descriptor and recipe", () => {
    const catalog = new AudioCatalogServiceImpl();
    const descriptor = makeDescriptor("l1");
    const recipe = makeRecipe("l1");

    catalog.upsertDescriptor(descriptor, recipe);

    expect(catalog.get("l1")).toEqual(descriptor);
    expect(catalog.getRecipe("l1")).toEqual(recipe);
    expect(catalog.isValidScope("l1")).toBe(true);
    expect(catalog.listDescriptors()).toEqual([descriptor]);
    expect(catalog.get("unknown")).toBeUndefined();
  });

  it("upsertDescriptor emits a descriptor event", () => {
    const catalog = new AudioCatalogServiceImpl();
    const events: AudioCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));

    catalog.upsertDescriptor(makeDescriptor("l1"), makeRecipe("l1"));

    expect(events).toEqual([{ type: "descriptor", descriptor: makeDescriptor("l1") }]);
  });

  it("invalidate drops the line and emits invalidated", () => {
    const catalog = new AudioCatalogServiceImpl();
    const events: AudioCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));
    catalog.upsertDescriptor(makeDescriptor("l1"), makeRecipe("l1"));

    catalog.invalidate("l1", "branch_discarded");

    expect(catalog.get("l1")).toBeUndefined();
    expect(catalog.getRecipe("l1")).toBeUndefined();
    expect(catalog.isValidScope("l1")).toBe(false);
    expect(events).toEqual([
      { type: "descriptor", descriptor: makeDescriptor("l1") },
      { type: "invalidated", lineId: "l1", reason: "branch_discarded" },
    ]);
  });

  it("invalidate on an unknown line is a silent no-op", () => {
    const catalog = new AudioCatalogServiceImpl();
    const events: AudioCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));

    catalog.invalidate("ghost", "preview_canceled");

    expect(events).toEqual([]);
  });

  it("validateFetchRequest accepts a matching descriptor", () => {
    const catalog = new AudioCatalogServiceImpl();
    catalog.upsertDescriptor(makeDescriptor("l1"), makeRecipe("l1"));

    const result = catalog.validateFetchRequest({
      taskId: "t1",
      lineId: "l1",
      cacheKey: "key-l1",
    });

    expect(result).toEqual(makeDescriptor("l1"));
  });

  it("validateFetchRequest rejects stale or forged cacheKeys (§22 core assertion)", () => {
    const catalog = new AudioCatalogServiceImpl();
    catalog.upsertDescriptor(makeDescriptor("l1", "key-v1"), makeRecipe("l1", "key-v1"));

    // Forged: right line, wrong key.
    expect(
      catalog.validateFetchRequest({ taskId: "t1", lineId: "l1", cacheKey: "forged" }),
    ).toBeUndefined();
    // Unknown line.
    expect(
      catalog.validateFetchRequest({ taskId: "t1", lineId: "ghost", cacheKey: "key-v1" }),
    ).toBeUndefined();

    // Stale: the descriptor is invalidated, so the old key no longer validates.
    catalog.invalidate("l1", "branch_discarded");
    expect(
      catalog.validateFetchRequest({ taskId: "t1", lineId: "l1", cacheKey: "key-v1" }),
    ).toBeUndefined();
  });

  it("setPriority updates the descriptor and emits priority_changed", () => {
    const catalog = new AudioCatalogServiceImpl();
    const events: AudioCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));
    catalog.upsertDescriptor(makeDescriptor("l1"), makeRecipe("l1"));

    catalog.setPriority("l1", "next");

    expect(catalog.get("l1")?.priority).toBe("next");
    expect(events).toEqual([
      { type: "descriptor", descriptor: makeDescriptor("l1") },
      { type: "priority_changed", lineId: "l1", priority: "next" },
    ]);
  });

  it("setPriority to the same value emits nothing", () => {
    const catalog = new AudioCatalogServiceImpl();
    const events: AudioCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));
    catalog.upsertDescriptor(makeDescriptor("l1"), makeRecipe("l1"));

    catalog.setPriority("l1", "current");

    expect(events).toHaveLength(1); // only the upsert descriptor event
  });

  it("unsubscribe stops event delivery", () => {
    const catalog = new AudioCatalogServiceImpl();
    const events: AudioCatalogEvent[] = [];
    const unsubscribe = catalog.subscribe((event) => events.push(event));

    unsubscribe();
    catalog.upsertDescriptor(makeDescriptor("l1"), makeRecipe("l1"));

    expect(events).toEqual([]);
  });
});
