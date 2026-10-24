/**
 * Tests for adaptQwen3TtsText — qwen3-tts punctuation compatibility.
 *
 * The rewrite table is evidence-backed (tts-server/tools/probe_punct.py,
 * 2026-09-19): line-final 破折号 is dropped (~0.1 s decay vs ……'s audible
 * trailing fade), mid-line it under-pauses vs a comma, and between
 * numerals it is a range where a pause would distort the reading.
 */
import { describe, expect, it } from "vitest";
import { adaptQwen3TtsText } from "./qwen3-text-compat.js";

describe("adaptQwen3TtsText", () => {
  it("renders line-final 破折号 as a trailing ellipsis", () => {
    const r = adaptQwen3TtsText("你居然——");
    expect(r.text).toBe("你居然……");
    expect(r.dashToPause).toBe(1);
    expect(r.rangeToDao).toBe(0);
  });

  it("renders mid-line 破折号 as a pause (stutter, interruption)", () => {
    expect(adaptQwen3TtsText("我——我不知道。").text).toBe("我……我不知道。");
    expect(adaptQwen3TtsText("他愣了一下——转身就走。").text).toBe(
      "他愣了一下……转身就走。",
    );
  });

  it("collapses a long dash run into one ellipsis", () => {
    const r = adaptQwen3TtsText("————");
    expect(r.text).toBe("……");
    expect(r.dashToPause).toBe(1);
  });

  it("maps a Chinese-numeral range to 到 instead of a pause", () => {
    const r = adaptQwen3TtsText("价格从三千——五千不等。");
    expect(r.text).toBe("价格从三千到五千不等。");
    expect(r.rangeToDao).toBe(1);
    expect(r.dashToPause).toBe(0);
  });

  it("maps an Arabic-numeral range to 到, tolerating spaces", () => {
    expect(adaptQwen3TtsText("一共10——20人").text).toBe("一共10到20人");
    expect(adaptQwen3TtsText("1998 —— 2005 年间").text).toBe("1998到2005 年间");
  });

  it("keeps 到-mapping off when only one side is a numeral", () => {
    const r = adaptQwen3TtsText("80后——90后的记忆");
    expect(r.text).toBe("80后……90后的记忆");
    expect(r.rangeToDao).toBe(0);
  });

  it("strips stray spaces around the inserted ellipsis next to CJK", () => {
    expect(adaptQwen3TtsText("愣了一下 —— 转身就走").text).toBe(
      "愣了一下……转身就走",
    );
    // Line-final variant: trailing space still cleaned up.
    expect(adaptQwen3TtsText("你居然 ——").text).toBe("你居然……");
  });

  it("merges with an adjacent existing ellipsis instead of stacking", () => {
    expect(adaptQwen3TtsText("他顿住……——").text).toBe("他顿住……");
  });

  it("leaves plain ASCII hyphens alone (English words, single-hyphen ranges)", () => {
    const r = adaptQwen3TtsText("a well-known 10-20 split");
    expect(r.text).toBe("a well-known 10-20 split");
    expect(r.dashToPause).toBe(0);
    expect(r.rangeToDao).toBe(0);
  });

  it("treats doubled ASCII hyphens as a dash run", () => {
    expect(adaptQwen3TtsText("好--我们走吧").text).toBe("好……我们走吧");
  });

  it("does not touch marks that read harmlessly (tilde, interpunct, ellipsis)", () => {
    const r = adaptQwen3TtsText("好呀～我们走吧。哈利·波特……来了。");
    expect(r.text).toBe("好呀～我们走吧。哈利·波特……来了。");
    expect(r.dashToPause).toBe(0);
    expect(r.rangeToDao).toBe(0);
  });

  it("returns the input unchanged when nothing applies", () => {
    const t = "普通的一句台词，什么特殊标点都没有。";
    const r = adaptQwen3TtsText(t);
    expect(r.text).toBe(t);
    expect(r.dashToPause).toBe(0);
    expect(r.rangeToDao).toBe(0);
  });
});
