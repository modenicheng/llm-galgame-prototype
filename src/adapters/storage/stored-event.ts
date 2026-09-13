/**
 * StoredEvent 的磁盘行守卫 —— v2 边负载（回放数据）的唯一校验入口。
 */
import { InteractionEventSchema, type StoredEvent } from "../../schema.js";
import { DialogueDraftEventSchema, NarrationDraftEventSchema } from "../../story/types.js";

export function isStoredEvent(value: unknown): value is StoredEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.seq !== "number" || !Number.isInteger(record.seq) || record.seq <= 0 ||
    typeof record.turn !== "number" || !Number.isInteger(record.turn) || record.turn <= 0 ||
    typeof record.timestamp !== "string" || record.timestamp.length === 0 ||
    (record.source !== "model" && record.source !== "player") ||
    typeof record.type !== "string"
  ) return false;

  if (record.source === "model") {
    if (record.type === "dialogue") return DialogueDraftEventSchema.safeParse(record).success && typeof record.line_id === "string";
    if (record.type === "narration") return NarrationDraftEventSchema.safeParse(record).success && typeof record.line_id === "string";
    if (record.type === "interaction") {
      // InteractionEventSchema 是 strictObject（对模型输出防多余字段），而存储行
      // 外层还带着 seq/turn/timestamp/source 信封——校验前剥掉信封，只验交互体。
      // （v1 潜伏 bug：恢复从不回读 interaction，边负载回放使其成为承重路径。）
      const { seq: _seq, turn: _turn, timestamp: _timestamp, source: _source, ...interaction } = record;
      return InteractionEventSchema.safeParse(interaction).success;
    }
    return record.type === "end" && typeof record.ending_id === "string" && typeof record.text === "string";
  }
  if (record.type === "player_choice") return typeof record.choice_id === "string" && typeof record.text === "string";
  if (record.type === "player_input") return typeof record.interaction_id === "string" && typeof record.text === "string";
  return record.type === "player_dialogue" && typeof record.interaction_id === "string" &&
    typeof record.speaker === "string" && typeof record.text === "string" && typeof record.line_id === "string";
}
