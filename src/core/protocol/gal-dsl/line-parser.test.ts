import { describe, it, expect } from "vitest";
import { parseDslLine } from "./line-parser.js";
import { DslProtocolError } from "./types.js";
import type { DslErrorCode } from "./types.js";

/** Assert that parsing `line` throws a DslProtocolError with exactly `code`. */
function expectCode(line: string, code: DslErrorCode): void {
  let caught: unknown;
  try {
    parseDslLine(line);
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected "${line}" to throw ${code}`).toBeInstanceOf(DslProtocolError);
  expect((caught as DslProtocolError).code).toBe(code);
}

describe("parseDslLine", () => {
  // --- narration ---

  it("parses a plain narration line", () => {
    expect(parseDslLine("地下室没有开灯。")).toEqual({
      kind: "narration",
      text: "地下室没有开灯。",
    });
  });

  it("parses a narration containing a full-width colon", () => {
    expect(parseDslLine("注意：请保持安静。")).toEqual({
      kind: "narration",
      text: "注意：请保持安静。",
    });
  });

  // --- dialogue ---

  it("parses a plain dialogue line", () => {
    expect(parseDslLine("苏遥: 我已经说过了。")).toEqual({
      kind: "dialogue",
      speaker: "苏遥",
      text: "我已经说过了。",
      visual: { hasVisual: false, resetVisual: false },
      name: { hasName: false, resetName: false },
    });
  });

  it("parses a dialogue with a [variant] visual slot", () => {
    const line = parseDslLine("苏遥[anxious]: 别紧张。");
    expect(line.kind).toBe("dialogue");
    if (line.kind === "dialogue") {
      expect(line.speaker).toBe("苏遥");
      expect(line.text).toBe("别紧张。");
      expect(line.visual).toEqual({
        hasVisual: true,
        resetVisual: false,
        variant: "anxious",
      });
    }
  });

  it("parses a dialogue with a [|position] visual slot", () => {
    const line = parseDslLine("苏遥[|left]: 我在左边。");
    if (line.kind === "dialogue") {
      expect(line.visual).toEqual({
        hasVisual: true,
        resetVisual: false,
        position: "left",
      });
    }
  });

  it("parses a dialogue with a [spriteSet:variant|position] visual slot", () => {
    const line = parseDslLine("苏遥[placeholder_char:anxious|right]: 现在换立绘了。");
    if (line.kind === "dialogue") {
      expect(line.visual).toEqual({
        hasVisual: true,
        resetVisual: false,
        spriteSet: "placeholder_char",
        variant: "anxious",
        position: "right",
      });
    }
  });

  it("parses a dialogue with a [] visual reset", () => {
    const line = parseDslLine("苏遥[]: 恢复默认。");
    if (line.kind === "dialogue") {
      expect(line.visual).toEqual({ hasVisual: true, resetVisual: true });
    }
  });

  it("parses a dialogue with a (displayName) name slot", () => {
    const line = parseDslLine("苏遥(神秘女子): 你问我是谁？保密。");
    if (line.kind === "dialogue") {
      expect(line.name).toEqual({
        hasName: true,
        resetName: false,
        displayName: "神秘女子",
      });
    }
  });

  it("parses a dialogue with a () name reset", () => {
    const line = parseDslLine("苏遥(): 我的名字是苏遥。");
    if (line.kind === "dialogue") {
      expect(line.name).toEqual({ hasName: true, resetName: true });
    }
  });

  it("parses a dialogue with a full []() reset", () => {
    const line = parseDslLine("苏遥[](): 一切复位。");
    if (line.kind === "dialogue") {
      expect(line.visual).toEqual({ hasVisual: true, resetVisual: true });
      expect(line.name).toEqual({ hasName: true, resetName: true });
    }
  });

  // --- stage cues ---

  it("parses a bg cue", () => {
    expect(parseDslLine("bg basement")).toEqual({ kind: "background", assetId: "basement" });
  });

  it("parses a bgm cue", () => {
    expect(parseDslLine("bgm mystery")).toEqual({ kind: "bgm", assetId: "mystery" });
  });

  it("parses a bgm stop cue with assetId 'stop'", () => {
    expect(parseDslLine("bgm stop")).toEqual({ kind: "bgm", assetId: "stop" });
  });

  it("parses a se cue", () => {
    expect(parseDslLine("se terminal_beep")).toEqual({
      kind: "sound_effect",
      assetId: "terminal_beep",
    });
  });

  // --- character cues ---

  it("parses a ch set cue", () => {
    expect(parseDslLine("ch suyao:anxious")).toEqual({
      kind: "character_cue",
      characterId: "suyao",
      variant: "anxious",
      action: "set",
    });
  });

  it("parses a ch set cue with a position", () => {
    expect(parseDslLine("ch suyao:anxious left")).toEqual({
      kind: "character_cue",
      characterId: "suyao",
      variant: "anxious",
      position: "left",
      action: "set",
    });
  });

  it("parses a ch hide cue", () => {
    expect(parseDslLine("ch suyao hide")).toEqual({
      kind: "character_cue",
      characterId: "suyao",
      action: "hide",
    });
  });

  it("parses a ch show cue", () => {
    expect(parseDslLine("ch suyao show")).toEqual({
      kind: "character_cue",
      characterId: "suyao",
      action: "show",
    });
  });

  // --- beat / forms ---

  it("parses a beat", () => {
    expect(parseDslLine("beat")).toEqual({ kind: "beat" });
  });

  it("parses a form start", () => {
    expect(parseDslLine("? 怎么回应？")).toEqual({ kind: "form_start", prompt: "怎么回应？" });
  });

  it("parses a form option", () => {
    expect(parseDslLine("+ 追问她所谓“启动之后”究竟发生过什么")).toEqual({
      kind: "form_option",
      text: "追问她所谓“启动之后”究竟发生过什么",
    });
  });

  it("parses a form input", () => {
    expect(parseDslLine("= 输入你的回答……")).toEqual({
      kind: "form_input",
      placeholder: "输入你的回答……",
    });
  });

  it("parses a form end", () => {
    expect(parseDslLine("/?")).toEqual({ kind: "form_end" });
  });

  it("trims whitespace defensively around a line", () => {
    expect(parseDslLine("  /?  ")).toEqual({ kind: "form_end" });
    expect(parseDslLine("\tbg basement\r")).toEqual({ kind: "background", assetId: "basement" });
  });

  // --- empty form payloads are allowed at parse level ---

  it("allows empty payloads for form prefixes (rejected later by the group builder)", () => {
    expect(parseDslLine("?")).toEqual({ kind: "form_start", prompt: "" });
    expect(parseDslLine("+")).toEqual({ kind: "form_option", text: "" });
    expect(parseDslLine("= ")).toEqual({ kind: "form_input", placeholder: "" });
  });

  // --- segment end sentinel ---

  it.each(["buffer", "interaction", "ending"] as const)(
    "parses an @end sentinel with reason %s",
    (reason) => {
      expect(parseDslLine(`@end a81f ${reason}`)).toEqual({
        kind: "segment_end",
        nonce: "a81f",
        reason,
      });
    },
  );

  // --- error cases ---

  it.each([
    "苏遥[|]: 空段。",
    "苏遥[:]: 冒号空段。",
    "苏遥[:|]: 冒号空段加位置。",
    "苏遥[a:]: 变体为空。",
    "苏遥[:b]: spriteSet 为空。",
    "苏遥[a|]: 位置段为空。",
    "苏遥[a:b:c]: 多个冒号。",
    "苏遥[x|north]: 非法位置。",
    "苏遥[x|left|right]: 段数过多。",
  ])("rejects an invalid visual bracket in %s", (line) => {
    expectCode(line, "INVALID_VISUAL_BRACKET");
  });

  it("rejects a name paren that is empty after trim", () => {
    expectCode("苏遥( ): 名字是空的。", "INVALID_NAME_PAREN");
  });

  it("rejects an @end sentinel missing its reason", () => {
    expectCode("@end a81f", "SENTINEL_MISSING_REASON");
  });

  it("rejects an @end sentinel with an invalid reason", () => {
    expectCode("@end a81f bogus", "SENTINEL_INVALID_REASON");
  });

  it("rejects a bare ch command without a variant", () => {
    expectCode("ch suyao", "INVALID_CH_CUE");
  });

  it("rejects a ch command with an invalid position", () => {
    expectCode("ch suyao:anxious north", "INVALID_CH_CUE");
  });

  it("rejects a ch command with an unknown action", () => {
    expectCode("ch suyao jump", "INVALID_CH_CUE");
  });

  it("rejects a bare bg command", () => {
    expectCode("bg", "UNKNOWN_LINE");
  });

  it("rejects a malformed bg command with extra tokens", () => {
    expectCode("bg foo bar", "UNKNOWN_LINE");
  });

  it("rejects a malformed bgm command", () => {
    expectCode("bgm", "UNKNOWN_LINE");
  });

  it("rejects a malformed se command", () => {
    expectCode("se", "UNKNOWN_LINE");
  });
});
