/**
 * fact-retriever — facts → brief 相关集选取（记忆 spec §5.3，MA-B）。
 *
 * 纯函数，直接扫数组（规模与 episode-retriever 同级）：
 * 选取 = （在场角色 ∩ scope.characters）∪（location 匹配）∪（importance=major），
 * 只取未 superseded 的记录，按 checkpoint 倒序，上限 `facts.brief_max`。
 */

import type { FactRecord } from "../../core/narrative/memory-types.js";

export interface FactQuery {
  /** 当前在场角色（brief request.characters）。 */
  characters: readonly string[];
  /** 当前地点（空串 = 未知，不参与匹配）。 */
  location: string;
  /** 上限（config.narrative.facts.brief_max）。 */
  max: number;
}

export function retrieveFacts(
  facts: readonly FactRecord[],
  query: FactQuery,
): FactRecord[] {
  const characters = new Set(query.characters);
  const selected = facts.filter((fact) => {
    if (fact.superseded) return false;
    if (fact.importance === "major") return true;
    if (
      fact.scope?.characters !== undefined &&
      fact.scope.characters.some((c) => characters.has(c))
    ) {
      return true;
    }
    if (
      query.location !== "" &&
      fact.scope?.location !== undefined &&
      fact.scope.location === query.location
    ) {
      return true;
    }
    return false;
  });
  return selected
    .sort((a, b) => b.checkpoint - a.checkpoint || b.id.localeCompare(a.id))
    .slice(0, query.max);
}
