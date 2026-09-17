import {
  DslProtocolError,
  type DslInteractionDraft,
  type InteractionMode,
} from "./types.js";

/**
 * Accumulates a single form: opened by `@?`, fed by `@+` / `@=`, closed by
 * `@/?` (legacy bare `?`/`+`/`=`/`/?` aliases still parse) (docs §24–§28, §43). Mode is derived on finish() — the model never writes
 * it (docs §28). All texts are stored trimmed.
 */
export class InteractionBuilder {
  private prompt: string | null = null;
  private optionTexts: string[] = [];
  private inputPlaceholder: string | null = null;

  start(prompt: string): void {
    if (this.prompt !== null) {
      throw new DslProtocolError(
        "FORM_ALREADY_OPEN",
        "前一个交互表单还没有关闭，不能开新表单。",
        { expected: "表单以 @/? 结束后才能开始下一个 @?", fix: "先写 @/? 关闭当前表单" },
      );
    }
    const trimmed = prompt.trim();
    if (trimmed === "") {
      throw new DslProtocolError(
        "EMPTY_FORM_PROMPT",
        "交互表单的提示语不能为空。",
        {
          expected: "@? 之后必须紧跟一句完整的中文提示（问句或行动引导）",
          fix: '例如 "@? 你打算怎么回应？"',
        },
      );
    }
    this.prompt = trimmed;
    this.optionTexts = [];
    this.inputPlaceholder = null;
  }

  addOption(text: string): void {
    if (this.prompt === null) {
      throw new DslProtocolError(
        "FORM_LINE_OUTSIDE_FORM",
        "`@+` 选项行出现在表单之外。",
        { expected: "@+ 只能出现在 @? 表单内部", fix: "先写 @? <提示> 打开表单，再写 @+ 选项" },
      );
    }
    const trimmed = text.trim();
    if (trimmed === "") {
      throw new DslProtocolError(
        "EMPTY_OPTION_TEXT",
        "选项文本不能为空。",
        { expected: "@+ 之后必须写玩家的行动或台词", fix: '例如 "@+ 先退后一步，观察四周"' },
      );
    }
    this.optionTexts.push(trimmed);
  }

  setInput(placeholder: string): void {
    if (this.prompt === null) {
      throw new DslProtocolError(
        "FORM_LINE_OUTSIDE_FORM",
        "`@=` 输入行出现在表单之外。",
        { expected: "@= 只能出现在 @? 表单内部", fix: "先写 @? <提示> 打开表单，再写 @= <占位文本>" },
      );
    }
    if (this.inputPlaceholder !== null) {
      throw new DslProtocolError(
        "MULTIPLE_INPUT_FIELDS",
        "一个表单最多一个输入框，多写了 @= 行。",
        { fix: "删掉多余的 @= 行，只保留一个" },
      );
    }
    const trimmed = placeholder.trim();
    if (trimmed === "") {
      throw new DslProtocolError(
        "EMPTY_INPUT_PLACEHOLDER",
        "输入框占位文本不能为空。",
        { expected: "@= 之后必须写提示语", fix: '例如 "@= 说出你想说的话"' },
      );
    }
    this.inputPlaceholder = trimmed;
  }

  finish(): DslInteractionDraft {
    if (this.prompt === null) {
      throw new DslProtocolError(
        "FORM_END_WITHOUT_OPEN",
        "出现了没有打开表单的 @/?。",
        { expected: "@/? 只用来关闭已打开的表单", cause: "可能漏写了 @? 提示行，或多写了 @/?" },
      );
    }
    const hasOptions = this.optionTexts.length >= 1;
    const hasInput = this.inputPlaceholder !== null;
    let mode: InteractionMode;
    if (hasOptions && hasInput) {
      mode = "hybrid";
    } else if (hasOptions) {
      mode = "choice";
    } else if (hasInput) {
      mode = "input";
    } else {
      throw new DslProtocolError(
        "EMPTY_FORM",
        "表单是空的：既没有 @+ 选项也没有 @= 输入框。",
        { fix: "至少补一行 @+ <选项> 或 @= <占位文本>，再以 @/? 结束" },
      );
    }
    const draft: DslInteractionDraft = {
      prompt: this.prompt,
      optionTexts: this.optionTexts,
      mode,
      ...(this.inputPlaceholder !== null
        ? { inputPlaceholder: this.inputPlaceholder }
        : {}),
    };
    return draft;
  }

  isOpen(): boolean {
    return this.prompt !== null;
  }
}
