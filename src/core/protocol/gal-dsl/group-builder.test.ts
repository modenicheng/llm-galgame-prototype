import { describe, it, expect } from "vitest";
import { EventGroupBuilder } from "./group-builder.js";
import { DslProtocolError, type DslLine } from "./types.js";

/** Minimal well-formed dialogue line (no visual/name overrides). */
function dialogue(speaker: string, text: string): DslLine {
  return {
    kind: "dialogue",
    speaker,
    text,
    visual: { hasVisual: false, resetVisual: false },
    name: { hasName: false, resetName: false },
  };
}

/** Expected dialogue main for a plain dialogue line (no overrides). */
function dialogueMain(speaker: string, text: string) {
  return {
    type: "dialogue" as const,
    speaker,
    text,
    visual: { hasVisual: false, resetVisual: false },
    name: { hasName: false, resetName: false },
  };
}

function narration(text: string): DslLine {
  return { kind: "narration", text };
}

function chSet(characterId: string, variant: string, position?: "left" | "right"): DslLine {
  return { kind: "character_cue", characterId, variant, ...(position ? { position } : {}), action: "set" };
}

function chVisible(characterId: string, action: "show" | "hide"): DslLine {
  return { kind: "character_cue", characterId, action };
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

describe("EventGroupBuilder", () => {
  it("accumulates pending cues and flushes them with a dialogue", () => {
    const builder = new EventGroupBuilder();
    expect(builder.push({ kind: "background", assetId: "station" })).toEqual([]);
    expect(builder.push({ kind: "bgm", assetId: "mystery" })).toEqual([]);
    expect(builder.push(chSet("suyao", "anxious", "left"))).toEqual([]);

    const groups = builder.push(dialogue("苏遥", "等等，这里不对劲。"));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.prelude).toEqual([
      { type: "background", assetId: "station" },
      { type: "bgm", assetId: "mystery" },
      {
        type: "character_patch",
        character: "suyao",
        variant: { op: "set", value: "anxious" },
        position: { op: "set", value: "left" },
      },
    ]);
    expect(groups[0]?.main).toEqual(dialogueMain("苏遥", "等等，这里不对劲。"));
  });

  it("flushes dialogue and narration as separate groups", () => {
    const builder = new EventGroupBuilder();
    const d = builder.push(dialogue("苏遥", "你来了。"));
    const n = builder.push(narration("地下室没有开灯。"));
    expect(d).toHaveLength(1);
    expect(d[0]?.main).toEqual(dialogueMain("苏遥", "你来了。"));
    expect(n).toHaveLength(1);
    expect(n[0]?.prelude).toEqual([]);
    expect(n[0]?.main).toEqual({ type: "narration", text: "地下室没有开灯。" });
  });

  it("passes dialogue header visual/name specs through unchanged", () => {
    const builder = new EventGroupBuilder();
    const line: DslLine = {
      kind: "dialogue",
      speaker: "苏遥",
      text: "……",
      visual: { hasVisual: true, resetVisual: false, variant: "anxious", position: "left" },
      name: { hasName: true, resetName: false, displayName: "神秘女子" },
    };
    const groups = builder.push(line);
    expect(groups[0]?.main).toEqual({
      type: "dialogue",
      speaker: "苏遥",
      text: "……",
      visual: line.visual,
      name: line.name,
    });
    // Same object identity — passed through, not cloned.
    expect((groups[0]?.main as { visual: unknown }).visual).toBe(line.visual);
    expect((groups[0]?.main as { name: unknown }).name).toBe(line.name);
  });

  it("builds show/hide character patch cues", () => {
    const builder = new EventGroupBuilder();
    builder.push(chVisible("suyao", "show"));
    builder.push(chVisible("suyao", "hide"));
    const groups = builder.push(dialogue("苏遥", "……"));
    const prelude = groups[0]?.prelude ?? [];
    expect(prelude[0]).toEqual({
      type: "character_patch",
      character: "suyao",
      visible: { op: "set", value: true },
    });
    expect(prelude[1]).toEqual({
      type: "character_patch",
      character: "suyao",
      visible: { op: "set", value: false },
    });
  });

  it("builds a position-only set cue when variant is absent", () => {
    const builder = new EventGroupBuilder();
    builder.push({ kind: "character_cue", characterId: "suyao", position: "right", action: "set" });
    const groups = builder.push(dialogue("苏遥", "……"));
    expect(groups[0]?.prelude).toEqual([
      {
        type: "character_patch",
        character: "suyao",
        position: { op: "set", value: "right" },
      },
    ]);
  });

  it("flushes pending cues with a beat", () => {
    const builder = new EventGroupBuilder();
    builder.push({ kind: "sound_effect", assetId: "thud" });
    const groups = builder.push({ kind: "beat" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.prelude).toEqual([{ type: "sound_effect", assetId: "thud" }]);
    expect(groups[0]?.main).toEqual({ type: "beat" });
  });

  it("flushes pending cues with a completed form", () => {
    const builder = new EventGroupBuilder();
    builder.push({ kind: "background", assetId: "rooftop_night" });
    builder.push({ kind: "form_start", prompt: "怎么回答？" });
    builder.push({ kind: "form_option", text: "相信她" });
    builder.push({ kind: "form_input", placeholder: "说出自己的想法……" });
    const groups = builder.push({ kind: "form_end" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.prelude).toEqual([{ type: "background", assetId: "rooftop_night" }]);
    expect(groups[0]?.main).toEqual({
      type: "interaction",
      interaction: {
        prompt: "怎么回答？",
        optionTexts: ["相信她"],
        inputPlaceholder: "说出自己的想法……",
        mode: "hybrid",
      },
    });
  });

  it("rejects content inside an open form", () => {
    const builder = new EventGroupBuilder();
    builder.push({ kind: "form_start", prompt: "Q" });
    expectCode(() => builder.push(dialogue("苏遥", "喂")), "CONTENT_INSIDE_OPEN_FORM");
    expectCode(() => builder.push(narration("旁白")), "CONTENT_INSIDE_OPEN_FORM");
    expectCode(() => builder.push({ kind: "beat" }), "CONTENT_INSIDE_OPEN_FORM");
  });

  it("rejects a second open form", () => {
    const builder = new EventGroupBuilder();
    builder.push({ kind: "form_start", prompt: "Q" });
    expectCode(() => builder.push({ kind: "form_start", prompt: "Q2" }), "FORM_ALREADY_OPEN");
  });

  it("surfaces form-line errors from the interaction builder", () => {
    const builder = new EventGroupBuilder();
    expectCode(() => builder.push({ kind: "form_option", text: "A" }), "FORM_LINE_OUTSIDE_FORM");
    expectCode(() => builder.push({ kind: "form_input", placeholder: "A" }), "FORM_LINE_OUTSIDE_FORM");
    expectCode(() => builder.push({ kind: "form_end" }), "FORM_END_WITHOUT_OPEN");
  });

  it("finish() returns the pending tail and a derivable open form", () => {
    const builder = new EventGroupBuilder();
    builder.push({ kind: "background", assetId: "station" });
    builder.push({ kind: "form_start", prompt: "怎么回应？" });
    builder.push({ kind: "form_option", text: "A" });
    builder.push({ kind: "form_input", placeholder: "输入……" });
    const result = builder.finish();
    expect(result.pendingCues).toEqual([{ type: "background", assetId: "station" }]);
    expect(result.openInteraction).toEqual({
      prompt: "怎么回应？",
      optionTexts: ["A"],
      inputPlaceholder: "输入……",
      mode: "hybrid",
    });
  });

  it("finish() drops an underivable truncated form", () => {
    const builder = new EventGroupBuilder();
    builder.push({ kind: "form_start", prompt: "Q" });
    const result = builder.finish();
    expect(result.pendingCues).toEqual([]);
    expect(result.openInteraction).toBeNull();
  });

  it("finish() returns pending cues when no form is open", () => {
    const builder = new EventGroupBuilder();
    builder.push({ kind: "bgm", assetId: "mystery" });
    const result = builder.finish();
    expect(result.pendingCues).toEqual([{ type: "bgm", assetId: "mystery" }]);
    expect(result.openInteraction).toBeNull();
  });

  it("rejects segment_end defensively", () => {
    const builder = new EventGroupBuilder();
    expectCode(
      () => builder.push({ kind: "segment_end", nonce: "a81f", reason: "buffer" }),
      "UNKNOWN_LINE",
    );
  });
});
