/**
 * MemoryDigest ↔ NarrativeMemoryState 纯映射（执行清单 M1.1 决议）。
 *
 * 决策节点快照中的 memoryDigest 是恢复路径的唯一真源；NarrativeMemoryStore
 * 的会话文件只是工作缓存。`recentEpisodeIds` 属于 episodes 缓存的 recency
 * 指针，不入契约：摘要化时丢弃，重建时置空（episodes 随新 checkpoint 重新
 * 积累）。周目内记忆随快照走（v2 起 facts/beliefs 全文嵌入，决议 D6）；
 * 纯函数，无 IO。
 */
import type { NarrativeMemoryState } from "../narrative/memory-types.js";
import type { MemoryDigest } from "./types.js";

/** 无记忆子层（event mode / director 未接入）时的空摘要。 */
export const EMPTY_MEMORY_DIGEST: MemoryDigest = {
  revision: 0,
  consolidatedThroughEventSeq: 0,
  checkpointCount: 0,
  threads: [],
  setups: [],
  anchors: [],
  facts: [],
  beliefs: [],
};

/** 嵌入决策节点入口/末态快照前的摘要化（丢弃缓存态字段）。
 * MA-B（v2）：facts/beliefs 全文嵌入（决议 D6）——恢复不得依赖 canon。 */
export function memoryDigestFromState(state: NarrativeMemoryState): MemoryDigest {
  return {
    revision: state.revision,
    consolidatedThroughEventSeq: state.consolidatedThroughEventSeq,
    checkpointCount: state.checkpointCount,
    threads: Object.values(state.threads),
    setups: Object.values(state.setups),
    anchors: Object.values(state.anchors),
    facts: state.facts.map((fact) => ({ ...fact })),
    beliefs: state.beliefs.map((belief) => ({ ...belief })),
  };
}

/** 从快照 digest 重建运行时记忆态（episodes 缓存从空重新积累）。 */
export function memoryStateFromDigest(digest: MemoryDigest): NarrativeMemoryState {
  return {
    revision: digest.revision,
    consolidatedThroughEventSeq: digest.consolidatedThroughEventSeq,
    checkpointCount: digest.checkpointCount,
    threads: Object.fromEntries(digest.threads.map((thread) => [thread.id, thread])),
    setups: Object.fromEntries(digest.setups.map((setup) => [setup.id, setup])),
    anchors: Object.fromEntries(digest.anchors.map((anchor) => [anchor.id, anchor])),
    recentEpisodeIds: [],
    facts: digest.facts.map((fact) => ({ ...fact })),
    beliefs: digest.beliefs.map((belief) => ({ ...belief })),
  };
}
