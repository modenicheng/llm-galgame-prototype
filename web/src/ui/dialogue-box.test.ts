/**
 * DialogueBox DOM tests — the reveal must not start before the line's
 * webfont subsets are loaded (fallback→webfont swaps mid-reveal are the
 * "text flickers while typing" bug), the text node stays stable across
 * per-character updates, and stale font gates never resurrect a dead line.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAppDom } from "./layout.js";
import { DialogueBox } from "./dialogue-box.js";
import type { RuntimePlayableEventWire } from "../runtime/game-view-model.js";

function line(lineId: string, text: string, speaker = "苏晚"): RuntimePlayableEventWire {
  return { type: "dialogue", line_id: lineId, speaker, text };
}

interface FontsStub {
  /** Sample texts handed to document.fonts.load, in order. */
  calls: string[];
  flush(): void;
  reject(): void;
  restore(): void;
}

/**
 * Replace document.fonts with a controllable stub whose load() promises
 * settle only when the test flushes them. `noFonts` removes the property
 * entirely (legacy-environment fail-open path).
 */
function stubFonts(): FontsStub {
  const resolvers: Array<(value?: unknown) => void> = [];
  const calls: string[] = [];
  const original = Object.getOwnPropertyDescriptor(Document.prototype, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      load(_spec: string, text: string): Promise<unknown> {
        calls.push(text);
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      },
    },
  });
  return {
    calls,
    flush() {
      for (const resolve of resolvers.splice(0)) resolve([]);
    },
    reject() {
      for (const resolve of resolvers.splice(0)) resolve(undefined);
    },
    restore() {
      delete (document as { fonts?: unknown }).fonts;
      if (original !== undefined) {
        Object.defineProperty(Document.prototype, "fonts", original);
      }
    },
  };
}

function noFonts(): void {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    get() {
      return undefined;
    },
  });
}

interface Mounted {
  box: DialogueBox;
  textEl: HTMLElement;
  hintEl: HTMLElement;
  advances: { count: number };
}

function mount(): Mounted {
  const refs = buildAppDom(document.createElement("div"));
  const advances = { count: 0 };
  const box = new DialogueBox(refs.dialogueRoot, {
    onAdvance: () => {
      advances.count += 1;
    },
  });
  return {
    box,
    textEl: refs.dialogueRoot.querySelector(".dialogue__text") as HTMLElement,
    hintEl: refs.dialogueRoot.querySelector(".dialogue__hint") as HTMLElement,
    advances,
  };
}

describe("DialogueBox reveal vs webfonts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the first character until the line's fonts resolve", async () => {
    const fonts = stubFonts();
    const { box, textEl } = mount();
    box.setLine(line("L1", "夜雨灯下"), false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(textEl.textContent).toBe(""); // gate still closed

    // Body text and the nameplate (own weight) are each prewarmed.
    expect(fonts.calls).toEqual(["夜雨灯下", "苏晚"]);
    fonts.flush();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50); // first char at 32cps
    expect(textEl.textContent).toBe("夜");
    fonts.restore();
  });

  it("starts the reveal without a fonts API (fail-open)", async () => {
    noFonts();
    const { box, textEl } = mount();
    box.setLine(line("L1", "夜雨"), false);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(textEl.textContent).toBe("夜");
    delete (document as { fonts?: unknown }).fonts;
  });

  it("treats a rejected font load as ready (fail-open)", async () => {
    const fonts = stubFonts();
    const { box, textEl } = mount();
    box.setLine(line("L1", "夜雨"), false);
    fonts.reject();
    await vi.advanceTimersByTimeAsync(50);
    expect(textEl.textContent).toBe("夜");
    fonts.restore();
  });

  it("times out a slow font load and starts the reveal anyway", async () => {
    const fonts = stubFonts();
    const { box, textEl } = mount();
    box.setLine(line("L1", "夜雨"), false);
    await vi.advanceTimersByTimeAsync(1500); // FONT_READY_TIMEOUT_MS
    await vi.advanceTimersByTimeAsync(50);
    expect(textEl.textContent).toBe("夜");
    fonts.restore();
  });

  it("drops a stale gate when the line changes before fonts land", async () => {
    const fonts = stubFonts();
    const { box, textEl } = mount();
    box.setLine(line("L1", "第一句"), false);
    box.setLine(line("L2", "第二句"), false);
    fonts.flush(); // resolves BOTH gates, including the dead L1 one
    await vi.advanceTimersByTimeAsync(3000);
    expect(textEl.textContent).toBe("第二句"); // L1 never typed
    fonts.restore();
  });

  it("clear() empties the box and neuters a pending gate", async () => {
    const fonts = stubFonts();
    const { box, textEl } = mount();
    box.setLine(line("L1", "夜雨"), false);
    box.clear();
    fonts.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(textEl.textContent).toBe("");
    fonts.restore();
  });

  it("skip during the gate shows the whole line; the late gate never retypes", async () => {
    const fonts = stubFonts();
    const { box, textEl, hintEl, advances } = mount();
    box.setLine(line("L1", "夜雨灯下"), false);
    box.pressAdvance(); // player refuses to wait
    expect(textEl.textContent).toBe("夜雨灯下");
    expect(hintEl.hidden).toBe(false);

    fonts.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(textEl.textContent).toBe("夜雨灯下");
    expect(box.isTyping).toBe(false);
    box.pressAdvance(); // done → advance, not skip
    expect(advances.count).toBe(1);
    fonts.restore();
  });
});

describe("DialogueBox text node stability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mutates one persistent text node instead of replacing children", async () => {
    const fonts = stubFonts();
    const { box, textEl } = mount();
    box.setLine(line("L1", "一二三四五"), false);
    fonts.flush();
    await vi.advanceTimersByTimeAsync(50);
    const node = textEl.firstChild;
    expect(textEl.childNodes.length).toBe(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(textEl.textContent).toBe("一二三四五");
    expect(textEl.childNodes.length).toBe(1);
    expect(textEl.firstChild).toBe(node); // same node, patched in place
    fonts.restore();
  });
});

describe("DialogueBox line lifecycle (regression)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-presenting the same line_id never restarts the reveal", async () => {
    const fonts = stubFonts();
    const { box, textEl } = mount();
    box.setLine(line("L1", "一二三"), false);
    fonts.flush();
    await vi.advanceTimersByTimeAsync(50);
    expect(textEl.textContent).toBe("一");
    box.setLine(line("L1", "一二三"), false); // same id → ignored
    expect(textEl.textContent).toBe("一");
    fonts.restore();
  });
});
