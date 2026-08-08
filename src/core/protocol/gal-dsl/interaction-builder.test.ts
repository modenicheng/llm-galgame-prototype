import { describe, it, expect } from "vitest";
import { InteractionBuilder } from "./interaction-builder.js";
import { DslProtocolError } from "./types.js";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected DslProtocolError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DslProtocolError);
    expect((error as DslProtocolError).code).toBe(code);
  }
}

describe("InteractionBuilder", () => {
  it("derives mode choice from options only", () => {
    const builder = new InteractionBuilder();
    builder.start(" 怎么回应？ ");
    builder.addOption(" 追问她 ");
    builder.addOption("暂时停手");
    const draft = builder.finish();
    expect(draft).toEqual({
      prompt: "怎么回应？",
      optionTexts: ["追问她", "暂时停手"],
      mode: "choice",
    });
    expect("inputPlaceholder" in draft).toBe(false);
  });

  it("derives mode input from an input field only", () => {
    const builder = new InteractionBuilder();
    builder.start("你准备对她说什么？");
    builder.setInput("输入你的回答……");
    const draft = builder.finish();
    expect(draft).toEqual({
      prompt: "你准备对她说什么？",
      optionTexts: [],
      inputPlaceholder: "输入你的回答……",
      mode: "input",
    });
  });

  it("derives mode hybrid from options plus input", () => {
    const builder = new InteractionBuilder();
    builder.start("怎么回应？");
    builder.addOption("相信她");
    builder.addOption("拒绝她");
    builder.setInput("说出自己的想法……");
    const draft = builder.finish();
    expect(draft).toEqual({
      prompt: "怎么回应？",
      optionTexts: ["相信她", "拒绝她"],
      inputPlaceholder: "说出自己的想法……",
      mode: "hybrid",
    });
  });

  it("rejects an empty form (no options, no input)", () => {
    const builder = new InteractionBuilder();
    builder.start("Q");
    expectCode(() => builder.finish(), "EMPTY_FORM");
  });

  it("rejects a second input field", () => {
    const builder = new InteractionBuilder();
    builder.start("Q");
    builder.setInput("A");
    expectCode(() => builder.setInput("B"), "MULTIPLE_INPUT_FIELDS");
  });

  it("rejects form lines outside a form", () => {
    const builder = new InteractionBuilder();
    expectCode(() => builder.addOption("A"), "FORM_LINE_OUTSIDE_FORM");
    expectCode(() => builder.setInput("A"), "FORM_LINE_OUTSIDE_FORM");
  });

  it("rejects /? without an open form", () => {
    const builder = new InteractionBuilder();
    expectCode(() => builder.finish(), "FORM_END_WITHOUT_OPEN");
  });

  it("rejects an empty form prompt", () => {
    const builder = new InteractionBuilder();
    expectCode(() => builder.start("   "), "EMPTY_FORM_PROMPT");
  });

  it("rejects empty option text", () => {
    const builder = new InteractionBuilder();
    builder.start("Q");
    expectCode(() => builder.addOption("  "), "EMPTY_OPTION_TEXT");
  });

  it("rejects an empty input placeholder", () => {
    const builder = new InteractionBuilder();
    builder.start("Q");
    expectCode(() => builder.setInput(""), "EMPTY_INPUT_PLACEHOLDER");
  });

  it("rejects starting a second form", () => {
    const builder = new InteractionBuilder();
    builder.start("Q");
    expectCode(() => builder.start("Q2"), "FORM_ALREADY_OPEN");
  });

  it("tracks open state", () => {
    const builder = new InteractionBuilder();
    expect(builder.isOpen()).toBe(false);
    builder.start("Q");
    expect(builder.isOpen()).toBe(true);
    builder.addOption("A");
    builder.finish();
    expect(builder.isOpen()).toBe(true); // finish() does not reset the form
  });
});
