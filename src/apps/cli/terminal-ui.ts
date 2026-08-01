import readline from "node:readline";
import type {
  ChoiceEvent,
  ChoiceOption,
  InteractionEvent,
  RuntimeDialogueEvent,
  RuntimeNarrationEvent,
  EndEvent
} from "../../schema.js";
import type { RuntimeStatusSnapshot } from "../../status.js";
import type { RuntimeStatus } from "../../status.js";

// ---------------------------------------------------------------------------
// GameUI interface — shared contract for the CLI terminal UI
//
// @deprecated Migration layer: a later phase replaces this blocking callback
// interface with RuntimeCommand / RuntimeOutput, after which only
// CliController talks to the runtime and TerminalUI stays pure I/O.
// ---------------------------------------------------------------------------

export interface GameUI {
  printSession(sessionId: string, filePath: string): void;
  renderNarration(event: RuntimeNarrationEvent, status: RuntimeStatus): Promise<void>;
  renderDialogue(event: RuntimeDialogueEvent, status: RuntimeStatus): Promise<void>;
  renderEnd(event: EndEvent): void;
  choose(event: ChoiceEvent, status: RuntimeStatus): Promise<ChoiceOption>;
  inputEditor(
    interaction: InteractionEvent,
    initialText: string,
    status: RuntimeStatus
  ): Promise<{ action: "confirm" | "cancel"; text: string }>;
  inputPreview(
    text: string,
    interaction: InteractionEvent,
    status: RuntimeStatus,
    generatingResponse: boolean
  ): Promise<{ action: "confirm" | "cancel" }>;
  renderHybridInteraction(
    event: InteractionEvent & {
      options: NonNullable<InteractionEvent["options"]>;
      input: NonNullable<InteractionEvent["input"]>;
    },
    status: RuntimeStatus
  ): Promise<
    | { type: "choice"; optionId: string }
    | { type: "input"; text: string }
    | { type: "cancel" }
  >;
  waitForTask<T>(
    promise: Promise<T>,
    label: string,
    status: RuntimeStatus
  ): Promise<T>;
}

export class UserExitError extends Error {
  constructor() {
    super("用户退出游戏");
    this.name = "UserExitError";
  }
}

class LiveRegion {
  private renderedLines = 0;

  render(lines: string[]): void {
    const safeLines = lines.map((line) => this.truncate(line));
    if (!process.stdout.isTTY) return;

    if (this.renderedLines > 0) {
      process.stdout.write(`\x1b[${this.renderedLines}F`);
    }
    process.stdout.write("\x1b[J");
    process.stdout.write(`${safeLines.join("\n")}\n`);
    this.renderedLines = safeLines.length;
  }

  clear(): void {
    if (!process.stdout.isTTY || this.renderedLines === 0) return;
    process.stdout.write(`\x1b[${this.renderedLines}F`);
    process.stdout.write("\x1b[J");
    this.renderedLines = 0;
  }

  private truncate(line: string): string {
    const width = Math.max(40, (process.stdout.columns ?? 100) - 1);
    return line.length > width ? `${line.slice(0, width - 1)}…` : line;
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "queued":
      return "排队";
    case "running":
      return "生成中";
    case "ready":
      return "已就绪";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return state;
  }
}

function compactStatus(snapshot: RuntimeStatusSnapshot): string[] {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const activeJobs = Object.values(snapshot.jobs).filter(
    (job) => job.state === "running" || job.state === "queued" || job.state === "failed"
  );
  const jobText = activeJobs.length
    ? activeJobs
        .slice(0, 3)
        .map((job) => `${job.label}=${stateLabel(job.state)}`)
        .join("；")
    : "无后台文本任务";

  const media = snapshot.media;
  const mediaText = media.enabled
    ? `音频 ${media.readyAhead}/${media.targetAhead} 句就绪，生成 ${media.generating}，排队 ${media.queued}，分支已备 ${media.branchReady}`
    : `音频关闭，目标提前量 ${media.targetAhead}，补充阈值 ${media.refillThreshold}`;

  return [
    `[状态] ${snapshot.phase}：${snapshot.message}`,
    `[文本] 缓冲 ${snapshot.bufferedEvents} 条事件 / ${snapshot.bufferedDialogueLines} 条对白；${jobText}`,
    `[媒体] ${mediaText}`
  ].map(dim);
}

function branchBadge(snapshot: RuntimeStatusSnapshot, optionId: string): string {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const branch = snapshot.branches[optionId];
  if (!branch) return dim("未调度");
  if (branch.state === "ready") {
    return `\x1b[32m已就绪\x1b[0m ${branch.eventCount} 条/${branch.dialogueCount} 对白`;
  }
  if (branch.state === "failed") return `\x1b[31m预取失败\x1b[0m`;
  return dim(stateLabel(branch.state));
}

export class TerminalUI {
  constructor(private readonly showLineIds: boolean) {
    readline.emitKeypressEvents(process.stdin);
  }

  printSession(sessionId: string, filePath: string): void {
    console.log(`\x1b[2m会话已创建：${sessionId}\x1b[0m`);
    console.log(`\x1b[2m记录文件：${filePath}\x1b[0m`);
  }

  async renderNarration(event: RuntimeNarrationEvent, status: RuntimeStatus): Promise<void> {
    const id = this.showLineIds ? `\x1b[2m[${event.line_id}]\x1b[0m ` : "";
    console.log(`\n${id}${event.text}`);
    await this.waitForAdvance(status);
  }

  async renderDialogue(event: RuntimeDialogueEvent, status: RuntimeStatus): Promise<void> {
    const portrait = event.portrait
      ? `\x1b[2m [${event.portrait.character}/${event.portrait.expression}@${event.portrait.position}]\x1b[0m`
      : "";
    const id = this.showLineIds ? `\x1b[2m [${event.line_id}]\x1b[0m` : "";
    console.log(`\n\x1b[1m${event.speaker}\x1b[0m${portrait}${id}\n  ${event.text}`);
    await this.waitForAdvance(status);
  }

  renderEnd(event: EndEvent): void {
    console.log(`\n\x1b[2m=== ${event.ending_id} ===\x1b[0m\n${event.text}\n`);
  }

  /**
   * Read a line of text with proper IME support.
   *
   * Temporarily exits raw mode so the terminal driver handles
   * CJK composition correctly. Restores raw mode afterwards.
   */
  private async readLineWithIME(prompt: string): Promise<string> {
    const wasRaw = process.stdin.isRaw ?? false;

    return new Promise<string>((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });

      // Must exit raw mode for IME to work
      if (wasRaw && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }
      process.stdin.resume();

      rl.question(prompt, (answer) => {
        rl.close();
        // Restore raw mode before resolving so subsequent
        // waitForAdvance / choose calls work correctly
        if (wasRaw && process.stdin.setRawMode) {
          process.stdin.setRawMode(true);
        }
        resolve(answer);
      });
    });
  }

  /**
   * Phase 1: Line-based text editing with IME support.
   *
   * Enter confirms; typing "/cancel" or submitting an empty line
   * returns to the prompting stage. The simplified TUI editor does NOT
   * support inline cursor movement — use the Web UI for rich editing.
   */
  async inputEditor(
    interaction: InteractionEvent,
    initialText: string,
    status: RuntimeStatus
  ): Promise<{ action: "confirm" | "cancel"; text: string }> {
    this.ensureInteractive();

    const inputSpec = interaction.input!;
    const maxLength = inputSpec.max_length;

    // Print prompt + status (static, no live refresh while typing)
    const promptLines = interaction.prompt.split("\n");
    console.log("");
    for (const line of promptLines) console.log(line);

    const latest = status.snapshot();
    for (const s of compactStatus(latest)) console.log(s);

    const placeholder = initialText || `\x1b[2m${inputSpec.placeholder}\x1b[0m`;
    const prompt = `\x1b[36m▸ \x1b[0m`;
    console.log(`\x1b[2m最多 ${maxLength} 字，Enter 确认，留空取消\x1b[0m`);

    const raw = await this.readLineWithIME(prompt);
    const text = raw.slice(0, maxLength).trim();

    if (text.length === 0) {
      return { action: "cancel", text: "" };
    }

    return { action: "confirm", text };
  }

  /**
   * Phase 2: Preview confirmation.
   *
   * Shows the frozen text and waits for the player to either commit
   * (Enter) or go back to editing (Esc). Displays a spinner if the
   * NPC response is still being generated.
   */
  async inputPreview(
    text: string,
    interaction: InteractionEvent,
    status: RuntimeStatus,
    generatingResponse: boolean
  ): Promise<{ action: "confirm" | "cancel" }> {
    this.ensureInteractive();

    const region = new LiveRegion();
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    let latest = status.snapshot();

    const draw = (): void => {
      const genStatus = generatingResponse
        ? `${frames[frame % frames.length]} 正在生成 NPC 回应……`
        : `\x1b[32m✓ NPC 回应已就绪\x1b[0m`;

      region.render([
        "",
        "\x1b[1m你准备说：\x1b[0m",
        `\x1b[33m"${text}"\x1b[0m`,
        "",
        genStatus,
        "",
        "\x1b[2m[Enter] 确认发送  |  [Esc] 返回修改\x1b[0m",
        ...compactStatus(latest),
      ]);
    };

    const unsubscribe = status.subscribe((snapshot) => {
      latest = snapshot;
      draw();
    });

    const timer = setInterval(() => {
      frame += 1;
      draw();
    }, 90);
    draw();

    try {
      const result = await this.readKeys((key) => {
        if (key.ctrl && key.name === "c") throw new UserExitError();
        if (key.name === "return" || key.name === "enter") {
          return { action: "confirm" as const };
        }
        if (key.name === "escape") {
          return { action: "cancel" as const };
        }
        return null;
      });

      region.clear();
      return result;
    } finally {
      clearInterval(timer);
      unsubscribe();
      region.clear();
    }
  }

  /**
   * Hybrid interaction: show numbered options AND a free text input field.
   *
   * Uses line-based readline so IME works. Type a number (1-9) + Enter
   * to pick an option, or type anything else + Enter to submit free text.
   */
  async renderHybridInteraction(
    event: InteractionEvent & { options: NonNullable<InteractionEvent["options"]>; input: NonNullable<InteractionEvent["input"]> },
    status: RuntimeStatus
  ): Promise<
    | { type: "choice"; optionId: string }
    | { type: "input"; text: string }
    | { type: "cancel" }
  > {
    this.ensureInteractive();

    const options = event.options;
    const inputSpec = event.input;
    const maxLength = inputSpec.max_length;

    // Print prompt
    const promptLines = event.prompt.split("\n");
    console.log("");
    for (const line of promptLines) console.log(line);

    // Print numbered options with prefetch badges
    const latest = status.snapshot();
    for (let i = 0; i < Math.min(9, options.length); i++) {
      const opt = options[i]!;
      const badge = branchBadge(latest, opt.id);
      console.log(`  \x1b[1m[${i + 1}]\x1b[0m ${opt.text}  \x1b[2m[${badge}]\x1b[0m`);
    }

    // Status
    for (const s of compactStatus(latest)) console.log(s);
    console.log(
      `\x1b[2m[1-${Math.min(9, options.length)}] 选择选项  |  其他任意文字 Enter 发送  |  留空取消\x1b[0m`
    );

    const raw = await this.readLineWithIME(`\x1b[36m▸ \x1b[0m`);
    const text = raw.trim();

    if (text.length === 0) {
      return { type: "cancel" };
    }

    // Check if input is a number → option selection
    const numMatch = /^[1-9]$/.exec(text);
    if (numMatch) {
      const num = parseInt(numMatch[0], 10);
      if (num <= options.length) {
        return { type: "choice", optionId: options[num - 1]!.id };
      }
    }

    return { type: "input", text: text.slice(0, maxLength) };
  }

  async choose(event: ChoiceEvent, status: RuntimeStatus): Promise<ChoiceOption> {
    this.ensureInteractive();
    const region = new LiveRegion();
    let selectedIndex = 0;
    let latest = status.snapshot();

    const draw = (): void => {
      const optionLines = event.options.map((option, index) => {
        const cursor = index === selectedIndex ? "❯" : " ";
        return `${cursor} ${option.text}  [${branchBadge(latest, option.id)}]`;
      });
      region.render([
        "",
        event.prompt,
        ...optionLines,
        ...compactStatus(latest),
        "\x1b[2m↑/↓ 选择，Enter 确认，Ctrl+C 退出\x1b[0m"
      ]);
    };

    const unsubscribe = status.subscribe((snapshot) => {
      latest = snapshot;
      draw();
    });
    draw();

    try {
      const selected = await this.readKeys((key) => {
        if (key.ctrl && key.name === "c") throw new UserExitError();
        if (key.name === "up") {
          selectedIndex = (selectedIndex - 1 + event.options.length) % event.options.length;
          draw();
          return null;
        }
        if (key.name === "down") {
          selectedIndex = (selectedIndex + 1) % event.options.length;
          draw();
          return null;
        }
        if (key.name === "return" || key.name === "enter") {
          return event.options[selectedIndex] ?? null;
        }
        return null;
      });
      region.clear();
      return selected;
    } finally {
      unsubscribe();
      region.clear();
    }
  }

  async waitForTask<T>(
    promise: Promise<T>,
    label: string,
    status: RuntimeStatus
  ): Promise<T> {
    const region = new LiveRegion();
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    let latest = status.snapshot();

    const draw = (): void => {
      region.render([`\x1b[2m${frames[frame % frames.length]} ${label}\x1b[0m`, ...compactStatus(latest)]);
    };

    const unsubscribe = status.subscribe((snapshot) => {
      latest = snapshot;
      draw();
    });
    const timer = setInterval(() => {
      frame += 1;
      draw();
    }, 90);
    draw();

    try {
      return await promise;
    } finally {
      clearInterval(timer);
      unsubscribe();
      region.clear();
    }
  }

  private async waitForAdvance(status: RuntimeStatus): Promise<void> {
    this.ensureInteractive();
    const region = new LiveRegion();
    let latest = status.snapshot();
    const draw = (): void => {
      region.render([...compactStatus(latest), "\x1b[2mEnter/Space 下一句，Ctrl+C 退出\x1b[0m"]);
    };
    const unsubscribe = status.subscribe((snapshot) => {
      latest = snapshot;
      draw();
    });
    draw();

    try {
      await this.readKeys((key) => {
        if (key.ctrl && key.name === "c") throw new UserExitError();
        if (key.name === "return" || key.name === "enter" || key.name === "space") {
          return true;
        }
        return null;
      });
    } finally {
      unsubscribe();
      region.clear();
    }
  }

  private ensureInteractive(): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      throw new Error("当前 TUI 需要交互式终端运行。请直接执行 npm run dev。 ");
    }
  }

  private readKeys<T>(handler: (key: readline.Key) => T | null): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const stdin = process.stdin;
      const previousRaw = stdin.isRaw;

      const cleanup = (): void => {
        stdin.off("keypress", onKeypress);
        if (stdin.setRawMode) stdin.setRawMode(Boolean(previousRaw));
        stdin.pause();
        process.stdout.write("\x1b[?25h");
      };

      const onKeypress = (_input: string, key: readline.Key): void => {
        try {
          const result = handler(key);
          if (result !== null) {
            cleanup();
            resolve(result);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };

      process.stdout.write("\x1b[?25l");
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on("keypress", onKeypress);
    });
  }
}
