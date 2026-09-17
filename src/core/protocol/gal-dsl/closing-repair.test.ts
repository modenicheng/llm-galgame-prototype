import { describe, expect, it } from "vitest";
import { repairDslClosingLine } from "./closing-repair.js";
import { repairSwappedVisualSlots } from "./closing-repair.js";

describe("repairDslClosingLine", () => {
  const allowed = ["buffer", "interaction", "ending"] as const;

  it("repairs the observed missing-end keyword typo", () => {
    expect(repairDslClosingLine("@ 07b8 interaction", "07b8", allowed)).toEqual({
      line: "@end 07b8 interaction",
      kind: "end_keyword",
    });
  });

  // 2026-09-17 会话审计里真实出现过的全部哨兵畸形：nonce + reason 都与
  // 本次请求精确一致时，无论 end 关键字如何被写坏都安全。
  it.each([
    ["keyword omitted, glued to @", "@07b8 buffer", "@end 07b8 buffer"],
    ["junk char before keyword", "@¬end 07b8 buffer", "@end 07b8 buffer"],
    ["doubled-keyword typo", "@eend 07b8 buffer", "@end 07b8 buffer"],
    ["garbled keyword", "@el 07b8 ending", "@end 07b8 ending"],
    ["keyword glued to nonce", "@end07b8 buffer", "@end 07b8 buffer"],
    ["spaced keyword before nonce", "@ end 07b8 buffer", "@end 07b8 buffer"],
  ])("repairs %s", (_label, raw, expected) => {
    expect(repairDslClosingLine(raw, "07b8", allowed)).toEqual({
      line: expected,
      kind: "end_keyword",
    });
  });

  it("accepts surrounding whitespace but preserves the canonical output", () => {
    expect(repairDslClosingLine("  @   07b8   buffer  ", "07b8", allowed)).toEqual({
      line: "@end 07b8 buffer",
      kind: "end_keyword",
    });
  });

  it.each([
    ["wrong nonce", "@ dead interaction", "07b8", allowed],
    ["disallowed reason", "@ 07b8 ending", "07b8", ["buffer"] as const],
    ["trailing content", "@ 07b8 interaction extra", "07b8", allowed],
    ["missing at-sign", "end 07b8 interaction", "07b8", allowed],
    ["ordinary at text", "@ 等一下", "07b8", allowed],
    ["bare marker", "@", "07b8", allowed],
    ["missing reason is not derivable", "@end 07b8", "07b8", allowed],
    ["digit-bearing keyword is not a keyword typo", "@e2d 07b8 buffer", "07b8", allowed],
    ["digit-prefixed nonce is a different nonce", "@107b8 buffer", "07b8", allowed],
  ])("does not repair %s", (_label, raw, nonce, reasons) => {
    expect(repairDslClosingLine(raw, nonce, reasons)).toBeNull();
  });
});

describe("repairSwappedVisualSlots", () => {
  const speakers = new Set(["raspberry", "树莓娘"]);

  it.each([
    ["id in variant slot with variant position", "树莓娘[raspberry|smug]: 走吧。", "树莓娘[smug]: 走吧。"],
    ["id in variant slot with real position", "raspberry[raspberry|left]: 嗯。", "raspberry[|left]: 嗯。"],
    ["id as the whole bracket", "树莓娘[raspberry]: 那走吧。", "树莓娘: 那走吧。"],
  ])("repairs %s", (_label, raw, expected) => {
    expect(repairSwappedVisualSlots(raw, speakers)).toMatchObject({
      line: expected,
      kind: "visual_swap",
    });
  });

  it.each([
    ["legit variant slot", "树莓娘[smug]: 走吧。"],
    ["legit variant|position", "树莓娘[smug|left]: 走吧。"],
    ["unregistered id in slot", "树莓娘[同学甲|smug]: 走吧。"],
    ["no bracket at all", "树莓娘: 走吧。"],
    ["forbidden empty second slot", "树莓娘[raspberry|]: 走吧。"],
    ["spriteSet form", "树莓娘[raspberry:smug]: 走吧。"],
  ])("leaves %s alone", (_label, raw) => {
    expect(repairSwappedVisualSlots(raw, speakers)).toBeNull();
  });

  it("returns null without a speaker set", () => {
    expect(repairSwappedVisualSlots("树莓娘[raspberry|smug]: 走吧。", undefined)).toBeNull();
  });
});
