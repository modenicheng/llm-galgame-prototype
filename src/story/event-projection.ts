/**
 * C5 §5.1 身份稳定的事件投影（writer / memory / recap 三个入口）。
 *
 * 单一来源：已提交事件自带（characterId + 发射时刻名牌快照）。投影绝不
 * 用今天的名字重写昨天的名牌，也绝不把未知说话人静默变成新角色——
 * 兼容期无法确定旧事件身份时输出显式 `unresolved_legacy_dialogue`
 * （保留文本与原名牌），它不是新 `@say` 示例，也不是人物记忆更新依据。
 *
 * 三个入口（不是一条串接字符串函数）：
 * - `projectWriterHistory`：writer/prefetch/recovery 的历史窗口（含未提交
 *   预取事件，attempt 引用）；
 * - `projectMemoryEvidence`：记忆证据——只有真实 seq 的已提交事件，排除
 *   unresolved 旧记录；
 * - `projectRecapSource`：前情梗概源——已提交事件，unresolved 旧记录
 *   带标记保留（压缩器如实记录，不参与身份归因）。
 *
 * player_input 与对应 player_dialogue 是同一交互的两个视图：按
 * interaction_id 合并为单条投影（保留 playable 视图并链接另一视图的
 * eventRef），不当玩家重复说了两遍。投影是纯函数——绝不修改（也不允许
 * 调用方误以为它会修改）原事件审计记录。
 */
import type {
  CharacterId,
  CharacterRegistry,
  CharacterRuntimeState,
} from "../core/characters/types.js";
import type { StoredEvent, StoryContextEvent } from "../schema.js";

// ---------------------------------------------------------------------------
// ProjectedEvent（§5.1）
// ---------------------------------------------------------------------------

export interface ProjectedEvent {
  /** 已提交为 event:<seq>，未提交为 attempt:<id>:<index>。 */
  eventRef: string;
  /** 未提交预取没有 seq，不能进入 memory evidence。 */
  seq?: number;
  type: string;
  source: "model" | "player";
  characterId?: CharacterId;
  displayLabel?: string;
  text?: string;
  /**
   * 交互关联（§5.1 两个视图）：interaction / player_input / player_dialogue
   * 携带其 interaction_id。
   */
  interactionId?: string;
  /** 去重合并视图指向被合并视图的 eventRef（审计可追溯）。 */
  linkedEventRef?: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 交互提示在投影里的截断上限（与旧 serializeStoryContext 的 80 字一致）。 */
const INTERACTION_PROMPT_MAX = 80;

function truncateForProjection(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized;
}

function committedSeq(event: StoryContextEvent): number | undefined {
  if (!("seq" in event)) return undefined;
  const seq = (event as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isInteger(seq) ? seq : undefined;
}

/**
 * 兼容期 legacy 解析：事件缺 characterId 时按名牌/姓名解析。规则从严：
 * 唯一命中才归因；ID 直写命中；两角色同名或完全未注册 → 不猜
 * （unresolved_legacy_dialogue）。
 */
function resolveLegacySpeaker(
  speaker: string,
  registry: CharacterRegistry,
): CharacterId | undefined {
  if (registry.get(speaker) !== undefined) return speaker;
  const matches = registry.roster.characters.filter(
    (definition) => definition.name === speaker || definition.initialLabel === speaker,
  );
  return matches.length === 1 ? matches[0]!.id : undefined;
}

/** 投影核心：一个事件 → 一条未合并的 ProjectedEvent（或 null = 跳过）。 */
function projectOne(
  event: StoryContextEvent,
  registry: CharacterRegistry,
): ProjectedEvent | null {
  const seq = committedSeq(event);
  // player_* 事件由运行时创建（模型从不产出）：按事件类型定性来源；
  // 其余事件读审计字段（缺省 model）。
  const source: "model" | "player" =
    event.type === "player_choice" ||
    event.type === "player_input" ||
    event.type === "player_dialogue" ||
    ("source" in event && event.source === "player")
      ? "player"
      : "model";
  const base = {
    ...(seq !== undefined ? { seq } : {}),
    source: source as "model" | "player",
  };

  switch (event.type) {
    case "dialogue": {
      const speaker = event.speaker;
      const ownId = "characterId" in event ? (event as { characterId?: unknown }).characterId : undefined;
      const characterId =
        typeof ownId === "string" && ownId !== ""
          ? ownId
          : resolveLegacySpeaker(speaker, registry);
      if (characterId === undefined) {
        // 显式 unresolved：保留文本与原名牌，绝不伪造身份。
        return {
          eventRef: "",
          ...base,
          type: "unresolved_legacy_dialogue",
          displayLabel: speaker,
          text: event.text,
        };
      }
      return {
        eventRef: "",
        ...base,
        type: "dialogue",
        characterId,
        displayLabel: speaker,
        text: event.text,
      };
    }
    case "narration":
      return { eventRef: "", ...base, type: "narration", text: event.text };
    case "interaction":
      return {
        eventRef: "",
        ...base,
        type: "interaction",
        interactionId: event.interaction_id,
        text: truncateForProjection(event.prompt, INTERACTION_PROMPT_MAX),
      };
    case "player_choice":
      return {
        eventRef: "",
        ...base,
        type: "player_choice",
        characterId: registry.roster.playerId,
        text: event.text,
      };
    case "player_input":
      return {
        eventRef: "",
        ...base,
        type: "player_input",
        characterId: registry.roster.playerId,
        interactionId: event.interaction_id,
        text: event.text,
      };
    case "player_dialogue":
      return {
        eventRef: "",
        ...base,
        type: "player_dialogue",
        characterId: registry.roster.playerId,
        displayLabel: event.speaker,
        interactionId: event.interaction_id,
        text: event.text,
      };
    default:
      // choice / end / beat —— 纯机器记录，不进任何投影。
      return null;
  }
}

// ---------------------------------------------------------------------------
// player_input / player_dialogue 去重关联
// ---------------------------------------------------------------------------

interface MergeIndex {
  /** interaction_id → 已见 player_input 投影（含原事件 seq）。 */
  inputsByInteraction: Map<string, { seq: number | undefined }>;
  /** interaction_id → 是否存在 player_dialogue 视图。 */
  hasDialogue: Set<string>;
}

function buildMergeIndex(events: readonly StoryContextEvent[]): MergeIndex {
  const inputsByInteraction = new Map<string, { seq: number | undefined }>();
  const hasDialogue = new Set<string>();
  for (const event of events) {
    if (event.type === "player_input") {
      if (!inputsByInteraction.has(event.interaction_id)) {
        inputsByInteraction.set(event.interaction_id, { seq: committedSeq(event) });
      }
    } else if (event.type === "player_dialogue") {
      hasDialogue.add(event.interaction_id);
    }
  }
  return { inputsByInteraction, hasDialogue };
}

/**
 * 未提交事件的 attempt 标识（§5.1 attempt:<id>:<index> 的 <id>）：
 * line_id 优先（预取台词/旁白），interaction_id 次之（表单/玩家事件），
 * 都没有时按内容兜底（同一投影内仍唯一可数）。
 */
function attemptKeyId(event: StoryContextEvent): string {
  if ("line_id" in event && typeof event.line_id === "string" && event.line_id !== "") {
    return event.line_id;
  }
  if ("interaction_id" in event) {
    const interactionId = (event as { interaction_id?: unknown }).interaction_id;
    if (typeof interactionId === "string" && interactionId !== "") return interactionId;
  }
  return `${event.type}:${(event as { text?: string }).text ?? ""}`;
}

/**
 * 核心 projection 管道（三个入口共用）：
 * projectOne → player 双视图合并 → eventRef 落章。
 */
function projectEvents(
  events: readonly StoryContextEvent[],
  registry: CharacterRegistry,
): ProjectedEvent[] {
  const index = buildMergeIndex(events);
  const projected: ProjectedEvent[] = [];
  const attemptKeys: string[] = [];

  for (const event of events) {
    const one = projectOne(event, registry);
    if (one === null) continue;

    if (one.type === "player_input" && index.hasDialogue.has(one.interactionId!)) {
      // 同一交互的 player_dialogue 视图会在其位置合并本视图——跳过独立条目。
      continue;
    }
    if (one.type === "player_dialogue") {
      const input = index.inputsByInteraction.get(one.interactionId!);
      if (input !== undefined && input.seq !== undefined) {
        one.linkedEventRef = `event:${input.seq}`;
      }
    }
    projected.push(one);
    attemptKeys.push(attemptKeyId(event));
  }

  // eventRef 落章：已提交 = event:<seq>；attempt 引用按投影内出现顺序编号
  // （同一 id 的第 n 条，index 从 0 起）。
  const attemptCounts = new Map<string, number>();
  for (let i = 0; i < projected.length; i += 1) {
    const event = projected[i]!;
    if (event.seq !== undefined) {
      event.eventRef = `event:${event.seq}`;
    } else {
      const key = attemptKeys[i]!;
      const seen = attemptCounts.get(key) ?? 0;
      attemptCounts.set(key, seen + 1);
      event.eventRef = `attempt:${key}:${seen}`;
    }
  }
  return projected;
}

// ---------------------------------------------------------------------------
// 三个入口（§5.1 签名为准）
// ---------------------------------------------------------------------------

/** 名牌状态副本（无原型对象重建；预取分支的隔离副本用它）。 */
export function cloneCharacterRuntimeState(
  state: CharacterRuntimeState,
): CharacterRuntimeState {
  const labels = Object.create(null) as Record<CharacterId, string>;
  for (const key of Object.keys(state.labels)) {
    if (Object.hasOwn(state.labels, key)) {
      labels[key] = state.labels[key]!;
    }
  }
  return { labels };
}

/** writer / prefetch / recovery 的历史窗口投影（含未提交预取事件）。 */
export function projectWriterHistory(
  events: readonly StoryContextEvent[],
  registry: CharacterRegistry,
): readonly ProjectedEvent[] {
  return projectEvents(events, registry);
}

/** 记忆证据投影：只有真实 seq 的已提交事件；排除 unresolved 旧记录。 */
export function projectMemoryEvidence(
  events: readonly StoredEvent[],
  registry: CharacterRegistry,
): readonly ProjectedEvent[] {
  const committedOnly = events.filter((event) => committedSeq(event) !== undefined);
  return projectEvents(committedOnly, registry).filter(
    (event) => event.type !== "unresolved_legacy_dialogue",
  );
}

/** 前情梗概源投影：已提交事件；unresolved 旧记录带标记保留。 */
export function projectRecapSource(
  events: readonly StoredEvent[],
  registry: CharacterRegistry,
): readonly ProjectedEvent[] {
  const committedOnly = events.filter((event) => committedSeq(event) !== undefined);
  return projectEvents(committedOnly, registry);
}

// ---------------------------------------------------------------------------
// JSONL 渲染（writer 历史的「身份稳定的事件 JSON」，§5.1）
// ---------------------------------------------------------------------------

/**
 * 逐行紧凑 JSON（JSONL）：每条投影一行，键序固定（eventRef 首位），文本
 * 内的换行由 JSON 转义——一条事件永不破行。行内不含 `名牌: 台词` 形态，
 * 模型无从把历史误解析为新角色的行头格式。
 */
export function renderProjectedEvents(events: readonly ProjectedEvent[]): string {
  return events.map(renderOneProjectedEvent).join("\n");
}

function renderOneProjectedEvent(event: ProjectedEvent): string {
  const parts: string[] = [`"eventRef":${JSON.stringify(event.eventRef)}`];
  if (event.seq !== undefined) parts.push(`"seq":${event.seq}`);
  parts.push(`"type":${JSON.stringify(event.type)}`);
  parts.push(`"source":${JSON.stringify(event.source)}`);
  if (event.characterId !== undefined) {
    parts.push(`"characterId":${JSON.stringify(event.characterId)}`);
  }
  if (event.displayLabel !== undefined) {
    parts.push(`"displayLabel":${JSON.stringify(event.displayLabel)}`);
  }
  if (event.interactionId !== undefined) {
    parts.push(`"interactionId":${JSON.stringify(event.interactionId)}`);
  }
  if (event.linkedEventRef !== undefined) {
    parts.push(`"linkedEventRef":${JSON.stringify(event.linkedEventRef)}`);
  }
  if (event.text !== undefined) {
    parts.push(`"text":${JSON.stringify(event.text)}`);
  }
  return `{${parts.join(",")}}`;
}
