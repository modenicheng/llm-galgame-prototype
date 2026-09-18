/**
 * Event 模式会话记忆代理的纯合并层（2026-09-18）。
 *
 * 把 LLM 提取的状态提案（SessionMemoryAgentPort.derive 的输出）安全地
 * 合并进 StoryState。合并策略是"投影器而非第二作者"：
 * - characters：merge-only，只接受已知角色、非空短语；不删除字段。
 * - canon：字符串键值对；总键数封顶（种子键钉住不被逐出）。
 * - open_threads：按 id 匹配；status 只允许**前向**迁移（new → active →
 *   ready → resolved/abandoned），因此不会覆盖分级收束 L1 的 new → ready
 *   翻转；摘要可更新；线程总数封顶（先逐已关闭、再逐最久未动）。
 *
 * 纯函数：无 I/O、无 LLM；无有效变更时返回 null，调用方跳过重渲染。
 */
import type { MemoryAgentProposal } from "../core/ports/session-memory-agent-port.js";
import type { StoryState, StoryThread } from "./types.js";

/** 人物状态单字段长度上限——提案应是短语，不是句子。 */
const CHARACTER_FIELD_MAX_CHARS = 40;
/** canon 总键数上限（注入限额：canon ≤12 键）。 */
const CANON_MAX_KEYS = 12;
/** 开放线程总数上限（注入限额：threads ≤8 条）。 */
const THREADS_MAX = 8;
/** 线程摘要长度上限。 */
const THREAD_SUMMARY_MAX_CHARS = 60;

/** 线程状态迁移次序；resolved 与 abandoned 同级且都是终态。 */
const THREAD_STATUS_ORDER: Record<StoryThread["status"], number> = {
  new: 0,
  active: 1,
  ready: 2,
  resolved: 3,
  abandoned: 3,
};

function sanitizeShortText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function sanitizeCharacterProposals(
  proposal: MemoryAgentProposal["characters"],
  known: ReadonlySet<string> | undefined,
): StoryState["characters"] | undefined {
  if (proposal === undefined) return undefined;
  const next: StoryState["characters"] = {};
  let changed = false;
  for (const [id, fields] of Object.entries(proposal)) {
    // 未知角色（不在素材目录）不接受状态——与 reconcile 的幻影发言者
    // 过滤同一防线；含空白/@ 的 id 同样拒绝。
    if (/[\s@]/.test(id)) continue;
    if (known !== undefined && !known.has(id)) continue;
    if (typeof fields !== "object" || fields === null) continue;
    const emotion = sanitizeShortText(fields.emotion, CHARACTER_FIELD_MAX_CHARS);
    const goal = sanitizeShortText(fields.current_goal, CHARACTER_FIELD_MAX_CHARS);
    const relationship = sanitizeShortText(fields.relationship_to_player, CHARACTER_FIELD_MAX_CHARS);
    if (emotion === undefined && goal === undefined && relationship === undefined) continue;
    next[id] = {
      ...(emotion !== undefined ? { emotion } : {}),
      ...(goal !== undefined ? { current_goal: goal } : {}),
      ...(relationship !== undefined ? { relationship_to_player: relationship } : {}),
    };
    changed = true;
  }
  return changed ? next : undefined;
}

function mergeCanon(
  existing: StoryState["canon"],
  proposal: MemoryAgentProposal["canon"],
): StoryState["canon"] | undefined {
  if (proposal === undefined) return undefined;
  const merged: StoryState["canon"] = { ...existing };
  let changed = false;
  for (const [key, value] of Object.entries(proposal)) {
    if (typeof value !== "string") continue;
    const text = sanitizeShortText(value, CHARACTER_FIELD_MAX_CHARS * 2);
    if (text === undefined || text === merged[key]) continue;
    merged[key] = text;
    changed = true;
  }
  if (!changed) return undefined;
  // 键数封顶：种子键（scenario_*，本局可追溯锚点）钉住，其余按插入序
  // 从最旧开始逐出。
  const keys = Object.keys(merged);
  if (keys.length <= CANON_MAX_KEYS) return merged;
  const evictable = keys.filter((key) => !key.startsWith("scenario_"));
  const toEvict = new Set(evictable.slice(0, keys.length - CANON_MAX_KEYS));
  for (const key of toEvict) delete merged[key];
  return merged;
}

function mergeThreads(
  existing: readonly StoryThread[],
  proposal: MemoryAgentProposal["open_threads"],
  turn: number,
): StoryThread[] | undefined {
  if (proposal === undefined || !Array.isArray(proposal)) return undefined;
  let threads = [...existing];
  let changed = false;

  for (const item of proposal) {
    if (typeof item !== "object" || item === null) continue;
    const id = sanitizeShortText(item.id, 40);
    if (id === undefined || /[\s@]/.test(id)) continue;
    const summary = sanitizeShortText(item.summary, THREAD_SUMMARY_MAX_CHARS);
    const status = item.status;
    const index = threads.findIndex((thread) => thread.id === id);

    if (index === -1) {
      // 新线程：必须有摘要；status 只允许非终态起点。
      if (summary === undefined) continue;
      if (status !== undefined && status !== "new" && status !== "active") continue;
      threads.push({
        id,
        summary,
        status: status ?? "new",
        last_touched_turn: turn,
      });
      changed = true;
      continue;
    }

    const current = threads[index]!;
    // 前向迁移校验：向后（含把 ready 拉回 active/new）一律拒绝——
    // 这保证分级收束 L1 的 new → ready 翻转不被 agent 覆盖。
    let nextStatus = current.status;
    if (
      status !== undefined &&
      status !== current.status &&
      THREAD_STATUS_ORDER[status] > THREAD_STATUS_ORDER[current.status]
    ) {
      nextStatus = status;
    }
    const nextSummary = summary ?? current.summary;
    if (nextStatus === current.status && nextSummary === current.summary) continue;
    threads[index] = {
      ...current,
      summary: nextSummary,
      status: nextStatus,
      last_touched_turn: Math.max(current.last_touched_turn, turn),
    };
    changed = true;
  }

  if (!changed) return undefined;
  // 线程总数封顶：先逐已关闭（resolved/abandoned）里最久未动的，
  // 再逐开放线程里最久未动的。
  while (threads.length > THREADS_MAX) {
    const order = threads
      .map((thread, index) => ({ thread, index }))
      .sort((a, b) => a.thread.last_touched_turn - b.thread.last_touched_turn);
    const closed = order.find(
      ({ thread }) => thread.status === "resolved" || thread.status === "abandoned",
    );
    const victim = closed ?? order[0];
    if (victim === undefined) break;
    threads.splice(victim.index, 1);
  }
  return threads;
}

/**
 * 把提案合并进状态；无有效变更时返回 null。
 * recent_summary / scene / player_profile 不归 agent 管（recap 管线与
 * 确定性投影各自独占），此处一律保持原样。
 */
export function applyMemoryProposal(
  state: StoryState,
  proposal: MemoryAgentProposal,
  options: { knownCharacterIds?: ReadonlySet<string> | undefined; turn: number },
): StoryState | null {
  const charactersUpdate = sanitizeCharacterProposals(proposal?.characters, options.knownCharacterIds);
  const canonUpdate = mergeCanon(state.canon, proposal?.canon);
  const threadsUpdate = mergeThreads(state.open_threads, proposal?.open_threads, options.turn);

  if (charactersUpdate === undefined && canonUpdate === undefined && threadsUpdate === undefined) {
    return null;
  }

  const characters = charactersUpdate !== undefined
    ? { ...state.characters }
    : state.characters;
  if (charactersUpdate !== undefined) {
    for (const [id, fields] of Object.entries(charactersUpdate)) {
      characters[id] = { ...characters[id], ...fields };
    }
  }

  return {
    ...state,
    characters,
    ...(canonUpdate !== undefined ? { canon: canonUpdate } : {}),
    ...(threadsUpdate !== undefined ? { open_threads: threadsUpdate } : {}),
  };
}
