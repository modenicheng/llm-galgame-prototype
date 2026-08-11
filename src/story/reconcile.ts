/**
 * StoryStateReconciler（docs/llm-outputs-refactor.md §80–§81）——
 * 从正式提交的事件确定性投影 StoryState 的 live 字段。
 *
 * 纯函数：只消费「旧 StoryState + 已提交事件」，无 I/O、无 LLM、无副作用。
 * 输入必须是自上次调用以来新提交的事件（增量调用）；输出为不可变新对象
 * （无变化时返回原引用，便于调用方跳过重渲染）。
 *
 * 投影规则（确定性）：
 * - scene.location ← 批次内最后一条 `background` stage cue 的 assetId；
 * - characters ← 台词 characterId 与 character_patch cue 的并集（值为空对象，
 *   情绪/目标等字段没有确定性来源，留给未来波）；
 * - recent_summary ← 批次内最后 ≤3 条 narration/dialogue 文本拼接（≤300 字）。
 * canon / open_threads / player_profile 无确定性投影来源，保持原样
 * （剧情线语义已由 NarrativeDirector memory 承担）。
 */
import type { StoredEvent } from "../schema.js";
import type { StoryState } from "./types.js";

function isBackgroundCue(cue: unknown): cue is { type: "background"; assetId: string } {
  if (typeof cue !== "object" || cue === null) return false;
  if (!("type" in cue) || cue.type !== "background") return false;
  if (!("assetId" in cue)) return false;
  return typeof cue.assetId === "string";
}

function isCharacterPatchCue(cue: unknown): cue is { type: "character_patch"; character: string } {
  if (typeof cue !== "object" || cue === null) return false;
  if (!("type" in cue) || cue.type !== "character_patch") return false;
  if (!("character" in cue)) return false;
  return typeof cue.character === "string";
}

export function reconcileStoryState(
  previous: StoryState,
  committed: readonly StoredEvent[],
): StoryState {
  let location = previous.scene.location;
  const characters: StoryState["characters"] = { ...previous.characters };
  let charactersChanged = false;
  const recentLines: string[] = [];

  for (const event of committed) {
    if (event.type === "dialogue" || event.type === "narration") {
      for (const cue of event.stage ?? []) {
        if (isBackgroundCue(cue)) {
          if (cue.assetId !== location) {
            location = cue.assetId;
          }
        } else if (isCharacterPatchCue(cue)) {
          if (characters[cue.character] === undefined) {
            characters[cue.character] = {};
            charactersChanged = true;
          }
        }
      }
    }
    if (event.type === "dialogue") {
      const characterId = event.characterId;
      if (characterId !== undefined && characterId !== "" && characters[characterId] === undefined) {
        characters[characterId] = {};
        charactersChanged = true;
      }
      recentLines.push(`${event.speaker}: ${event.text}`);
    } else if (event.type === "narration") {
      recentLines.push(event.text);
    }
  }

  let summaryChanged = false;
  let recentSummary = previous.recent_summary;
  if (recentLines.length > 0) {
    const summary = recentLines.slice(-3).join(" / ").slice(0, 300);
    if (summary !== previous.recent_summary) {
      summaryChanged = true;
      recentSummary = summary;
    }
  }

  const locationChanged = location !== previous.scene.location;
  if (!locationChanged && !charactersChanged && !summaryChanged) {
    return previous;
  }
  return {
    ...previous,
    scene: locationChanged ? { ...previous.scene, location } : previous.scene,
    characters: charactersChanged ? characters : previous.characters,
    recent_summary: recentSummary,
  };
}
