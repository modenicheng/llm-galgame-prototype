import { describe, it, expect } from "vitest";
import { DslSegmentParser } from "./segment-validator.js";
import { DslProtocolError, type DslLine, type SegmentEndReason } from "./types.js";

/**
 * Tiny string→DslLine converter for the common test shapes (docs §101–§103).
 * The line parser is owned by another agent, so tests build DslLines directly.
 */
function line(text: string): DslLine {
  if (text.startsWith("@end ")) {
    const parts = text.split(" ");
    const nonce = parts[1] ?? "";
    const reason = (parts[2] ?? "") as SegmentEndReason;
    return { kind: "segment_end", nonce, reason };
  }
  if (text.startsWith("@ending")) {
    return { kind: "ending_epilogue", raw: text.slice("@ending".length).trim() };
  }
  if (text.startsWith("? ")) return { kind: "form_start", prompt: text.slice(2) };
  if (text.startsWith("+ ")) return { kind: "form_option", text: text.slice(2) };
  if (text.startsWith("= ")) return { kind: "form_input", placeholder: text.slice(2) };
  if (text.startsWith("bg ")) return { kind: "background", assetId: text.slice(3) };
  if (text.startsWith("bgm ")) return { kind: "bgm", assetId: text.slice(4) };
  const colon = text.indexOf(": ");
  if (colon > 0) {
    return {
      kind: "dialogue",
      speaker: text.slice(0, colon),
      text: text.slice(colon + 2),
      visual: { hasVisual: false, resetVisual: false },
      name: { hasName: false, resetName: false },
    };
  }
  return { kind: "narration", text };
}

function parser(expectedNonce = "a81f", allowedReasons: SegmentEndReason[] = ["buffer", "interaction", "ending"]) {
  return new DslSegmentParser({ expectedNonce, allowedReasons });
}

/** Expected dialogue main for a plain dialogue line built by line(). */
function dialogueMain(speaker: string, text: string) {
  return {
    type: "dialogue" as const,
    speaker,
    text,
    visual: { hasVisual: false, resetVisual: false },
    name: { hasName: false, resetName: false },
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected DslProtocolError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DslProtocolError);
    expect((error as DslProtocolError).code).toBe(code);
  }
}

describe("DslSegmentParser", () => {
  it("commits completed groups and drops the pending tail on truncation (§101)", () => {
    const p = parser();
    const emitted = p.pushLine(line("A: 第一行"));
    expect(emitted).toHaveLength(1);
    p.pushLine(line("bg station"));
    p.pushLine(line("bgm mystery"));

    const result = p.finish();
    expect(result.status).toEqual({ kind: "incomplete" });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.main).toEqual(dialogueMain("A", "第一行"));
  });

  it("never commits a truncated interaction (§102)", () => {
    const p = parser();
    p.pushLine(line("? 怎么回应？"));
    p.pushLine(line("+ A"));
    p.pushLine(line("= 输入……"));

    const result = p.finish();
    expect(result.status).toEqual({ kind: "incomplete" });
    expect(result.groups).toEqual([]);
  });

  it("can explicitly close a valid open form before an interaction sentinel", () => {
    const p = parser();
    p.pushLine(line("? 怎么回应？"));
    p.pushLine(line("+ 先看看纸片"));
    p.pushLine(line("= 你想说点什么"));

    expect(p.hasOpenInteraction()).toBe(true);
    const emitted = p.closeOpenInteraction();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.main).toMatchObject({
      type: "interaction",
      interaction: { prompt: "怎么回应？", mode: "hybrid" },
    });
    expect(p.hasOpenInteraction()).toBe(false);

    p.pushLine(line("@end a81f interaction"));
    expect(p.finish().status).toEqual({
      kind: "complete",
      nonce: "a81f",
      reason: "interaction",
    });
  });

  it("does not invent content for an invalid open form", () => {
    const p = parser();
    p.pushLine(line("? 怎么回应？"));
    expectCode(() => p.closeOpenInteraction(), "EMPTY_FORM");
  });

  it("rejects a buffer sentinel while a form is still open (no silent drop)", () => {
    const p = parser();
    p.pushLine(line("? 怎么回应？"));
    p.pushLine(line("+ 先看看纸片"));
    p.pushLine(line("= 你想说点什么"));
    expectCode(() => p.pushLine(line("@end a81f buffer")), "FORM_OPEN_AT_SENTINEL");
  });

  it("rejects an interaction sentinel while a form is still open (close first)", () => {
    const p = parser();
    p.pushLine(line("? 怎么回应？"));
    p.pushLine(line("+ 先看看纸片"));
    p.pushLine(line("= 你想说点什么"));
    expectCode(() => p.pushLine(line("@end a81f interaction")), "FORM_OPEN_AT_SENTINEL");
  });

  it("accepts a correct sentinel and marks the segment complete", () => {
    const p = parser();
    p.pushLine(line("A: 第一行"));
    const emitted = p.pushLine(line("@end a81f buffer"));
    expect(emitted).toEqual([]); // sentinel never reaches the group builder

    const result = p.finish();
    expect(result.status).toEqual({ kind: "complete", nonce: "a81f", reason: "buffer" });
    expect(result.groups).toHaveLength(1);
  });

  it("rejects a sentinel with the wrong nonce", () => {
    const p = parser();
    expectCode(() => p.pushLine(line("@end bbbb buffer")), "SENTINEL_NONCE_MISMATCH");
  });

  it("returns incomplete when no sentinel was seen", () => {
    const p = parser();
    p.pushLine(line("A: 第一行"));
    expect(p.finish().status).toEqual({ kind: "incomplete" });
  });

  it("rejects content after the sentinel (§103)", () => {
    const p = parser();
    p.pushLine(line("@end a81f buffer"));
    expectCode(() => p.pushLine(line("A: 不该出现")), "SENTINEL_NOT_LAST");
  });

  it("rejects a sentinel reason outside the allowed set", () => {
    const p = parser("a81f", ["buffer"]);
    expectCode(() => p.pushLine(line("@end a81f interaction")), "SENTINEL_INVALID_REASON");
  });

  it("rejects a duplicate sentinel", () => {
    const p = parser();
    p.pushLine(line("@end a81f buffer"));
    expectCode(() => p.pushLine(line("@end a81f ending")), "SENTINEL_DUPLICATE");
  });

  it("accepts each allowed sentinel reason", () => {
    for (const reason of ["buffer", "interaction", "ending"] as const) {
      const p = parser();
      p.pushLine(line(`@end a81f ${reason}`));
      expect(p.finish().status).toEqual({ kind: "complete", nonce: "a81f", reason });
    }
  });

  it("accumulates groups in order across multiple commits", () => {
    const p = parser();
    p.pushLine(line("A: 第一行"));
    p.pushLine(line("bg station"));
    p.pushLine(line("A: 第二行"));
    p.pushLine(line("bgm mystery"));
    p.pushLine(line("B: 第三行"));
    p.pushLine(line("@end a81f buffer"));
    const result = p.finish();
    expect(result.groups).toHaveLength(3);
    expect(result.groups[0]?.main).toEqual(dialogueMain("A", "第一行"));
    expect(result.groups[1]?.prelude).toEqual([{ type: "background", assetId: "station" }]);
    expect(result.groups[2]?.prelude).toEqual([{ type: "bgm", assetId: "mystery" }]);
  });
});

describe("DslSegmentParser ending epilogue", () => {
  it("captures the @ending line after an ending sentinel and attaches it in finish()", () => {
    const p = parser();
    p.pushLine(line("A: 故事的最后。"));
    p.pushLine(line("@end a81f ending"));
    p.pushLine(line("@ending HE 樱花与约定的终章"));
    const result = p.finish();
    expect(result.status).toEqual({
      kind: "complete",
      nonce: "a81f",
      reason: "ending",
      epilogue: { grade: "HE", title: "樱花与约定的终章" },
    });
  });

  it("accepts a bare @ending (both fields default downstream)", () => {
    const p = parser();
    p.pushLine(line("@end a81f ending"));
    p.pushLine(line("@ending"));
    expect(p.finish().status).toMatchObject({ kind: "complete", epilogue: {} });
  });

  it("ignores residue after the epilogue window closes without throwing", () => {
    const p = parser();
    p.pushLine(line("@end a81f ending"));
    p.pushLine(line("@ending NE 灯火熄灭的雨夜"));
    // 结尾词之后模型又续写了两行残留：窗口已关，静默丢弃。
    expect(p.pushLine(line("A: 不该播出的残留"))).toEqual([]);
    expect(p.pushLine(line("@end a81f buffer"))).toEqual([]);
    const result = p.finish();
    expect(result.status).toEqual({
      kind: "complete",
      nonce: "a81f",
      reason: "ending",
      epilogue: { grade: "NE", title: "灯火熄灭的雨夜" },
    });
  });

  it("closes the window on junk: a non-epilogue line after the ending sentinel is dropped", () => {
    const p = parser();
    p.pushLine(line("@end a81f ending"));
    expect(p.pushLine(line("A: 模型没停笔的残留"))).toEqual([]);
    // 窗口关闭后到达的 @ending 也不再捕获。
    p.pushLine(line("@ending HE 迟到的结尾词"));
    expect(p.finish().status).toEqual({ kind: "complete", nonce: "a81f", reason: "ending" });
  });

  it("keeps only the first @ending when the model writes two", () => {
    const p = parser();
    p.pushLine(line("@end a81f ending"));
    p.pushLine(line("@ending BE 走不出的雨夜"));
    p.pushLine(line("@ending HE 被覆盖的结局"));
    expect(p.finish().status).toEqual({
      kind: "complete",
      nonce: "a81f",
      reason: "ending",
      epilogue: { grade: "BE", title: "走不出的雨夜" },
    });
  });

  it("throws ENDING_EPILOGUE_ORPHAN when @ending appears before the sentinel", () => {
    const p = parser();
    p.pushLine(line("A: 正文"));
    expectCode(() => p.pushLine(line("@ending HE 过早的结局")), "ENDING_EPILOGUE_ORPHAN");
  });

  it("keeps SENTINEL_NOT_LAST strictness after a buffer sentinel even for @ending", () => {
    const p = parser();
    p.pushLine(line("@end a81f buffer"));
    expectCode(() => p.pushLine(line("@ending NE 不该出现的结尾词")), "SENTINEL_NOT_LAST");
  });

  it("reports isEndingSettled only once the window is done", () => {
    const p = parser();
    expect(p.isEndingSettled()).toBe(false);
    p.pushLine(line("@end a81f ending"));
    // 哨兵已到但模型可能还要写 @ending：窗口开着，不结算。
    expect(p.isEndingSettled()).toBe(false);
    p.pushLine(line("@ending HE 樱花与约定的终章"));
    expect(p.isEndingSettled()).toBe(true);
  });

  it("stays unsettled when the model stops right after the ending sentinel", () => {
    const p = parser();
    p.pushLine(line("@end a81f ending"));
    expect(p.isEndingSettled()).toBe(false);
    expect(p.finish().status).toEqual({ kind: "complete", nonce: "a81f", reason: "ending" });
  });
});
