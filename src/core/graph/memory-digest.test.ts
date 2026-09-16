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
    beliefs: [
      {
        id: "belief_1_1",
        characterId: "t1",
        content: "t1 相信终端需要指纹解锁",
        status: "active",
        createdAtCheckpoint: 2,
        origin: "believe",
      },
    ],
    facts: [
      {
        id: "fact_1_1",
        content: "地下室的终端会对苏遥的指纹反应",
        evidenceEventSeqs: [5, 6],
        checkpoint: 2,
        superseded: false,
        importance: "major",
      },
      {
        id: "fact_1_2",
        content: "终端位于地下室东侧（已被修订）",
        evidenceEventSeqs: [4],
        checkpoint: 1,
        superseded: true,
      },
    ],
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


describe("digest v2 (MA-B/D6)", () => {
  it("embeds facts and beliefs verbatim into the digest", () => {
    const digest = memoryDigestFromState(makeMemoryState());
    expect(digest.facts).toHaveLength(2);
    expect(digest.facts[0]!.content).toContain("指纹");
    expect(digest.beliefs[0]!.content).toContain("指纹解锁");
    expect(MemoryDigestSchema.parse(digest).facts).toHaveLength(2);
  });

  it("rebuilds facts/beliefs from the digest verbatim (recovery independent of canon)", () => {
    const state = memoryStateFromDigest(memoryDigestFromState(makeMemoryState()));
    expect(state.facts.map((f) => f.id)).toEqual(["fact_1_1", "fact_1_2"]);
    expect(state.beliefs).toHaveLength(1);
  });
});
