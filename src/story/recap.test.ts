import { describe, it, expect } from "vitest";
import { appendRecap, deterministicRecapDigest } from "./recap.js";
import type { StoredEvent } from "../schema.js";

function ev(seq: number, partial: Record<string, unknown>): StoredEvent {
  return {
    seq,
    turn: 1,
    timestamp: "2026-09-17T00:00:00.000Z",
    source: "model",
    ...partial,
  } as unknown as StoredEvent;
}

describe("deterministicRecapDigest", () => {
  it("keeps the decision skeleton (interactions + player lines) and the final text line", () => {
    const digest = deterministicRecapDigest([
      ev(1, { type: "narration", text: "旁白一。" }),
      ev(2, { type: "dialogue", speaker: "树莓娘", text: "要不先看看记录？" }),
      ev(3, { type: "interaction", prompt: "要不要打开值班记录看看？", mode: "choice" }),
      ev(4, { type: "choice", options: [] }),
      ev(5, { type: "player_choice", text: "先看维护记录" }),
      ev(6, { type: "narration", text: "维护记录上有一行昨天的维护。" }),
    ]);
    expect(digest).toContain("[交互] 要不要打开值班记录看看？");
    expect(digest).toContain("[玩家] 选择：先看维护记录");
    expect(digest).not.toContain("旁白一。"); // 非收尾旁白不进摘要
    expect(digest.endsWith("维护记录上有一行昨天的维护。")).toBe(true);
  });

  it("returns empty for machine-only events", () => {
    expect(
      deterministicRecapDigest([ev(1, { type: "choice", options: [] }), ev(2, { type: "end" })]),
    ).toBe("");
  });
});

describe("appendRecap", () => {
  it("appends a new line to a previous recap", () => {
    expect(appendRecap("第一段。", "第二段。")).toBe("第一段。\n第二段。");
  });

  it("treats an empty previous recap as a fresh start", () => {
    expect(appendRecap("", "第一段。")).toBe("第一段。");
  });

  it("drops whole oldest lines past the cap and marks the truncation", () => {
    const previous = "一。\n二。\n三。";
    // 超限时保守地从行边界截：最老的记录被整行丢弃，截断以 "…" 标记。
    const next = appendRecap(previous, "四。", 8);
    expect(next.startsWith("…")).toBe(true);
    expect(next).not.toContain("一。");
    expect(next).toContain("三。");
    expect(next.endsWith("四。")).toBe(true);
  });
});
