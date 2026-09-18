import { describe, expect, it } from "vitest";
import {
  BacklogStore,
  MAX_BACKLOG_ENTRIES,
  type BacklogEntryInput,
} from "./backlog-store.js";

function line(id: string, overrides: Partial<BacklogEntryInput> = {}): BacklogEntryInput {
  return { type: "dialogue", lineId: id, speaker: "苏遥", text: `台词 ${id}`, ...overrides };
}

describe("BacklogStore", () => {
  it("appends presented lines oldest-first", () => {
    const store = new BacklogStore();
    store.push(line("a"));
    store.push(line("b", { type: "narration" }));
    expect(store.list().map((e) => e.lineId)).toEqual(["a", "b"]);
    expect(store.list()[1]).toMatchObject({ type: "narration", text: "台词 b" });
  });

  it("deduplicates by line_id (reconnect re-presentation is a no-op)", () => {
    const store = new BacklogStore();
    store.push(line("a", { text: "第一次" }));
    store.push(line("a", { text: "重连重放" }));
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.text).toBe("第一次");
  });

  it("attaches and invalidates replay audio independently of text", () => {
    const store = new BacklogStore();
    store.push(line("a"));
    store.attachAudio("a", "cache-a", 24000);
    expect(store.get("a")).toMatchObject({ cacheKey: "cache-a", sampleRate: 24000 });
    // Idempotent re-attach (descriptor republished) keeps the latest.
    store.attachAudio("a", "cache-a2", 22050);
    expect(store.get("a")!.cacheKey).toBe("cache-a2");
    store.invalidateAudio("a");
    expect(store.get("a")).toMatchObject({ cacheKey: null, sampleRate: 0, text: "台词 a" });
    // Unknown line ids are silently ignored.
    expect(() => store.invalidateAudio("ghost")).not.toThrow();
    expect(() => store.attachAudio("ghost", "k", 1)).not.toThrow();
  });

  it("caps history by dropping the oldest entries", () => {
    const store = new BacklogStore();
    const total = MAX_BACKLOG_ENTRIES + 10;
    for (let i = 0; i < total; i += 1) store.push(line(`l${i}`));
    const list = store.list();
    expect(list).toHaveLength(MAX_BACKLOG_ENTRIES);
    expect(list[0]!.lineId).toBe("l10");
    expect(list[list.length - 1]!.lineId).toBe(`l${total - 1}`);
    // Dropped entries leave the index too — a late audio attach is a no-op.
    store.attachAudio("l5", "cache-5", 24000);
    expect(store.get("l5")).toBeUndefined();
    // But re-pushing a dropped id appends it again as a new presentation.
    store.push(line("l5"));
    expect(store.get("l5")).not.toBeUndefined();
  });

  it("list() returns a fresh array and clear() resets everything", () => {
    const store = new BacklogStore();
    store.push(line("a"));
    const snapshot = store.list();
    store.push(line("b"));
    expect(snapshot).toHaveLength(1);
    expect(store.list()).toHaveLength(2);
    store.clear();
    expect(store.list()).toHaveLength(0);
    expect(store.get("a")).toBeUndefined();
  });
});
