/**
 * Wire 过渡边界的身份校验（C2）。
 *
 * 新格式对白跨 wire 只经 `NewFormatDialogueEventSchema`；`displaySpeaker`
 * （音频描述符名牌）按统一 Unicode 名牌规则校验。
 */
import { describe, expect, it } from "vitest";
import {
  AudioDescriptorSchema,
  NewFormatDialogueEventSchema,
} from "./schemas.js";

const validDescriptor = {
  lineId: "line-1",
  cacheKey: "cache-1",
  scope: { type: "active" },
  priority: "current",
  speakerId: "female_A",
  displaySpeaker: "神秘女子",
  format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
};

describe("AudioDescriptorSchema — displaySpeaker 名牌规则", () => {
  it("接受合法名牌", () => {
    expect(AudioDescriptorSchema.safeParse(validDescriptor).success).toBe(true);
  });

  it("拒绝空/纯空白与控制字符名牌", () => {
    expect(
      AudioDescriptorSchema.safeParse({ ...validDescriptor, displaySpeaker: "   " }).success,
    ).toBe(false);
    expect(
      AudioDescriptorSchema.safeParse({ ...validDescriptor, displaySpeaker: "苏遥\n苏遥" })
        .success,
    ).toBe(false);
  });
});

describe("NewFormatDialogueEventSchema — wire 边界", () => {
  it("接受带必填 characterId/displayLabel 的新格式对白", () => {
    expect(
      NewFormatDialogueEventSchema.safeParse({
        type: "dialogue",
        characterId: "female_A",
        displayLabel: "神秘女子",
        text: "你不该来这里。",
      }).success,
    ).toBe(true);
  });

  it("拒绝只有旧 speaker 的载荷：wire 边界之外无身份猜测", () => {
    expect(
      NewFormatDialogueEventSchema.safeParse({
        type: "dialogue",
        speaker: "许晚晴",
        text: "你不该来这里。",
      }).success,
    ).toBe(false);
  });
});
