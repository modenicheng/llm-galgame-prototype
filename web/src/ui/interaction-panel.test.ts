/**
 * InteractionPanel DOM tests (§11.3, §11.4, §10.3, §11.5, §11.7).
 *
 * The unified choice/hybrid/input form: per-mode DOM visibility, the
 * one-shot submit lock, IME-safe keyboard handling and draft restore after
 * preview cancel.
 */
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildAppDom } from "./layout.js";
import { InteractionPanel } from "./interaction-panel.js";

const choiceInteraction = {
  type: "interaction",
  interaction_id: "int-choice",
  prompt: "如何选择？",
  mode: "choice",
  options: [
    { id: "a", text: "选项A" },
    { id: "b", text: "选项B" },
  ],
};

const hybridInteraction = {
  type: "interaction",
  interaction_id: "int-hybrid",
  prompt: "如何回应？",
  mode: "hybrid",
  options: [
    { id: "a", text: "选项A" },
    { id: "b", text: "选项B" },
  ],
  input: { kind: "free_text", placeholder: "你的回应……", max_length: 300 },
  input_bridge: { events: [{ type: "narration", text: "她等着。" }] },
};

const inputInteraction = {
  type: "interaction",
  interaction_id: "int-input",
  prompt: "说点什么",
  mode: "input",
  input: { kind: "free_text", placeholder: "写下你的回应……", max_length: 160 },
  input_bridge: { events: [{ type: "narration", text: "她等着。" }] },
};

interface Mounted {
  panel: InteractionPanel;
  root: HTMLElement;
  calls: { select: string[]; submit: string[] };
}

function mount(): Mounted {
  const root = document.createElement("div");
  const refs = buildAppDom(root);
  const calls = { select: [] as string[], submit: [] as string[] };
  const panel = new InteractionPanel(refs.interactionRoot, {
    onSelect: (optionId) => calls.select.push(optionId),
    onSubmit: (text) => calls.submit.push(text),
  });
  return { panel, root: refs.interactionRoot, calls };
}

function enter(field: HTMLTextAreaElement, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true, ...init });
  field.dispatchEvent(event);
  return event;
}

describe("InteractionPanel DOM (§11.3)", () => {
  it("choice: options visible, textarea and divider hidden", () => {
    const { panel, root } = mount();
    expect(panel.open(choiceInteraction)).toBe(true);
    expect(root.hasAttribute("hidden")).toBe(false);
    expect(root.querySelectorAll("button.choice")).toHaveLength(2);
    expect(
      (root.querySelector(".interaction-panel__input") as HTMLElement).hasAttribute("hidden"),
    ).toBe(true);
    expect(
      (root.querySelector(".interaction-panel__divider") as HTMLElement).hasAttribute("hidden"),
    ).toBe(true);
  });

  it("hybrid: options, textarea and divider visible; prompt rendered once", () => {
    const { panel, root } = mount();
    expect(panel.open(hybridInteraction)).toBe(true);
    expect(root.querySelectorAll("button.choice")).toHaveLength(2);
    expect(
      (root.querySelector(".interaction-panel__input") as HTMLElement).hasAttribute("hidden"),
    ).toBe(false);
    expect(
      (root.querySelector(".interaction-panel__divider") as HTMLElement).hasAttribute("hidden"),
    ).toBe(false);
    // Exactly one prompt anywhere in the panel — never one per sub-region.
    const prompts = root.querySelectorAll(
      ".interaction-panel__prompt, .choices__prompt, .input-panel__prompt",
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.textContent).toBe("如何回应？");
  });

  it("input: textarea visible, options and divider hidden", () => {
    const { panel, root } = mount();
    expect(panel.open(inputInteraction)).toBe(true);
    expect(root.querySelectorAll("button.choice")).toHaveLength(0);
    expect(
      (root.querySelector(".interaction-panel__choices") as HTMLElement).hasAttribute("hidden"),
    ).toBe(true);
    expect(
      (root.querySelector(".interaction-panel__divider") as HTMLElement).hasAttribute("hidden"),
    ).toBe(true);
    const field = root.querySelector("textarea") as HTMLTextAreaElement;
    expect(field.hasAttribute("hidden")).toBe(false);
    expect(field.placeholder).toBe("写下你的回应……");
    expect(field.maxLength).toBe(160);
  });

  it("open returns false for an unusable interaction", () => {
    const { panel } = mount();
    expect(panel.open(null)).toBe(false);
    expect(
      panel.open({ type: "interaction", interaction_id: "x", prompt: "?", mode: "bogus" }),
    ).toBe(false);
    expect(panel.open({ type: "choice", prompt: "?" })).toBe(false);
  });

  it("close hides the panel", () => {
    const { panel, root } = mount();
    panel.open(choiceInteraction);
    panel.close();
    expect(root.hasAttribute("hidden")).toBe(true);
  });
});

describe("submit lock (§10.3)", () => {
  it("after an option click every option and the textarea are disabled and further submits send nothing", () => {
    const { panel, root, calls } = mount();
    panel.open(hybridInteraction);
    const buttons = [...root.querySelectorAll("button.choice")] as HTMLButtonElement[];
    buttons[0]!.click();
    expect(calls.select).toEqual(["a"]);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    const field = root.querySelector("textarea") as HTMLTextAreaElement;
    expect(field.disabled).toBe(true);

    buttons[1]!.click();
    enter(field);
    expect(calls.select).toEqual(["a"]);
    expect(calls.submit).toEqual([]);
  });

  it("after an input submit every option and the textarea are disabled and option clicks send nothing", () => {
    const { panel, root, calls } = mount();
    panel.open(hybridInteraction);
    const field = root.querySelector("textarea") as HTMLTextAreaElement;
    field.value = "我自己来";
    enter(field);
    expect(calls.submit).toEqual(["我自己来"]);
    const buttons = [...root.querySelectorAll("button.choice")] as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(field.disabled).toBe(true);

    buttons[0]!.click();
    expect(calls.select).toEqual([]);
  });

  it("setSubmitting locks and unlocks the whole panel externally", () => {
    const { panel, root, calls } = mount();
    panel.open(hybridInteraction);
    const field = root.querySelector("textarea") as HTMLTextAreaElement;

    panel.setSubmitting(true);
    const buttons = [...root.querySelectorAll("button.choice")] as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(field.disabled).toBe(true);
    buttons[0]!.click();
    field.value = "x";
    enter(field);
    expect(calls.select).toEqual([]);
    expect(calls.submit).toEqual([]);

    panel.setSubmitting(false);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(field.disabled).toBe(false);
    buttons[0]!.click();
    expect(calls.select).toEqual(["a"]);
  });

  it("resets the lock and clears the draft on a new interaction open", () => {
    const { panel, root, calls } = mount();
    panel.open(hybridInteraction);
    const buttons = [...root.querySelectorAll("button.choice")] as HTMLButtonElement[];
    buttons[0]!.click();
    expect(buttons.every((button) => button.disabled)).toBe(true);

    panel.open(hybridInteraction);
    const freshButtons = [...root.querySelectorAll("button.choice")] as HTMLButtonElement[];
    expect(freshButtons.every((button) => !button.disabled)).toBe(true);
    const field = root.querySelector("textarea") as HTMLTextAreaElement;
    expect(field.disabled).toBe(false);
    expect(field.value).toBe("");
    expect(calls.select).toEqual(["a"]); // lock reset — old click not replayed
  });
});

describe("keyboard (§11.5)", () => {
  it("does not submit during IME composition (isComposing or keyCode 229)", () => {
    const { panel, root, calls } = mount();
    panel.open(inputInteraction);
    const field = root.querySelector("textarea") as HTMLTextAreaElement;
    field.value = "中文输入";

    const composing = enter(field, { isComposing: true });
    expect(calls.submit).toEqual([]);
    expect(composing.defaultPrevented).toBe(false);

    const legacy = enter(field, { keyCode: 229 });
    expect(calls.submit).toEqual([]);
    expect(legacy.defaultPrevented).toBe(false);
  });

  it("submits on a plain Enter and prevents the default", () => {
    const { panel, root, calls } = mount();
    panel.open(inputInteraction);
    const field = root.querySelector("textarea") as HTMLTextAreaElement;
    field.value = "hello";
    const event = enter(field);
    expect(calls.submit).toEqual(["hello"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets Shift+Enter insert a newline without submitting", () => {
    const { panel, root, calls } = mount();
    panel.open(inputInteraction);
    const field = root.querySelector("textarea") as HTMLTextAreaElement;
    field.value = "第一行";
    const event = enter(field, { shiftKey: true });
    expect(calls.submit).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("draft restore (§11.7)", () => {
  it("restores the hybrid form with the original text after preview cancel", () => {
    const { panel, root } = mount();
    panel.open(hybridInteraction);
    panel.restoreDraft("原稿");
    const buttons = [...root.querySelectorAll("button.choice")] as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(
      (root.querySelector(".interaction-panel__input") as HTMLElement).hasAttribute("hidden"),
    ).toBe(false);
    expect(
      (root.querySelector(".interaction-panel__divider") as HTMLElement).hasAttribute("hidden"),
    ).toBe(false);
    const field = root.querySelector("textarea") as HTMLTextAreaElement;
    expect(field.disabled).toBe(false);
    expect(field.value).toBe("原稿");
  });

  it("open clears the previous interaction's draft", () => {
    const { panel, root } = mount();
    panel.open(inputInteraction);
    const field = root.querySelector("textarea") as HTMLTextAreaElement;
    field.value = "A 的草稿";
    panel.open(inputInteraction); // a new interaction opens
    expect(field.value).toBe("");
  });
});
