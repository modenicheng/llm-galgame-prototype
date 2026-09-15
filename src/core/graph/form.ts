/**
 * 演员运行时的 InteractionEvent ↔ 契约表单快照映射。
 *
 * 选项文本即语义（运行时生成的 option id 不入契约）；prompt 原样保留，
 * 恢复路径（M1.4）据此重放表单。纯函数，无 IO。
 */
import type { InteractionEvent } from "../../schema.js";
import type { InputSpec } from "../../story/types.js";
import type { InteractionFormSnapshot } from "./types.js";

export function formSnapshotFromInteraction(event: InteractionEvent): InteractionFormSnapshot {
  if (event.mode === "choice") {
    return { mode: "choice", prompt: event.prompt, options: event.options.map((o) => o.text) };
  }
  if (event.mode === "input") {
    return { mode: "input", prompt: event.prompt, placeholder: event.input.placeholder };
  }
  return {
    mode: "hybrid",
    prompt: event.prompt,
    options: event.options.map((o) => o.text),
    placeholder: event.input.placeholder,
  };
}

/**
 * 恢复重放（M1.4）：契约表单快照 → 运行时交互事件。运行时 id
 * （interaction/option）局部于本次运行、按运行时惯例重铸（interaction_N
 * 与 interaction_N_opt_M，与 buildRuntimeInteraction 同一形状，docs §30）；
 * 契约只保留语义（prompt/选项文本/输入提示语），input 的 kind/max_length
 * 不入契约、按默认重建。
 */
export function interactionFromFormSnapshot(
  form: InteractionFormSnapshot,
  interactionId: string,
): InteractionEvent {
  const optionId = (index: number) => `${interactionId}_opt_${index}`;
  if (form.mode === "choice") {
    return {
      type: "interaction",
      interaction_id: interactionId,
      prompt: form.prompt,
      mode: "choice",
      options: (form.options ?? []).map((text, index) => ({ id: optionId(index), text })),
    };
  }
  const input: InputSpec = {
    kind: "free_text",
    placeholder: form.placeholder ?? "请输入",
    max_length: 500,
  };
  if (form.mode === "input") {
    return {
      type: "interaction",
      interaction_id: interactionId,
      prompt: form.prompt,
      mode: "input",
      input,
    };
  }
  return {
    type: "interaction",
    interaction_id: interactionId,
    prompt: form.prompt,
    mode: "hybrid",
    options: (form.options ?? []).map((text, index) => ({ id: optionId(index), text })),
    input,
  };
}
