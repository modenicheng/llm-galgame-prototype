/**
 * Tests for InteractionPolicy — the interaction-mode policy layer.
 *
 * The policy is a pure function of (config, interaction, previous modes):
 * it defends the interaction invariants at runtime even if the Zod schemas
 * are later loosened (plan §8.2–8.3, test coverage §14.4).
 */

import { describe, it, expect } from "vitest";
import { InteractionPolicy } from "./interaction-policy.js";

import type { InteractionPolicyConfig } from "../config.js";
import type { InteractionEvent, InteractionMode } from "./types.js";
import type { ChoiceEvent } from "../schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

const BASE_CONFIG: InteractionPolicyConfig = {
  allowed_modes: ["choice", "hybrid", "input"],
  default_mode: "hybrid",
  options: { min_count: 2, max_count: 5 },
  input: { max_length: 500, max_consecutive_pure_input: 1 },
  legacy_choice: { allow_runtime_compatibility: true, allow_model_output: false },
};

function makeConfig(overrides: DeepPartial<InteractionPolicyConfig> = {}): InteractionPolicyConfig {
  return {
    allowed_modes: overrides.allowed_modes ?? BASE_CONFIG.allowed_modes,
    default_mode: overrides.default_mode ?? BASE_CONFIG.default_mode,
    options: { ...BASE_CONFIG.options, ...overrides.options },
    input: { ...BASE_CONFIG.input, ...overrides.input },
    legacy_choice: { ...BASE_CONFIG.legacy_choice, ...overrides.legacy_choice },
  };
}

function state(previousModes: InteractionMode[]): { previousModes: InteractionMode[] } {
  return { previousModes };
}

const OPTIONS_2 = [
  { id: "a", text: "A" },
  { id: "b", text: "B" },
];

function choiceInteraction(options: Array<{ id: string; text: string }>): InteractionEvent {
  return {
    type: "interaction",
    interaction_id: "i-choice",
    prompt: "选择：",
    mode: "choice",
    options,
  };
}

function inputInteraction(maxLength = 100): InteractionEvent {
  return {
    type: "interaction",
    interaction_id: "i-input",
    prompt: "输入：",
    mode: "input",
    input: { kind: "free_text", placeholder: "…", max_length: maxLength },
    input_bridge: { events: [{ type: "narration", text: "桥接旁白。" }] },
  };
}

function hybridInteraction(): InteractionEvent {
  return {
    type: "interaction",
    interaction_id: "i-hybrid",
    prompt: "选择或输入：",
    mode: "hybrid",
    options: OPTIONS_2,
    input: { kind: "free_text", placeholder: "…", max_length: 100 },
    input_bridge: { events: [{ type: "narration", text: "桥接旁白。" }] },
  };
}

function legacyChoiceEvent(options: Array<{ id: string; text: string }>): ChoiceEvent {
  return { type: "choice", prompt: "请选择：", options };
}

// ---------------------------------------------------------------------------
// InteractionPolicy — §14.4 cases
// ---------------------------------------------------------------------------

describe("InteractionPolicy", () => {
  it("allowed_modes 不含 input → 拒绝 input", () => {
    const policy = new InteractionPolicy(makeConfig({ allowed_modes: ["choice", "hybrid"] }));

    const result = policy.validate(inputInteraction(), state([]));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("default_mode 不参与单次校验", () => {
    // default_mode 只是配置默认值，不得强制或拒绝单次交互。
    const policy = new InteractionPolicy(makeConfig({ default_mode: "input" }));

    const result = policy.validate(choiceInteraction(OPTIONS_2), state([]));

    expect(result.accepted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("配置 max options=3，模型输出 4 → 拒绝", () => {
    const policy = new InteractionPolicy(makeConfig({ options: { min_count: 2, max_count: 3 } }));

    const result = policy.validate(
      choiceInteraction([
        { id: "a", text: "A" },
        { id: "b", text: "B" },
        { id: "c", text: "C" },
        { id: "d", text: "D" },
      ]),
      state([]),
    );

    expect(result.accepted).toBe(false);
  });

  it("连续纯 input 超限 → 拒绝", () => {
    const policy = new InteractionPolicy(makeConfig()); // max_consecutive_pure_input: 1

    const result = policy.validate(inputInteraction(), state(["input"]));

    expect(result.accepted).toBe(false);
  });

  it("hybrid 不计作纯 input", () => {
    const policy = new InteractionPolicy(makeConfig());

    const result = policy.validate(hybridInteraction(), state(["input", "input"]));

    expect(result.accepted).toBe(true);
  });

  it("choice 重置连续纯 input", () => {
    const policy = new InteractionPolicy(makeConfig());

    const result = policy.validate(inputInteraction(), state(["input", "input", "choice"]));

    expect(result.accepted).toBe(true);
  });

  it("旧式 choice 归一化为 choice", () => {
    const policy = new InteractionPolicy(makeConfig());

    // 即使前面连续两次纯 input，旧式 choice 也按 choice 处理（重置纯 input 计数）。
    const result = policy.validate(
      legacyChoiceEvent(OPTIONS_2),
      state(["input", "input"]),
    );

    expect(result.accepted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 其余 §8.3 校验（§14.4 之外的行为保障）
  // -----------------------------------------------------------------------

  it("选项 ID 重复 → 拒绝", () => {
    const policy = new InteractionPolicy(makeConfig());

    const result = policy.validate(
      choiceInteraction([
        { id: "a", text: "A" },
        { id: "a", text: "A 重复" },
      ]),
      state([]),
    );

    expect(result.accepted).toBe(false);
  });

  it("input.max_length 超过配置上限 → 拒绝", () => {
    const policy = new InteractionPolicy(makeConfig()); // max_length: 500

    const result = policy.validate(inputInteraction(501), state([]));

    expect(result.accepted).toBe(false);
  });

  it("choice 错误携带 input 字段 → 拒绝（防 Schema 改动绕过）", () => {
    const policy = new InteractionPolicy(makeConfig());

    const malformed = {
      ...choiceInteraction(OPTIONS_2),
      input: { kind: "free_text", placeholder: "…", max_length: 100 },
    } as unknown as InteractionEvent;

    expect(policy.validate(malformed, state([])).accepted).toBe(false);
  });

  it("choice 错误携带 input_bridge 字段 → 拒绝（防 Schema 改动绕过）", () => {
    const policy = new InteractionPolicy(makeConfig());

    const malformed = {
      ...choiceInteraction(OPTIONS_2),
      input_bridge: { events: [{ type: "narration", text: "她等着。" }] },
    } as unknown as InteractionEvent;

    const result = policy.validate(malformed, state([]));
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("bridge");
  });

  it("input 错误携带 options 字段 → 拒绝（防 Schema 改动绕过）", () => {
    const policy = new InteractionPolicy(makeConfig());

    const malformed = {
      ...inputInteraction(),
      options: OPTIONS_2,
    } as unknown as InteractionEvent;

    expect(policy.validate(malformed, state([])).accepted).toBe(false);
  });

  it("input 缺少合法 Bridge → 拒绝", () => {
    const policy = new InteractionPolicy(makeConfig());

    const withoutBridge = {
      type: "interaction" as const,
      interaction_id: "i-input",
      prompt: "输入：",
      mode: "input" as const,
      input: { kind: "free_text" as const, placeholder: "…", max_length: 100 },
    } as unknown as InteractionEvent;

    expect(policy.validate(withoutBridge, state([])).accepted).toBe(false);
  });

  it("旧式 choice 同样受选项数限制", () => {
    const policy = new InteractionPolicy(makeConfig({ options: { min_count: 2, max_count: 3 } }));

    const result = policy.validate(
      legacyChoiceEvent([
        { id: "a", text: "A" },
        { id: "b", text: "B" },
        { id: "c", text: "C" },
        { id: "d", text: "D" },
      ]),
      state([]),
    );

    expect(result.accepted).toBe(false);
  });
});
