import readline from "node:readline";
import type {
  ChoiceEvent,
  ChoiceOption,
  HybridInteraction,
  InputInteraction,
  RuntimeDialogueEvent,
  RuntimeNarrationEvent,
  EndEvent,
} from "../../schema.js";
import type { RuntimeStatusSnapshot } from "../../status.js";

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

function compactStatus(snapshot: RuntimeStatusSnapshot | null): string[] {
  if (!snapshot) return [];
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

function branchBadge(snapshot: RuntimeStatusSnapshot | null, optionId: string): string {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const branch = snapshot?.branches[optionId];
  if (!branch) return dim("未调度");
  if (branch.state === "ready") {
    return `\x1b[32m已就绪\x1b[0m ${branch.eventCount} 条/${branch.dialogueCount} 对白`;
  }
  if (branch.state === "failed") return `\x1b[31m预取失败\x1b[0m`;
  return dim(stateLabel(branch.state));
}

/**
 * Pure I/O terminal UI.
 *
 * Owns no runtime state and never calls the generator, store, or
 * scheduler. The CliController feeds status snapshots via `setStatus`
 * and converts key/line input into RuntimeCommands.
 */
export class TerminalUI {
  private latestStatus: RuntimeStatusSnapshot | null = null;
  private readonly statusListeners = new Set<(snapshot: RuntimeStatusSnapshot) => void>();

  constructor(private readonly showLineIds: boolean) {
    readline.emitKeypressEvents(process.stdin);
  }

  /** Feed the latest runtime status snapshot (from status_changed outputs). */
  setStatus(snapshot: RuntimeStatusSnapshot): void {
    this.latestStatus = snapshot;
    for (const listener of this.statusListeners) listener(snapshot);
  }

  getStatus(): RuntimeStatusSnapshot | null {
    return this.latestStatus;
  }

  onStatusChange(listener: (snapshot: RuntimeStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  printSession(sessionId: string, location: string): void {
    console.log(`\x1b[2m会话已创建：${sessionId}\x1b[0m`);
    console.log(`\x1b[2m记录文件：${location}\x1b[0m`);
  }

  renderNarration(event: RuntimeNarrationEvent): void {
    const id = this.showLineIds ? `\x1b[2m[${event.line_id}]\x1b[0m ` : "";
    console.log(`\n${id}${event.text}`);
  }

  renderDialogue(event: RuntimeDialogueEvent): void {
    const portrait = event.portrait
      ? `\x1b[2m [${event.portrait.character}/${event.portrait.expression}@${event.portrait.position}]\x1b[0m`
      : "";
    const id = this.showLineIds ? `\x1b[2m [${event.line_id}]\x1b[0m` : "";
    console.log(`\n\x1b[1m${event.speaker}\x1b[0m${portrait}${id}\n  ${event.text}`);
  }

  renderEnd(event: EndEvent): void {
    console.log(`\n\x1b[2m=== ${event.ending_id} ===\x1b[0m\n${event.text}\n`);
  }

  renderError(message: string): void {
    console.error(`\n\x1b[31m[错误] ${message}\x1b[0m`);
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
   * Line-based text editing with IME support. Enter confirms; an empty
   * line returns to the prompting stage. The simplified editor does NOT
   * support inline cursor movement.
   */
  async inputEditor(
    interaction: InputInteraction,
  ): Promise<{ action: "confirm" | "cancel"; text: string }> {
    this.ensureInteractive();

    const inputSpec = interaction.input;
    const maxLength = inputSpec.max_length;

    // Print prompt + status (static, no live refresh while typing)
    const promptLines = interaction.prompt.split("\n");
    console.log("");
    for (const line of promptLines) console.log(line);
    for (const s of compactStatus(this.latestStatus)) console.log(s);

    const placeholder = `\x1b[2m${inputSpec.placeholder}\x1b[0m`;
    const prompt = `\x1b[36m▸ \x1b[0m`;
    console.log(`\x1b[2m最多 ${maxLength} 字，Enter 确认，留空取消\x1b[0m`);

    const raw = await this.readLineWithIME(`${placeholder}\n${prompt}`);
    const text = raw.slice(0, maxLength).trim();

    if (text.length === 0) {
      return { action: "cancel", text: "" };
    }

    return { action: "confirm", text };
  }

  /**
   * Preview confirmation: shows the frozen text and waits for Enter
   * (commit) or Esc (back to editing). A spinner runs while the NPC
   * response is still being generated.
   */
  async inputPreview(
    text: string,
    generatingResponse: boolean,
  ): Promise<{ action: "confirm" | "cancel" }> {
    this.ensureInteractive();

    const region = new LiveRegion();
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    let latest = this.latestStatus;

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

    const unsubscribe = this.onStatusChange((snapshot) => {
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
    event: HybridInteraction,
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
    for (let i = 0; i < Math.min(9, options.length); i++) {
      const opt = options[i]!;
      const badge = branchBadge(this.latestStatus, opt.id);
      console.log(`  \x1b[1m[${i + 1}]\x1b[0m ${opt.text}  \x1b[2m[${badge}]\x1b[0m`);
    }

    // Status
    for (const s of compactStatus(this.latestStatus)) console.log(s);
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

  async choose(event: ChoiceEvent): Promise<ChoiceOption> {
    this.ensureInteractive();
    const region = new LiveRegion();
    let selectedIndex = 0;
    let latest = this.latestStatus;

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

    const unsubscribe = this.onStatusChange((snapshot) => {
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

  /**
   * Wait for the player to press Enter/Space to continue playback.
   * The status region stays live via setStatus feeds.
   */
  async waitForAdvance(): Promise<void> {
    this.ensureInteractive();
    const region = new LiveRegion();
    let latest = this.latestStatus;
    const draw = (): void => {
      region.render([...compactStatus(latest), "\x1b[2mEnter/Space 下一句，Ctrl+C 退出\x1b[0m"]);
    };
    const unsubscribe = this.onStatusChange((snapshot) => {
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
