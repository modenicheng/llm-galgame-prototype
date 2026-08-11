/**
 * Wire message validation (shared between Node host and browser client).
 *
 * Both ends validate inbound messages with the same zod schemas so a
 * malformed message never reaches the runtime or the UI. Pure data
 * validation: no Node or DOM imports.
 */
import { z } from "zod";

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
  speakerId: z.string().min(1),
  displaySpeaker: z.string().min(1),
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
