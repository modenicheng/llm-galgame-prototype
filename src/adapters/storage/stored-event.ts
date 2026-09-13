/**
 * StoredEvent 的磁盘行守卫 —— v1 session 事件日志与 v2 边负载（回放数据）
 * 共用同一份校验，避免两处各写一套判定（单一真源）。
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
    if (record.type === "interaction") return InteractionEventSchema.safeParse(record).success;
    return record.type === "end" && typeof record.ending_id === "string" && typeof record.text === "string";
  }
  if (record.type === "player_choice") return typeof record.choice_id === "string" && typeof record.text === "string";
  if (record.type === "player_input") return typeof record.interaction_id === "string" && typeof record.text === "string";
  return record.type === "player_dialogue" && typeof record.interaction_id === "string" &&
    typeof record.speaker === "string" && typeof record.text === "string" && typeof record.line_id === "string";
}
