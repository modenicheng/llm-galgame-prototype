/**
 * AudioDescriptor — the authoritative audio identity published by Node.
 *
 * The browser treats every field as opaque data; it never re-derives
 * provider parameters. `cacheKey` is the only value the browser echoes
 * back when requesting synthesis.
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
  speakerId: string;
  displaySpeaker: string;
  format: AudioFormatDescriptor;
}
