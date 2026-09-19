/**
 * 共享模板插值（C6，计划 §5.3）——双分支可移植，无产品线内容。
 *
 * 语义（契约向量 R03）：
 * - 单遍：按原模板逐占位符匹配一次，插入结果**绝不**再作为模板求值
 *   （值里出现的 `{var}`、`{nonce}` 是字面量）。
 * - 字面：callback 返回值走 String.replace 的字面替换路径——值里的
 *   `$&`、`$1` 等替换模式不生效，引号/换行/Markdown 章节头逐字落文。
 * - 显式失败：模板声明了（匹配变量语法）但调用方未提供的变量抛
 *   `UNKNOWN_TEMPLATE_VARIABLE:<name>`，不静默吞掉。
 * - 允许字面大括号的唯一非转义通道是**非变量格式**（大写/数字开头等
 *   不匹配 `[a-z][a-z0-9_]*` 的形态）；无转义约定，不悄悄吞未知变量。
 *
 * 配套 `declaredTemplateVariables` 供启动期检查：真实模板声明了哪些
 * 变量，直接读模板（不扫描插入结果中剩余的 `{...}` 来猜错误）。
 */

/**
 * 按原模板单遍匹配，callback 字面替换（计划 §5.3 原文实现）。
 * 插入的文本不再被求值；`$&`/`{nonce}` 等字面内容保留。
 */
export function renderTemplate(
  template: string,
  vars: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{([a-z][a-z0-9_]*)\}/g, (token, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new Error(`UNKNOWN_TEMPLATE_VARIABLE:${key}`);
    }
    return String(vars[key]);
  });
}

/** 变量语法（与 renderTemplate 同一条正则，判定必须一致）。 */
const TEMPLATE_VARIABLE_PATTERN = /\{([a-z][a-z0-9_]*)\}/g;

/**
 * 模板声明的变量名（去重、按首次出现保序）。启动期用它把「模板声明」
 * 与「调用方已知变量表」对照——不通过扫描插入结果判断错误。
 */
export function declaredTemplateVariables(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    const name = match[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * 启动期检查：`template`（来自 `source` 的真实模板）声明的每个变量都
 * 必须在 `known` 内。发现未知声明抛错并点名来源与变量——配置错误在
 * 启动时炸掉，而不是等到生成请求静默漏替换。
 */
export function assertKnownTemplateVariables(
  source: string,
  template: string,
  known: readonly string[],
): void {
  const knownSet = new Set(known);
  const unknown = declaredTemplateVariables(template).filter((name) => !knownSet.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `${source} 声明了未知模板变量 {${unknown.join("}、{")}}；已知变量：${[...knownSet].join("、")}`,
    );
  }
}
