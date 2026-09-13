/**
 * MemoryDigest ↔ NarrativeMemoryState 映射测试（M1.1 决议）。
 */
import { describe, expect, it } from "vitest";
import type { NarrativeMemoryState } from "../narrative/memory-types.js";
import { MemoryDigestSchema, type MemoryDigest } from "./types.js";
import { memoryDigestFromState, memoryStateFromDigest } from "./memory-digest.js";

function makeMemoryState(): NarrativeMemoryState {
  return {
    revision: 3,
    consolidatedThroughEventSeq: 42,
    checkpointCount: 2,
    threads: {
      t1: {
        id: "t1",
        kind: "mystery",
        summary: "终端的来源成谜",
        status: "developing",
        importance: "major",
        introducedAtCheckpoint: 0,
        lastTouchedAtCheckpoint: 1,
        source: "runtime",
      },
    },
    setups: {},
    anchors: {
      a1: { id: "a1", purpose: "第一章目标", prerequisites: [], required: true, status: "pending" },
    },
    recentEpisodeIds: ["ep_9", "ep_8"],
  };
}

describe("memoryDigestFromState", () => {
  it("drops the episodes recency pointer and produces a valid digest", () => {
    const digest = memoryDigestFromState(makeMemoryState());
    const parsed: MemoryDigest = MemoryDigestSchema.parse(digest);
    expect(parsed.revision).toBe(3);
    expect(parsed.consolidatedThroughEventSeq).toBe(42);
    expect(parsed.threads.map((t) => t.id)).toEqual(["t1"]);
    expect(parsed.anchors.map((a) => a.id)).toEqual(["a1"]);
    expect("recentEpisodeIds" in parsed).toBe(false);
  });
});

describe("memoryStateFromDigest", () => {
  it("rebuilds keyed records and resets the episodes cache", () => {
    const digest = memoryDigestFromState(makeMemoryState());
    const state = memoryStateFromDigest(digest);
    expect(state.threads["t1"]?.summary).toBe("终端的来源成谜");
    expect(state.anchors["a1"]?.status).toBe("pending");
    expect(state.recentEpisodeIds).toEqual([]);
  });

  it("roundtrips losslessly apart from recentEpisodeIds", () => {
    const original = makeMemoryState();
    const rebuilt = memoryStateFromDigest(memoryDigestFromState(original));
    expect(rebuilt).toEqual({ ...original, recentEpisodeIds: [] });
  });
});
