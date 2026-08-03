/**
 * InteractionPolicy — runtime policy layer for interaction events.
 *
 * The Zod schemas in types.ts already enforce the structural shape of
 * interactions; this class defends the same invariants at runtime so a
 * future schema change cannot silently bypass them (plan §8.2–8.3).
 *
 * Input normalization: a legacy `ChoiceEvent` (src/schema.ts) is treated as
 * mode "choice" and runs through the same checks as a modern choice
 * interaction (plan §14.4: 旧式 choice 归一化为 choice).
 */

import type { InteractionEvent, InteractionMode, InputSpec } from "./types.js";
import type { ChoiceEvent } from "../schema.js";
import type { InteractionPolicyConfig } from "../config.js";

export interface InteractionPolicyState {
  previousModes: InteractionMode[];
}

export interface InteractionPolicyResult {
  accepted: boolean;
  reason?: string;
}

/** Normalized view of an interaction used by the checks below. */
interface PolicyCandidate {
  mode: InteractionMode;
  options?: readonly { id: string; text: string }[];
  input?: InputSpec;
  bridge?: unknown;
}

/**
 * Normalize an interaction event (or a legacy `ChoiceEvent`) into the
 * shape the checks operate on. Field presence is preserved so that
 * checks 6–8 can still detect schema-bypassing extra/missing fields.
 */
function toCandidate(interaction: InteractionEvent | ChoiceEvent): PolicyCandidate {
  if (interaction.type === "choice") {
    // 旧式 ChoiceEvent：归一化为 choice 模式。
    return { mode: "choice", options: interaction.options };
  }
  if (interaction.mode === "choice") {
    return { mode: "choice", options: interaction.options };
  }
  if (interaction.mode === "input") {
    return { mode: "input", input: interaction.input, bridge: interaction.input_bridge };
  }
  return {
    mode: "hybrid",
    options: interaction.options,
    input: interaction.input,
    bridge: interaction.input_bridge,
  };
}

/** A legal bridge carries 1–2 narration events (invariant 9). */
function isValidBridge(bridge: unknown): boolean {
  if (typeof bridge !== "object" || bridge === null) {
    return false;
  }
  const events = (bridge as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length < 1 || events.length > 2) {
    return false;
  }
  return events.every(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      (event as { type?: unknown }).type === "narration",
  );
}

export class InteractionPolicy {
  constructor(private readonly config: InteractionPolicyConfig) {}

  /** Validate an interaction against the policy. Checks run in §8.3 order. */
  validate(
    interaction: InteractionEvent | ChoiceEvent,
    state: InteractionPolicyState,
  ): InteractionPolicyResult {
    const { config } = this;
    const candidate = toCandidate(interaction);

    // 1. mode ∈ allowed_modes
    if (!config.allowed_modes.includes(candidate.mode)) {
      return {
        accepted: false,
        reason: `mode "${candidate.mode}" 不在 allowed_modes 中。`,
      };
    }

    // 2. choice/hybrid 选项数符合配置范围
    if (candidate.mode === "choice" || candidate.mode === "hybrid") {
      const count = candidate.options?.length ?? 0;
      if (count < config.options.min_count || count > config.options.max_count) {
        return {
          accepted: false,
          reason: `选项数 ${count} 超出配置范围 [${config.options.min_count}, ${config.options.max_count}]。`,
        };
      }
    }

    // 3. 选项 ID 唯一
    if (candidate.options) {
      const seen = new Set<string>();
      for (const option of candidate.options) {
        if (seen.has(option.id)) {
          return { accepted: false, reason: `选项 ID 重复：${option.id}。` };
        }
        seen.add(option.id);
      }
    }

    // 4. input.max_length 不超过配置上限
    if (candidate.input !== undefined && candidate.input.max_length > config.input.max_length) {
      return {
        accepted: false,
        reason: `input.max_length ${candidate.input.max_length} 超过配置上限 ${config.input.max_length}。`,
      };
    }

    // 5. 连续纯 input 不超过限制（choice/hybrid 中断计数）
    if (candidate.mode === "input") {
      let consecutive = 0;
      for (
        let i = state.previousModes.length - 1;
        i >= 0 && state.previousModes[i] === "input";
        i--
      ) {
        consecutive++;
      }
      if (consecutive + 1 > config.input.max_consecutive_pure_input) {
        return {
          accepted: false,
          reason: `连续纯 input（${consecutive + 1} 次）超过限制 ${config.input.max_consecutive_pure_input}。`,
        };
      }
    }

    // 6. choice 不得错误携带 input / input_bridge 字段
    if (
      candidate.mode === "choice" &&
      ("input" in interaction || "input_bridge" in interaction)
    ) {
      return { accepted: false, reason: "choice 不得携带 input / input_bridge 字段。" };
    }

    // 7. input 不得错误携带 options 字段
    if (candidate.mode === "input" && "options" in interaction) {
      return { accepted: false, reason: "input 不得携带 options 字段。" };
    }

    // 8. input/hybrid 必须携带合法 Bridge
    if (candidate.mode === "input" || candidate.mode === "hybrid") {
      if (!isValidBridge(candidate.bridge)) {
        return {
          accepted: false,
          reason: "input/hybrid 必须携带合法 input_bridge（1–2 条 narration）。",
        };
      }
    }

    return { accepted: true };
  }
}
