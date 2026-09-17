/**
 * DSL tokenizer tests — the dashboard's highlighting layer must agree with
 * the core parser's classification (single source of grammar truth) and
 * slice every line kind without losing characters.
 */
import { describe, expect, it } from "vitest";
import { renderDslLine } from "./dsl-tokens.js";

function joined(render: { tokens: { text: string }[] }): string {
  return render.tokens.map((token) => token.text).join("");
}

describe("renderDslLine", () => {
  it("classifies and preserves dialogue lines", () => {
    const render = renderDslLine("苏遥[smile](苏遥): 你来了。", new Set(["苏遥"]));
    expect(render.kind).toBe("dialogue");
    expect(render.error).toBeNull();
    expect(joined(render)).toBe("苏遥[smile](苏遥): 你来了。");
  });

  it("keeps the full-width colon line as narration when the speaker is unknown", () => {
    const render = renderDslLine("警告：危险", new Set(["苏遥"]));
    expect(render.kind).toBe("narration");
  });

  it("normalizes the full-width colon for registered speakers like the runtime", () => {
    const render = renderDslLine("苏遥：台词正文", new Set(["苏遥"]));
    expect(render.kind).toBe("dialogue");
    expect(joined(render)).toBe("苏遥：台词正文");
  });

  it("classifies stage cues with the asset id separated", () => {
    const bg = renderDslLine("@bg classroom_day");
    expect(bg.kind).toBe("background");
    expect(bg.tokens.map((t) => t.cls)).toEqual(["kw", "dim", "id"]);

    const ch = renderDslLine("@ch female_A:smile center");
    expect(ch.kind).toBe("character_cue");
    expect(joined(ch)).toBe("@ch female_A:smile center");

    const hide = renderDslLine("@ch female_A hide");
    expect(hide.kind).toBe("character_cue");
    expect(joined(hide)).toBe("@ch female_A hide");
  });

  it("classifies interaction form lines", () => {
    expect(renderDslLine("@? 接下来做什么？").kind).toBe("form_start");
    expect(renderDslLine("@+ 去天台看看").kind).toBe("form_option");
    expect(renderDslLine("@= 我想说的是……").kind).toBe("form_input");
    expect(renderDslLine("@/?").kind).toBe("form_end");
  });

  it("flags an empty-prompt form as an error even though the line parses", () => {
    for (const raw of ["@?"]) {
      const render = renderDslLine(raw);
      expect(render.kind).toBe("form_start");
      expect(render.error).toContain("EMPTY_FORM_PROMPT");
    }
    expect(renderDslLine("@? 你打算怎么回应？").error).toBeNull();
  });

  it("classifies the segment-end sentinel and colors the ending reason", () => {
    const render = renderDslLine("@end ab12 ending");
    expect(render.kind).toBe("segment_end");
    expect(joined(render)).toBe("@end ab12 ending");
    expect(render.tokens[render.tokens.length - 1]!.cls).toBe("reason-ending");
  });

  it("dims markdown fences and reports parse errors without throwing", () => {
    const fence = renderDslLine("```gal");
    expect(fence.kind).toBeNull();
    expect(fence.tokens[0]!.cls).toBe("dim");

    const bad = renderDslLine("@bgx");
    expect(bad.kind).toBeNull();
    expect(bad.error).toContain("bg");
    expect(joined(bad)).toBe("@bgx");
  });

  it("treats plain prose as narration", () => {
    const render = renderDslLine("雨点敲在窗沿上。");
    expect(render.kind).toBe("narration");
    expect(render.tokens[0]!.cls).toBe("narr");
  });
});
