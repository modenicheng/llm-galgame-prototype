/**
 * 演员运行时的 InteractionEvent → 契约表单快照映射。
 *
 * 选项文本即语义（运行时生成的 option id 不入契约）；prompt 原样保留，
 * 恢复路径（M1.4）据此重放表单。纯函数，无 IO。
 */
import type { InteractionEvent } from "../../schema.js";
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
