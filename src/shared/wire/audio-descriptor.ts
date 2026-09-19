/**
 * AudioDescriptor — the authoritative audio identity published by Node.
 *
 * The browser treats every field as opaque data; it never re-derives
 * provider parameters. `cacheKey` is the only value the browser echoes
 * back when requesting synthesis.
 *
 * C7（§6.1）字段语义：`speakerId` 恒为 roster 稳定 CharacterId（身份
 * 寻址键，绝不放显示名/名牌/TTS 配置键）；`displaySpeaker` 是该条事件
 * 的名牌快照（用户可见展示，不参与合成与缓存键）。`displayLabel` 改名
 * 不改变 speakerId 与 cacheKey。
 */

export type AudioScope =
  | { type: "active" }
  | { type: "candidate"; branchId: string }
  | { type: "input_preview"; previewId: string };

export type AudioPriority =
  | "current"
  | "next"
  | "active_future"
  | "candidate_first_line"
  | "background";

export interface AudioFormatDescriptor {
  encoding: "pcm_s16le";
  sampleRate: number;
  channels: 1;
}

export interface AudioDescriptor {
  lineId: string;
  cacheKey: string;
  scope: AudioScope;
  priority: AudioPriority;
  /** 稳定角色 ID（CharacterId）——身份键，不是显示名。 */
  speakerId: string;
  /** 该条事件的名牌快照——展示文本，改名只影响这里。 */
  displaySpeaker: string;
  format: AudioFormatDescriptor;
}
