import { describe, expect, it } from "vitest";
import {
  AudioDspParamsSchema,
  defaultAudioDspParams,
  parseAudioDspParams,
} from "./audio-dsp.js";

describe("AudioDspParamsSchema", () => {
  it("fills every default from an empty object", () => {
    const p = defaultAudioDspParams();
    expect(p.version).toBe(1);
    expect(p.voice.enabled).toBe(true);
    expect(p.voice.gate.threshold_db).toBe(-55);
    expect(p.voice.compressor.ratio).toBe(2.5);
    expect(p.voice.limiter.ceiling_db).toBe(-1.5);
    // BGM 链默认全关（gate 无意义、压缩/限幅保守关闭）
    expect(p.bgm.enabled).toBe(true);
    expect(p.bgm.gate.enabled).toBe(false);
    expect(p.bgm.compressor.enabled).toBe(false);
    expect(p.bgm.limiter.enabled).toBe(false);
    expect(p.ducking).toEqual({
      enabled: true,
      threshold_db: -42,
      depth_db: -12,
      attack_ms: 150,
      hold_ms: 350,
      release_ms: 900,
    });
  });

  it("accepts partial payloads, filling gaps with defaults", () => {
    const p = AudioDspParamsSchema.parse({ voice: { gate: { threshold_db: -50 } } });
    expect(p.voice.gate.threshold_db).toBe(-50);
    expect(p.voice.gate.hold_ms).toBe(150);
    expect(p.voice.compressor.ratio).toBe(2.5);
    expect(p.bgm.limiter.enabled).toBe(false);
  });

  it("clamps out-of-range numbers into legal ranges", () => {
    const p = AudioDspParamsSchema.parse({
      voice: { compressor: { ratio: 100, makeup_db: -99 } },
      ducking: { depth_db: -500 },
    });
    expect(p.voice.compressor.ratio).toBe(20);
    expect(p.voice.compressor.makeup_db).toBe(-24);
    expect(p.ducking.depth_db).toBe(-60);
  });

  it("falls back to per-field defaults on garbage values instead of failing", () => {
    // 顶层是对象但字段全坏：坏字段逐个回落默认，不丢其余合法配置
    const p = AudioDspParamsSchema.parse({
      voice: "loud",
      ducking: { depth_db: "broken", attack_ms: null },
    });
    expect(p.voice.gate.threshold_db).toBe(-55);
    expect(p.ducking.depth_db).toBe(-12);
    expect(p.ducking.attack_ms).toBe(150);
    expect(p.bgm.limiter.enabled).toBe(false);
  });

  it("corrupted bgm sub-objects fall back to BGM defaults (three stages stay off)", () => {
    // 内层 catch 必须用 BGM 自己的默认值——曾错误回落语音默认，把手改
    // 坏掉的 bgm 链"修复"成 gate/压缩/限幅三级全开并被保存粘性固化
    const p = AudioDspParamsSchema.parse({
      version: 1,
      bgm: { gate: { enabled: "x" }, compressor: "junk" },
    });
    expect(p.bgm.gate.enabled).toBe(false);
    expect(p.bgm.compressor.enabled).toBe(false);
    expect(p.bgm.compressor.threshold_db).toBe(-20);
    expect(p.bgm.limiter.enabled).toBe(false);
    // 同一子对象内坏字段回落本链默认、好字段保留（不整链吞掉）
    const mixed = AudioDspParamsSchema.parse({
      version: 1,
      bgm: { gate: { enabled: "x", threshold_db: -40 } },
    });
    expect(mixed.bgm.gate.enabled).toBe(false);
    expect(mixed.bgm.gate.threshold_db).toBe(-40);
  });

  it("rejects only non-object top levels", () => {
    expect(parseAudioDspParams("nope")).toBeNull();
    expect(parseAudioDspParams(42)).toBeNull();
    expect(parseAudioDspParams(null)).toBeNull();
    expect(parseAudioDspParams(["voice"])).toBeNull();
  });

  it("survives null sub-objects by defaulting them", () => {
    const p = AudioDspParamsSchema.parse({ voice: null, ducking: null });
    expect(p.voice.gate.threshold_db).toBe(-55);
    expect(p.ducking.depth_db).toBe(-12);
  });

  it("round-trips through JSON without drift", () => {
    const original = defaultAudioDspParams();
    const parsed = AudioDspParamsSchema.parse(JSON.parse(JSON.stringify(original)));
    expect(parsed).toEqual(original);
  });
});
