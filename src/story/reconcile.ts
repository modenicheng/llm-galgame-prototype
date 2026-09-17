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
 *   情绪/目标等字段没有确定性来源，留给未来波）。
 * canon / open_threads / player_profile 无确定性投影来源，保持原样。
 * recent_summary 由滚动前情梗概管线（src/story/recap.ts，2026-09-17 上下文
 * 审计）独占维护——它承载的是"滑出历史窗口的事件"的压缩记录；此处若再
 * 覆写最近 3 行，会把前情梗概冲掉（且那 3 行本来就重复出现在历史窗口里）。
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

/**
 * 故意未登记进 state.characters 的角色 id 过滤：语法坏行造成的幻影发言者
 * （如 `@6ch raspberry: …` 被当台词）一旦入库，就会经 summarizeState 的
 * [Characters] 段回流进后续 writer prompt，模型看到坏语法并模仿——上下文
 * 污染闭环（2026-09-17 会话审计）。已知角色集来自素材目录；不含 @ 或空白
 * 的额外兜底让旧会话里已污染的条目也停止扩散。
 */
function trackableCharacterId(
  characterId: string,
  known: ReadonlySet<string> | undefined,
): boolean {
  if (/[\s@]/.test(characterId)) return false;
  return known === undefined || known.has(characterId);
}

export function reconcileStoryState(
  previous: StoryState,
  committed: readonly StoredEvent[],
  options?: { knownCharacterIds?: ReadonlySet<string> | undefined },
): StoryState {
  const known = options?.knownCharacterIds;
  let location = previous.scene.location;
  const characters: StoryState["characters"] = { ...previous.characters };
  let charactersChanged = false;

  for (const event of committed) {
    if (event.type === "dialogue" || event.type === "narration") {
      for (const cue of event.stage ?? []) {
        if (isBackgroundCue(cue)) {
          if (cue.assetId !== location) {
            location = cue.assetId;
          }
        } else if (isCharacterPatchCue(cue)) {
          if (
            characters[cue.character] === undefined &&
            trackableCharacterId(cue.character, known)
          ) {
            characters[cue.character] = {};
            charactersChanged = true;
          }
        }
      }
    }
    if (event.type === "dialogue") {
      const characterId = event.characterId;
      if (
        characterId !== undefined &&
        characterId !== "" &&
        characters[characterId] === undefined &&
        trackableCharacterId(characterId, known)
      ) {
        characters[characterId] = {};
        charactersChanged = true;
      }
    }
  }

  const locationChanged = location !== previous.scene.location;
  if (!locationChanged && !charactersChanged) {
    return previous;
  }
  return {
    ...previous,
    scene: locationChanged ? { ...previous.scene, location } : previous.scene,
    characters: charactersChanged ? characters : previous.characters,
  };
}
