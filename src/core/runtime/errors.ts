/**
 * 演员运行时的公共错误契约。
 *
 * 宿主（CLI / web host）与组合根依赖这些类型来分辨关停/重启的展开路径；
 * 它们是管线词汇而非 Game 内部细节，独立成模块避免宿主为两个错误类型
 * import 整个 game.ts。
 */

/** Raised when the driver sends `shutdown`. */
export class RuntimeShutdownError extends Error {
  constructor() {
    super("运行时已收到关闭指令");
    this.name = "RuntimeShutdownError";
  }
}

/** Raised when the driver sends `restart_session` — the host rebuilds the runtime. */
export class RestartRequestedError extends Error {
  constructor() {
    super("运行时已收到重启指令");
    this.name = "RestartRequestedError";
  }
}

/** Raised when a generated interaction violates InteractionPolicy (§8.5). */
export class InteractionPolicyViolationError extends Error {
  constructor(reason: string) {
    super(`InteractionPolicy 拒绝：${reason}`);
    this.name = "InteractionPolicyViolationError";
  }
}
