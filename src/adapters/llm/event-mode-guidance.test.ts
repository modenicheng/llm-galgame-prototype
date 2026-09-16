/**
 * Pins the tiered event-mode guidance semantics (audit 2026-09-17 #3):
 * L1 (wrapup) must stay a SOFT prompt — the hard "no more interaction
 * forms / must @end" wording belongs to L2 (closing) and L3
 * (endingRequired) only. Softening L1 keeps the ending landing anywhere in
 * the wrapup→closing window instead of always at wrapup+1.
 */
import { describe, expect, it } from "vitest";
import { appendEventModeGuidance } from "./openai-compatible-generator.js";

const NONCE = "ab12";

describe("appendEventModeGuidance — tier separation", () => {
  it("L1 wrapup (count ≤ target) softly steers toward wrap-up without forbidding forms", () => {
    const text = appendEventModeGuidance("", NONCE, {
      endingPhase: "wrapup",
      interactionProgress: { count: 6, target: 6 },
    });
    expect(text).toContain("收束阶段");
    expect(text).toContain("开始收拢");
    expect(text).not.toContain("不要打开任何交互表单");
    expect(text).not.toContain("不得打开新的交互表单");
    expect(text).not.toContain("必须");
  });

  it("L1 wrapup (count > target) escalates pace but still allows a genuinely needed closing form", () => {
    const text = appendEventModeGuidance("", NONCE, {
      endingPhase: "wrapup",
      interactionProgress: { count: 7, target: 6 },
    });
    expect(text).toContain("加快节奏");
    expect(text).toContain("除非收尾确实需要");
    // No unconditional hard stop at L1.
    expect(text).not.toContain("直接收拢当前线索");
  });

  it("L2 closing carries the hard stop wording", () => {
    const text = appendEventModeGuidance("", NONCE, { endingPhase: "closing" });
    expect(text).toContain("不要再打开新的交互表单");
    expect(text).toContain(`@end ${NONCE} ending`);
  });

  it("L3 endingRequired overrides everything with the mandatory ending", () => {
    const text = appendEventModeGuidance("", NONCE, {
      endingRequired: true,
      endingPhase: "closing",
    });
    expect(text).toContain("本段必须收束结局");
    expect(text).toContain("不得打开新的交互表单");
  });
});
