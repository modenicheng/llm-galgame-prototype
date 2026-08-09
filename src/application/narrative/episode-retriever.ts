/**
 * Pure episode retrieval for the narrative brief (narrative director,
 * Task 5).
 *
 * No IO, no classes. Selection order:
 *  1) episodes whose characters intersect `opts.characters`, most recent 2
 *  2) episodes whose locations intersect `opts.locations`, most recent 2
 *  3) episodes whose threads intersect `opts.threads`, most recent 2 (dedup)
 *  4) every episode with importance "major" (dedup)
 * The merged result is sorted by toEventSeq descending and truncated to
 * `opts.max`. The input array is never mutated.
 */

import type { EpisodeMemory } from "../../core/narrative/memory-types.js";

/** Most recent first; ties broken by id for determinism. */
function byToEventSeqDesc(a: EpisodeMemory, b: EpisodeMemory): number {
  return b.toEventSeq - a.toEventSeq || a.id.localeCompare(b.id);
}

/** Number of episodes taken per filter step (steps 1 and 2). */
const RECENT_PER_FILTER = 2;

/**
 * Retrieve the episodes relevant to the given characters and threads.
 * Major episodes are always candidates; the final list is sorted by
 * recency and truncated to `max`.
 */
export function retrieveEpisodes(
  episodes: EpisodeMemory[],
  opts: {
    characters: string[];
    locations: string[];
    threads: string[];
    max: number;
  },
): EpisodeMemory[] {
  const selected: EpisodeMemory[] = [];
  const seen = new Set<string>();

  const addUnique = (episode: EpisodeMemory): void => {
    if (seen.has(episode.id)) {
      return;
    }
    seen.add(episode.id);
    selected.push(episode);
  };

  // 1) Character intersection: recent 2.
  const byCharacter = episodes
    .filter((episode) =>
      episode.characters.some((character) =>
        opts.characters.includes(character),
      ),
    )
    .sort(byToEventSeqDesc);
  for (const episode of byCharacter.slice(0, RECENT_PER_FILTER)) {
    addUnique(episode);
  }

  // 2) Location intersection: recent 2, dedup against step 1.
  const byLocation = episodes
    .filter((episode) =>
      episode.locations.some((location) =>
        opts.locations.includes(location),
      ),
    )
    .sort(byToEventSeqDesc);
  for (const episode of byLocation.slice(0, RECENT_PER_FILTER)) {
    addUnique(episode);
  }

  // 3) Thread intersection: most recent 2, dedup against steps 1-2 (no backfill).
  const byThread = episodes
    .filter((episode) =>
      episode.threads.some((thread) => opts.threads.includes(thread)),
    )
    .sort(byToEventSeqDesc);
  for (const episode of byThread.slice(0, RECENT_PER_FILTER)) {
    addUnique(episode);
  }

  // 4) Major episodes are always candidates (dedup against steps 1-3).
  for (const episode of episodes) {
    if (episode.importance === "major") {
      addUnique(episode);
    }
  }

  selected.sort(byToEventSeqDesc);
  return selected.slice(0, Math.max(0, opts.max));
}
