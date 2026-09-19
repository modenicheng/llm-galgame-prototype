/**
 * Wire 过渡边界的身份校验（C2）+ C7 稳定 ID 语义与版本闸门。
 *
 * 新格式对白跨 wire 只经 `NewFormatDialogueEventSchema`；`displaySpeaker`
 * （音频描述符名牌）按统一 Unicode 名牌规则校验。C7 起 `speakerId` 恒为
 * 稳定 CharacterId（拒绝显示名冒充），client.ready 携带 wire 协议版本。
 */
import { describe, expect, it } from "vitest";
import {
  AudioDescriptorSchema,
  ClientMessageSchema,
  NewFormatDialogueEventSchema,
  STALE_WIRE_CLOSE_CODE,
  WIRE_PROTOCOL_VERSION,
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

describe("AudioDescriptorSchema — speakerId 稳定 ID 语义（C7）", () => {
  it("接受稳定角色 ID（含既有 female_A / raspberry / su-yao）", () => {
    for (const speakerId of ["female_A", "raspberry", "su-yao"]) {
      expect(
        AudioDescriptorSchema.safeParse({ ...validDescriptor, speakerId }).success,
        speakerId,
      ).toBe(true);
    }
  });

  it("拒绝显示名/名牌冒充 speakerId（改名不产生新身份）", () => {
    for (const speakerId of ["许晚晴", "神秘女子", "旁白"]) {
      expect(
        AudioDescriptorSchema.safeParse({ ...validDescriptor, speakerId }).success,
        speakerId,
      ).toBe(false);
    }
  });

  it("拒绝危险键与非法 ID 形状（R04 键空间约束由 factory 直连 registry 保证）", () => {
    expect(
      AudioDescriptorSchema.safeParse({ ...validDescriptor, speakerId: "__proto__" }).success,
    ).toBe(false);
    expect(
      AudioDescriptorSchema.safeParse({ ...validDescriptor, speakerId: "not an id!" }).success,
    ).toBe(false);
  });
});

describe("client.ready wire 版本（C7 升级/重连信号）", () => {
  const ready = (wireVersion?: number) => ({
    type: "client.ready" as const,
    capabilities: { audioWorklet: true, indexedDb: true },
    ...(wireVersion !== undefined ? { wireVersion } : {}),
  });

  it("携带当前版本与缺省（旧客户端形状）都能通过形状校验——闸门在服务端", () => {
    expect(ClientMessageSchema.safeParse(ready(WIRE_PROTOCOL_VERSION)).success).toBe(true);
    // 旧客户端不携带 wireVersion：形状合法（服务端按 STALE_WIRE_CLOSE_CODE
    // 明确拒绝，不做静默兼容）。
    expect(ClientMessageSchema.safeParse(ready()).success).toBe(true);
  });

  it("版本常量配对：server=2，stale close code=4002（沿用 4001 拒绝模式）", () => {
    expect(WIRE_PROTOCOL_VERSION).toBe(2);
    expect(STALE_WIRE_CLOSE_CODE).toBe(4002);
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
