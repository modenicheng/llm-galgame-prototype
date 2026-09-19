/**
 * Wire message validation (shared between Node host and browser client).
 *
 * Both ends validate inbound messages with the same zod schemas so a
 * malformed message never reaches the runtime or the UI. Pure data
 * validation: no Node or DOM imports.
 *
 * C2 过渡边界：新格式对白跨 wire 一律经 `NewFormatDialogueEventSchema`
 * 校验（characterId/displayLabel 必填）；旧 `speaker` 载荷只允许在本
 * 边界经 legacy 读取器（story/types 的 DialogueDraftEventSchema）读入。
 *
 * C7 wire 语义（§6.1）：`speakerId` 恒为稳定 CharacterId（格式校验拒绝
 * 显示名冒充）；`displaySpeaker` 是该条事件的名牌快照。wire 协议版本
 * `WIRE_PROTOCOL_VERSION` 随 client.ready 上报——版本过旧的客户端由
 * 服务端按既有 close-code 模式明确拒绝（升级/重连信号），不做静默兼容。
 */
import { z } from "zod";
import { CharacterLabelSchema, CHARACTER_ID_PATTERN } from "../../core/characters/types.js";
import { CharacterDialogueEventSchema } from "../../story/types.js";

/** 新格式对白在 wire 上的唯一校验入口（strict：拒绝混写旧 speaker）。 */
export const NewFormatDialogueEventSchema = CharacterDialogueEventSchema;

/**
 * Runtime WebSocket 协议版本。C7 = 2：audio descriptor 的 speakerId 语义
 * 收紧为稳定 CharacterId（v1 期间可能是 TTS 配置键/显示名）。两端共享
 * 本常量；不匹配的旧客户端收到 4002 close（附升级说明），不静默降级。
 */
export const WIRE_PROTOCOL_VERSION = 2;

/** 旧 wire 版本客户端的 close code（沿用 4001 controller-limit 的拒绝模式）。 */
export const STALE_WIRE_CLOSE_CODE = 4002;

/** speakerId 的稳定 ID 语义：字母开头、[A-Za-z0-9_-]，拒绝显示名冒充。 */
const SpeakerIdSchema = z
  .string()
  .min(1)
  .refine((id) => CHARACTER_ID_PATTERN.test(id), {
    message: "speakerId 必须是稳定角色 ID（^[A-Za-z][A-Za-z0-9_-]{0,63}$），不是显示名/名牌",
  });

export const AudioScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("active") }),
  z.object({ type: z.literal("candidate"), branchId: z.string().min(1) }),
  z.object({ type: z.literal("input_preview"), previewId: z.string().min(1) }),
]);

export const AudioDescriptorSchema = z.object({
  lineId: z.string().min(1),
  cacheKey: z.string().min(1),
  scope: AudioScopeSchema,
  priority: z.enum([
    "current",
    "next",
    "active_future",
    "candidate_first_line",
    "background",
  ]),
  // C7：恒为 roster 稳定 CharacterId（身份寻址）；显示名走 displaySpeaker。
  speakerId: SpeakerIdSchema,
  // C2：displaySpeaker 是名牌文本，按统一 Unicode 名牌规则校验
  //（trim 后 1–64 码点、拒绝控制字符）。C7 起为该条事件的 label 快照。
  displaySpeaker: CharacterLabelSchema,
  format: z.object({
    encoding: z.literal("pcm_s16le"),
    sampleRate: z.number().int().positive(),
    channels: z.literal(1),
  }),
});

export const AudioFetchRequestSchema = z.object({
  taskId: z.string().min(1),
  lineId: z.string().min(1),
  cacheKey: z.string().min(1),
});

/** RuntimeCommand wire form (the command union is defined in core). */
export const RuntimeCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("advance") }),
  z.object({
    type: z.literal("select_choice"),
    interactionId: z.string().min(1),
    optionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("preview_input"),
    interactionId: z.string().min(1),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal("confirm_input"),
    previewId: z.string().min(1),
  }),
  z.object({
    type: z.literal("cancel_input"),
    previewId: z.string().min(1),
  }),
  z.object({ type: z.literal("shutdown") }),
  z.object({ type: z.literal("restart_session") }),
  z.object({
    type: z.literal("retrace"),
    decisionId: z.string().min(1),
  }),
]);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("runtime.command"),
    commandId: z.string().min(1),
    command: RuntimeCommandSchema,
  }),
  z.object({
    type: z.literal("audio.cache_report"),
    lineId: z.string().min(1),
    cacheKey: z.string().min(1),
    result: z.enum(["hit", "miss", "partial", "corrupt"]),
  }),
  z.object({
    type: z.literal("audio.buffer_report"),
    bufferedAheadMs: z.number().nonnegative(),
    underrunCount: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("client.ready"),
    capabilities: z.object({
      audioWorklet: z.boolean(),
      indexedDb: z.boolean(),
    }),
    /**
     * C7：客户端 wire 协议版本（与服务端 WIRE_PROTOCOL_VERSION 对照）。
     * 旧客户端缺省不报——服务端按 STALE_WIRE_CLOSE_CODE 明确拒绝并给
     * 升级/重连说明，本 schema 只做形状校验。
     */
    wireVersion: z.number().int().nonnegative().optional(),
  }),
]);

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("projection.snapshot"),
    projection: z.unknown(),
  }),
  z.object({
    type: z.literal("runtime.output"),
    sequence: z.number().int().nonnegative(),
    output: z.unknown(),
  }),
  z.object({
    type: z.literal("audio.descriptor"),
    descriptor: AudioDescriptorSchema,
  }),
  z.object({
    type: z.literal("audio.priority_changed"),
    lineId: z.string().min(1),
    priority: z.enum([
      "current",
      "next",
      "active_future",
      "candidate_first_line",
      "background",
    ]),
  }),
  z.object({
    type: z.literal("audio.invalidated"),
    lineId: z.string().min(1),
    reason: z.enum(["branch_discarded", "preview_canceled", "session_closed"]),
  }),
  z.object({
    type: z.literal("audio.task_status"),
    taskId: z.string().min(1),
    lineId: z.string().min(1),
    status: z.enum(["started", "finished", "failed", "canceled"]),
    error: z.string().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
  }),
]);
