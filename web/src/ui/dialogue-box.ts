/**
 * DialogueBox — the core VN dialogue panel: speaker nameplate, typewriter
 * text reveal, line-id chip (config.game.show_line_ids) and the advance
 * hint. One click types out the rest; the next click advances (§9.3).
 */
import type { RuntimePlayableEventWire } from "../runtime/game-view-model.js";
import { setText, show } from "./dom.js";
import { Typewriter } from "./typewriter.js";

export interface DialogueBoxHooks {
  onAdvance(): void;
}

/** 字体就绪门控超时（毫秒）：超时即放行——任何路径 fail-open，绝不阻塞剧情。 */
const FONT_READY_TIMEOUT_MS = 1500;

export class DialogueBox {
  private readonly root: HTMLElement;
  private readonly speakerEl: HTMLElement;
  private readonly lineIdEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly hooks: DialogueBoxHooks;

  private typewriter: Typewriter | null = null;
  private charsPerSec = 32;
  private currentLineId: string | null = null;
  private showLineIds = false;
  /** 行代次：迟到的字体门控回调不得启动已被替换/清除的行。 */
  private lineEpoch = 0;

  constructor(root: HTMLElement, hooks: DialogueBoxHooks) {
    this.root = root;
    this.hooks = hooks;
    this.speakerEl = root.querySelector(".dialogue__speaker") as HTMLElement;
    this.lineIdEl = root.querySelector(".dialogue__line-id") as HTMLElement;
    this.textEl = root.querySelector(".dialogue__text") as HTMLElement;
    this.hintEl = root.querySelector(".dialogue__hint") as HTMLButtonElement;
    this.root.addEventListener("click", (event) => {
      // The hint is a button; clicking it must not double-fire.
      if (event.target === this.hintEl) return;
      this.pressAdvance();
    });
    this.hintEl.addEventListener("click", () => this.pressAdvance());
  }

  /** Present a line; the typewriter restarts only when the line changed. */
  setLine(line: RuntimePlayableEventWire, showLineIds: boolean): void {
    this.showLineIds = showLineIds;
    if (line.line_id === this.currentLineId) return;
    this.currentLineId = line.line_id;
    this.lineEpoch += 1;
    const epoch = this.lineEpoch;

    const isNarration = line.type === "narration";
    const speakerText = isNarration ? "旁白" : (line.speaker ?? "");
    setText(this.speakerEl, speakerText);
    this.root.classList.toggle("dialogue--narration", isNarration);
    setText(this.lineIdEl, showLineIds ? line.line_id : "");
    show(this.lineIdEl, showLineIds);

    this.typewriter?.stop();
    setText(this.textEl, "");
    show(this.hintEl, false);
    this.typewriter = new Typewriter(
      line.text,
      {
        onUpdate: (full) => setText(this.textEl, full),
        onDone: () => show(this.hintEl, true),
      },
      this.charsPerSec,
    );
    // Prewarm the subsets for the whole line (and the nameplate — its 600
    // weight is a separate face set) now; the reveal starts once they are
    // loaded (or the gate times out / fails). 门控治的是懒子集+swap 的
    // 逐字换装闪烁（campus e8765f5）：等的是本行要用到的字形，不是全家。
    void this.waitForLineFonts(line.text, speakerText).then(() => {
      if (this.lineEpoch !== epoch) return;
      this.typewriter?.start();
    });
  }

  setCharsPerSecond(charsPerSec: number): void {
    this.charsPerSec = charsPerSec;
    this.typewriter?.setCharsPerSecond(charsPerSec);
  }

  get isTyping(): boolean {
    return this.typewriter !== null && !this.typewriter.isDone;
  }

  /** First press finishes the reveal; the next press advances. */
  pressAdvance(): void {
    if (this.typewriter !== null && !this.typewriter.isDone) {
      this.typewriter.skip();
      return;
    }
    this.hooks.onAdvance();
  }

  clear(): void {
    this.lineEpoch += 1;
    this.typewriter?.stop();
    this.typewriter = null;
    this.currentLineId = null;
    setText(this.textEl, "");
    setText(this.speakerEl, "");
    setText(this.lineIdEl, "");
    show(this.hintEl, false);
  }

  /**
   * 字体就绪门控（campus e8765f5 移植）：CJK 按 unicode-range 懒加载子集，
   * 首次命中新子集的行会先以回退栈 paint 再换装（逐字闪烁）。
   * `document.fonts.load` 预取本行所需子集。每条路径 fail-open：无 fonts
   * API、计算样式异常、load 拒绝或网络慢都绝不阻塞剧情。
   */
  private async waitForLineFonts(text: string, speaker: string): Promise<void> {
    const fonts = document.fonts;
    if (fonts === undefined || typeof fonts.load !== "function") return;
    const loads: Array<Promise<unknown>> = [];
    try {
      const textStyle = getComputedStyle(this.textEl);
      loads.push(fonts.load(`${textStyle.fontSize} ${textStyle.fontFamily}`, text));
      const plateStyle = getComputedStyle(this.speakerEl);
      loads.push(
        fonts.load(
          `${plateStyle.fontWeight} ${plateStyle.fontSize} ${plateStyle.fontFamily}`,
          speaker,
        ),
      );
    } catch {
      return;
    }
    await Promise.race([
      Promise.all(loads).catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, FONT_READY_TIMEOUT_MS);
      }),
    ]);
  }
}
