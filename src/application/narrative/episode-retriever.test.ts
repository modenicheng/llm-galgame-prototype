/**
 * Tests for the narrative-memory episode retriever (Task 5:
 * episode-retriever.ts).
 *
 * Covers character/thread intersection, dedup across the three sources,
 * recency ordering, truncation to max, and unconditional inclusion of
 * major episodes.
 */

import { describe, it, expect } from "vitest";

import { retrieveEpisodes } from "./episode-retriever.js";

import type { EpisodeMemory } from "../../core/narrative/memory-types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ep(overrides: Partial<EpisodeMemory> & { id: string }): EpisodeMemory {
  const { id, toEventSeq, ...rest } = overrides;
  return {
    id,
    fromEventSeq: rest.fromEventSeq ?? Math.max(0, (toEventSeq ?? 0) - 5),
    toEventSeq: toEventSeq ?? 0,
    summary: `episode ${id}`,
    characters: [],
    locations: [],
    threads: [],
    setups: [],
    importance: "normal",
    ...rest,
  };
}

/** The shared episode pool used across most tests. */
const pool: EpisodeMemory[] = [
  ep({ id: "ep-a", toEventSeq: 100, characters: ["aiko"], threads: ["t1"] }),
  ep({ id: "ep-b", toEventSeq: 90, characters: ["kenji"], threads: ["t2"] }),
  ep({ id: "ep-c", toEventSeq: 80, characters: ["aiko"], threads: ["t2"] }),
  ep({ id: "ep-d", toEventSeq: 70, characters: ["aiko"], threads: ["t3"], importance: "major" }),
  ep({ id: "ep-e", toEventSeq: 60, characters: [], threads: ["t2"] }),
  ep({ id: "ep-f", toEventSeq: 50, characters: ["aiko"], threads: [], importance: "major" }),
];

function ids(result: EpisodeMemory[]): string[] {
  return result.map((e) => e.id);
}

// ---------------------------------------------------------------------------
// retrieveEpisodes
// ---------------------------------------------------------------------------

describe("retrieveEpisodes", () => {
  it("returns [] for an empty episode list", () => {
    expect(retrieveEpisodes([], { characters: [], locations: [], threads: [], max: 6 })).toEqual([]);
  });

  it("returns [] when nothing matches and no major episodes exist", () => {
    const episodes = [ep({ id: "ep-x", toEventSeq: 10, characters: ["yumi"] })];
    expect(
      retrieveEpisodes(episodes, { characters: ["aiko"], locations: [], threads: ["t9"], max: 6 }),
    ).toEqual([]);
  });

  it("returns [] when max is 0", () => {
    expect(retrieveEpisodes(pool, { characters: ["aiko"], locations: [], threads: ["t2"], max: 0 })).toEqual([]);
  });

  it("selects the two most recent episodes by character intersection", () => {
    const episodes = [
      ep({ id: "ep-a", toEventSeq: 100, characters: ["aiko"] }),
      ep({ id: "ep-b", toEventSeq: 90, characters: ["kenji"] }),
      ep({ id: "ep-c", toEventSeq: 80, characters: ["aiko"] }),
      ep({ id: "ep-e", toEventSeq: 60, characters: ["yumi"] }),
    ];
    const result = retrieveEpisodes(episodes, { characters: ["aiko"], locations: [], threads: [], max: 6 });
    // aiko appears in ep-a(100), ep-c(80) → recent 2: ep-a, ep-c.
    expect(ids(result)).toEqual(["ep-a", "ep-c"]);
  });

  it("selects the two most recent episodes by location intersection", () => {
    const episodes = [
      ep({ id: "ep-a", toEventSeq: 100, locations: ["教室"] }),
      ep({ id: "ep-b", toEventSeq: 90, locations: ["天台"] }),
      ep({ id: "ep-c", toEventSeq: 80, locations: ["教室"] }),
      ep({ id: "ep-e", toEventSeq: 60, locations: ["走廊"] }),
    ];
    const result = retrieveEpisodes(episodes, { characters: [], locations: ["教室"], threads: [], max: 6 });
    // 教室 appears in ep-a(100), ep-c(80) → recent 2: ep-a, ep-c.
    expect(ids(result)).toEqual(["ep-a", "ep-c"]);
  });

  it("dedups episodes matched by both location and thread", () => {
    const episodes = [
      ep({ id: "ep-a", toEventSeq: 100, locations: ["教室"], threads: ["t1"] }),
      ep({ id: "ep-b", toEventSeq: 90, locations: ["天台"], threads: ["t2"] }),
      ep({ id: "ep-c", toEventSeq: 80, locations: ["教室"], threads: ["t2"] }),
    ];
    const result = retrieveEpisodes(episodes, { characters: [], locations: ["教室"], threads: ["t2"], max: 6 });
    // location hits: ep-a, ep-c; thread hits (recent 2, minus ep-c): ep-b;
    // final sort is by toEventSeq descending → ep-a(100), ep-b(90), ep-c(80).
    expect(ids(result)).toEqual(["ep-a", "ep-b", "ep-c"]);
  });

  it("selects the two most recent episodes by thread intersection", () => {
    const episodes = [
      ep({ id: "ep-a", toEventSeq: 100, threads: ["t1"] }),
      ep({ id: "ep-b", toEventSeq: 90, threads: ["t2"] }),
      ep({ id: "ep-c", toEventSeq: 80, threads: ["t2"] }),
      ep({ id: "ep-e", toEventSeq: 60, threads: ["t2"] }),
    ];
    const result = retrieveEpisodes(episodes, { characters: [], locations: [], threads: ["t2"], max: 6 });
    // t2 appears in ep-b(90), ep-c(80), ep-e(60) → recent 2: ep-b, ep-c.
    expect(ids(result)).toEqual(["ep-b", "ep-c"]);
  });

  it("dedups episodes matched by both character and thread", () => {
    const result = retrieveEpisodes(pool, { characters: ["aiko"], locations: [], threads: ["t2"], max: 6 });
    // char hits (recent 2): ep-a, ep-c; thread hits (recent 2, minus ep-c): ep-b;
    // majors: ep-d, ep-f. ep-c must appear exactly once.
    expect(ids(result)).toEqual(["ep-a", "ep-b", "ep-c", "ep-d", "ep-f"]);
    expect(new Set(ids(result)).size).toBe(5);
  });

  it("always adds major episodes even when they match neither filter", () => {
    const episodes = [
      ep({ id: "ep-1", toEventSeq: 30, characters: ["aiko"] }),
      ep({ id: "ep-major", toEventSeq: 20, characters: ["yumi"], importance: "major" }),
    ];
    const result = retrieveEpisodes(episodes, { characters: ["aiko"], locations: [], threads: [], max: 6 });
    expect(ids(result)).toEqual(["ep-1", "ep-major"]);
  });

  it("includes only major episodes when filters match nothing", () => {
    const result = retrieveEpisodes(pool, { characters: ["yumi"], locations: [], threads: ["t9"], max: 6 });
    // ep-d(70) and ep-f(50) are the only majors → sorted desc.
    expect(ids(result)).toEqual(["ep-d", "ep-f"]);
  });

  it("sorts the final result by toEventSeq descending", () => {
    const result = retrieveEpisodes(pool, { characters: ["aiko"], locations: [], threads: ["t2"], max: 6 });
    const seqs = result.map((e) => e.toEventSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it("truncates to max after merging all sources", () => {
    const result = retrieveEpisodes(pool, { characters: ["aiko"], locations: [], threads: ["t2"], max: 3 });
    expect(ids(result)).toEqual(["ep-a", "ep-b", "ep-c"]);
  });

  it("applies truncation to major episodes too (they are candidates, not exemptions)", () => {
    const result = retrieveEpisodes(pool, { characters: ["aiko"], locations: [], threads: ["t2"], max: 2 });
    expect(ids(result)).toEqual(["ep-a", "ep-b"]);
  });

  it("respects max larger than the candidate set", () => {
    const result = retrieveEpisodes(pool, { characters: ["aiko"], locations: [], threads: ["t2"], max: 100 });
    expect(ids(result)).toEqual(["ep-a", "ep-b", "ep-c", "ep-d", "ep-f"]);
  });

  it("does not mutate the input episode array", () => {
    const copy = [...pool];
    retrieveEpisodes(pool, { characters: ["aiko"], locations: [], threads: [], max: 6 });
    expect(pool).toEqual(copy);
  });
});
