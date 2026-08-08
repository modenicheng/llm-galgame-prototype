/**
 * Tests for the whole-text DSL pipeline (parseDslSegmentText).
 * Acceptance scenario from docs/llm-outputs-refactor.md §110.
 */

import { describe, it, expect } from "vitest";
import { parseDslSegmentText } from "./text-pipeline.js";
import { DslProtocolError } from "./types.js";

const ACCEPTANCE_TEXT = [
  "bg basement",
  "",
  "地下室里只亮着终端的一点蓝光。",
  "",
  "苏遥[normal|left](神秘女子): 你不该来这里。",
  "",
  "苏遥[anxious]: 别碰那台机器。",
  "",
  "? 怎么回应？",
  "+ 追问她为什么知道机器仍能运行",
  "+ 暂时停手",
  "= 或说出自己的回答……",
  "/?",
  "",
  "@end a81f interaction",
].join("\n");

function expectDslCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected DslProtocolError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DslProtocolError);
    expect((error as DslProtocolError).code).toBe(code);
  }
}

describe("parseDslSegmentText", () => {
  it("parses the §110 acceptance scenario end-to-end", () => {
    const result = parseDslSegmentText(ACCEPTANCE_TEXT, {
      expectedNonce: "a81f",
      allowedReasons: ["buffer", "interaction", "ending"],
    });

    expect(result.status).toEqual({
      kind: "complete",
      nonce: "a81f",
      reason: "interaction",
    });
    expect(result.groups).toHaveLength(4);

    // 1. bg basement → background cue + narration main in one group.
    const group0 = result.groups[0]!;
    expect(group0.prelude).toEqual([{ type: "background", assetId: "basement" }]);
    expect(group0.main).toEqual({ type: "narration", text: "地下室里只亮着终端的一点蓝光。" });

    // 2. 苏遥[normal|left](神秘女子) → dialogue with visual + name specs.
    const group1 = result.groups[1]!;
    expect(group1.main).toMatchObject({
      type: "dialogue",
      speaker: "苏遥",
      text: "你不该来这里。",
      visual: {
        hasVisual: true,
        resetVisual: false,
        variant: "normal",
        position: "left",
      },
      name: { hasName: true, resetName: false, displayName: "神秘女子" },
    });

    // 3. 苏遥[anxious] → variant-only visual override.
    const group2 = result.groups[2]!;
    expect(group2.main).toMatchObject({
      type: "dialogue",
      speaker: "苏遥",
      text: "别碰那台机器。",
      visual: { hasVisual: true, variant: "anxious" },
    });

    // 4. Form → hybrid interaction draft.
    const group3 = result.groups[3]!;
    expect(group3.main).toEqual({
      type: "interaction",
      interaction: {
        prompt: "怎么回应？",
        optionTexts: ["追问她为什么知道机器仍能运行", "暂时停手"],
        inputPlaceholder: "或说出自己的回答……",
        mode: "hybrid",
      },
    });
  });

  it("rejects a sentinel with the wrong nonce", () => {
    expectDslCode(
      () =>
        parseDslSegmentText("地下室里只亮着终端的一点蓝光。\n@end a81f buffer", {
          expectedNonce: "bbbb",
          allowedReasons: ["buffer"],
        }),
      "SENTINEL_NONCE_MISMATCH",
    );
  });

  it("returns incomplete when the @end sentinel is missing", () => {
    const result = parseDslSegmentText("地下室里只亮着终端的一点蓝光。\n苏遥: 别碰那台机器。", {
      expectedNonce: "a81f",
      allowedReasons: ["buffer", "interaction", "ending"],
    });

    expect(result.status).toEqual({ kind: "incomplete" });
    expect(result.groups).toHaveLength(2);
  });

  it("strips a markdown fence around the payload", () => {
    const fenced = `\`\`\`\n${ACCEPTANCE_TEXT}\n\`\`\``;
    const result = parseDslSegmentText(fenced, {
      expectedNonce: "a81f",
      allowedReasons: ["buffer", "interaction", "ending"],
    });

    expect(result.status).toEqual({ kind: "complete", nonce: "a81f", reason: "interaction" });
    expect(result.groups).toHaveLength(4);
  });

  it("rejects content after the @end sentinel", () => {
    expectDslCode(
      () =>
        parseDslSegmentText("苏遥: 别碰那台机器。\n@end a81f buffer\n苏遥: 不该出现", {
          expectedNonce: "a81f",
          allowedReasons: ["buffer"],
        }),
      "SENTINEL_NOT_LAST",
    );
  });
});
