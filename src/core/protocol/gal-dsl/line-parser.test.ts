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

  it("parses a narration whose full-width colon is mid-sentence, not a delimiter", () => {
    // Sentence punctuation before the colon ⇒ real narration; untouched.
    expect(parseDslLine("远处传来钟声，一下、两下：夜里更静了。")).toEqual({
      kind: "narration",
      text: "远处传来钟声，一下、两下：夜里更静了。",
    });
  });

  it("normalizes a full-width colon into dialogue only for registered speakers", () => {
    // Chinese LLM output frequently writes 「苏遥：台词」. With the registry's
    // speaker set the delimiter-position ： converts and the
    // speaker/[visual] syntax no longer leaks into player-visible text.
    const speakers = new Set(["苏遥", "林澈"]);
    expect(parseDslLine("苏遥：你不该来这里。", speakers)).toEqual({
      kind: "dialogue",
      speaker: "苏遥",
      text: "你不该来这里。",
      visual: { hasVisual: false, resetVisual: false },
      name: { hasName: false, resetName: false },
    });
    expect(parseDslLine("苏遥[anxious]：你好", speakers)).toEqual({
      kind: "dialogue",
      speaker: "苏遥",
      text: "你好",
      visual: { hasVisual: true, resetVisual: false, variant: "anxious" },
      name: { hasName: false, resetName: false },
    });
    // Unregistered prefixes in delimiter shape are narration — no heuristic
    // guessing about "does this look like a name" (「警告：危险」 etc.).
    expect(parseDslLine("警告：危险。", speakers)).toEqual({
      kind: "narration",
      text: "警告：危险。",
    });
    // Without a speaker set the normalization is disabled entirely
    // (conservative — callers that cannot know the cast never reclassify).
    expect(parseDslLine("苏遥：你不该来这里。", undefined)).toEqual({
      kind: "narration",
      text: "苏遥：你不该来这里。",
    });
  });

  it("replaces only the delimiter-position full-width colon (bracket-internal colons survive)", () => {
    const speakers = new Set(["苏遥"]);
    // The ： inside [visual] must not block normalization nor tear the line;
    // it is normalized separately so the spriteSet:variant split still works.
    const line = parseDslLine("苏遥[suit：calm]：你好", speakers);
    expect(line.kind).toBe("dialogue");
    if (line.kind === "dialogue") {
      expect(line.speaker).toBe("苏遥");
      expect(line.text).toBe("你好");
      expect(line.visual).toEqual({
        hasVisual: true,
        resetVisual: false,
        spriteSet: "suit",
        variant: "calm",
      });
    }
    const paren = parseDslLine("苏遥(化名：小遥)：你好", speakers);
    expect(paren.kind).toBe("dialogue");
    if (paren.kind === "dialogue") {
      expect(paren.speaker).toBe("苏遥");
      expect(paren.text).toBe("你好");
    }
  });

  it("keeps quote-wrapped lines as narration (quotes are not speaker material)", () => {
    // CJK quotes in the prefix mean prose, not a speaker — leaving the line
    // as narration is the safe degradation (no quote fragments in the
    // speaker box).
    expect(parseDslLine("他说“走吧”：然后转身。")).toEqual({
      kind: "narration",
      text: "他说“走吧”：然后转身。",
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

  it("parses a ch exit cue", () => {
    expect(parseDslLine("ch suyao exit")).toEqual({
      kind: "character_cue",
      characterId: "suyao",
      action: "exit",
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
  // --- @ 前缀语法（2026-09-17：指令行一律以 @ 开头） ---

  it("parses every @ command form", () => {
    expect(parseDslLine("@bg basement")).toEqual({ kind: "background", assetId: "basement" });
    expect(parseDslLine("@bgm stop")).toEqual({ kind: "bgm", assetId: "stop" });
    expect(parseDslLine("@se terminal_beep")).toEqual({
      kind: "sound_effect",
      assetId: "terminal_beep",
    });
    expect(parseDslLine("@beat")).toEqual({ kind: "beat" });
    expect(parseDslLine("@/??".replace("??", "?"))).toEqual({ kind: "form_end" });
    expect(parseDslLine("@? 你打算怎么回应？")).toEqual({
      kind: "form_start",
      prompt: "你打算怎么回应？",
    });
    expect(parseDslLine("@+ 先退后一步")).toEqual({ kind: "form_option", text: "先退后一步" });
    expect(parseDslLine("@= 说出你想说的话")).toEqual({
      kind: "form_input",
      placeholder: "说出你想说的话",
    });
    expect(parseDslLine("@ch suyao:anxious left")).toEqual({
      kind: "character_cue",
      characterId: "suyao",
      variant: "anxious",
      position: "left",
      action: "set",
    });
    expect(parseDslLine("@ch suyao exit")).toEqual({
      kind: "character_cue",
      characterId: "suyao",
      action: "exit",
    });
  });

  it("tolerates spaces around the ch colon (frequent LLM slip)", () => {
    expect(parseDslLine("@ch raspberry: uneasy center")).toEqual({
      kind: "character_cue",
      characterId: "raspberry",
      variant: "uneasy",
      position: "center",
      action: "set",
    });
  });

  it("rejects a ch line whose variant slot holds Chinese dialogue", () => {
    // Observed failure: `@ch raspberry: 一句台词` — the model wanted a
    // dialogue line; the parser must fail loudly instead of emitting a cue
    // with a garbage variant.
    expectCode("@ch raspberry: 你到底藏了什么", "INVALID_CH_CUE");
    const err = (() => {
      try {
        parseDslLine("@ch raspberry: 你到底藏了什么");
      } catch (e) {
        return e as DslProtocolError;
      }
    })();
    expect(err?.detail?.cause).toContain("台词");
  });

  it("rejects an unrecognized @ line instead of degrading to narration", () => {
    // Historical incident: `@¬end 4607 buffer` (unrepaired mangle) played as
    // narration. @ now marks command intent — unknown forms must throw.
    expectCode("@¬end 4607 buffer", "UNKNOWN_COMMAND");
    expectCode("@6ch raspberry: uneasy center", "UNKNOWN_COMMAND");
    expectCode("@bmg relax", "UNKNOWN_COMMAND");
    expectCode("@", "UNKNOWN_COMMAND");
  });

  it("rejects an @-prefixed dialogue line with a targeted hint", () => {
    expectCode("@苏遥: 你不该来这里。", "UNKNOWN_COMMAND");
    const err = (() => {
      try {
        parseDslLine("@苏遥: 你不该来这里。");
      } catch (e) {
        return e as DslProtocolError;
      }
    })();
    expect(err?.detail?.cause).toContain("台词行不能以 @ 开头");
    expect(err?.detail?.fix).toContain("去掉行首的 @");
  });

  it("diagnoses swapped visual slots when the variant slot holds a registered id", () => {
    // Observed in the wild: `raspberry[raspberry|thinking]: …` — character id
    // in the variant slot, variant name in the position slot.
    const speakers = new Set(["raspberry"]);
    let caught: unknown;
    try {
      parseDslLine("raspberry[raspberry|thinking]: 那走吧。", speakers);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DslProtocolError);
    const err = caught as DslProtocolError;
    expect(err.code).toBe("INVALID_VISUAL_BRACKET");
    expect(err.detail?.cause).toContain("写反");
    expect(err.detail?.fix).toContain("去掉角色 id 槽");
  });

  it("keeps parsing legacy bare commands as aliases", () => {
    expect(parseDslLine("bg basement")).toEqual({ kind: "background", assetId: "basement" });
    expect(parseDslLine("beat")).toEqual({ kind: "beat" });
    expect(parseDslLine("/?")).toEqual({ kind: "form_end" });
    expect(parseDslLine("? 怎么回应？")).toEqual({ kind: "form_start", prompt: "怎么回应？" });
    expect(parseDslLine("ch suyao:anxious")).toEqual({
      kind: "character_cue",
      characterId: "suyao",
      variant: "anxious",
      action: "set",
    });
  });

  it("keeps narration starting with ascii letters that merely look wordy", () => {
    expect(parseDslLine("beatbox 声从隔壁传来。")).toEqual({
      kind: "narration",
      text: "beatbox 声从隔壁传来。",
    });
  });
});
