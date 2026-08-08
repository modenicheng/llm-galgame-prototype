/**
 * main.ts bootstrap tests — happy-dom. Verifies §10.5 end to end: the Start
 * click creates and resumes the AudioContext (inside the user gesture),
 * registers the worklet, opens the Runtime WebSocket and sends client.ready.
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PUBLIC_WEB_CONFIG } from "./app.js";

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  state: AudioContextState = "suspended";
  resume = vi.fn().mockResolvedValue(undefined);
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  destination = {};
  createAudioWorkletNode = vi.fn(() => ({
    port: { postMessage: vi.fn(), onmessage: null },
    connect: vi.fn(),
  }));
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));

  constructor() {
    FakeAudioContext.last = this;
  }
}

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  url: string;
  sent: string[] = [];
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
}

function stubBrowserApis(): void {
  FakeAudioContext.last = null;
  FakeWebSocket.last = null;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/config") {
        return Promise.resolve(
          new Response(JSON.stringify(DEFAULT_PUBLIC_WEB_CONFIG), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }),
  );
  document.body.innerHTML = ""; // no #app yet — auto-boot is skipped on import
}

describe("main bootstrap", () => {
  beforeEach(stubBrowserApis);

  it("start click unlocks the AudioContext and connects the runtime socket", async () => {
    const { boot } = await import("./main.js");
    document.body.innerHTML = '<div id="app"></div>';
    await boot();

    const startBtn = document.querySelector(".btn--start") as HTMLButtonElement;
    expect(startBtn).not.toBeNull();
    startBtn.click();

    await vi.waitFor(() => {
      expect(FakeAudioContext.last).not.toBeNull();
      expect(FakeAudioContext.last!.resume).toHaveBeenCalled();
      expect(FakeAudioContext.last!.audioWorklet.addModule).toHaveBeenCalled();
    });

    await vi.waitFor(() => {
      expect(FakeWebSocket.last).not.toBeNull();
    });
    expect(FakeWebSocket.last!.url).toContain("/ws/runtime");
    FakeWebSocket.last!.open();

    await vi.waitFor(() => {
      const ready = FakeWebSocket.last!.sent.find((raw) => JSON.parse(raw).type === "client.ready");
      expect(ready).toBeDefined();
      expect(
        (document.querySelector(".overlay--start") as HTMLElement).hasAttribute("hidden"),
      ).toBe(true);
    });
  });

  it("reads the session token from the URL query and warns when absent", async () => {
    window.history.replaceState(null, "", "/?token=abc123");
    const { boot } = await import("./main.js");
    document.body.innerHTML = '<div id="app"></div>';
    await boot();
    startGame();
    await vi.waitFor(() => {
      expect(FakeWebSocket.last!.url).toContain("token=abc123");
    });
    const warning = document.querySelector(".start-warning") as HTMLElement;
    expect(warning.textContent).toBe("");
    expect(warning.hasAttribute("hidden")).toBe(true);
  });
  it("shows a warning on the start screen when the token is missing", async () => {
    window.history.replaceState(null, "", "/");
    const { boot } = await import("./main.js");
    document.body.innerHTML = '<div id="app"></div>';
    await boot();
    const warning = document.querySelector(".start-warning") as HTMLElement;
    expect(warning.textContent).toContain("令牌");
  });
});

function startGame(): void {
  (document.querySelector(".btn--start") as HTMLButtonElement).click();
}

// ---------------------------------------------------------------------------
// Interaction form rendering (§11, §14.8) — full boot loop: the app receives
// runtime.output messages over the socket and the render router drives the
// unified InteractionPanel.
// ---------------------------------------------------------------------------

const choiceInteraction = {
  type: "interaction",
  interaction_id: "int-1",
  prompt: "如何选择？",
  mode: "choice",
  options: [
    { id: "a", text: "选项A" },
    { id: "b", text: "选项B" },
  ],
};

const hybridInteraction = {
  type: "interaction",
  interaction_id: "int-1",
  prompt: "如何回应？",
  mode: "hybrid",
  options: [
    { id: "a", text: "选项A" },
    { id: "b", text: "选项B" },
  ],
  input: { kind: "free_text", placeholder: "你的回应……", max_length: 300 },
  input_bridge: { events: [{ type: "narration", text: "她等着。" }] },
};

const inputInteraction = {
  type: "interaction",
  interaction_id: "int-1",
  prompt: "说点什么",
  mode: "input",
  input: { kind: "free_text", placeholder: "写下你的回应……", max_length: 160 },
  input_bridge: { events: [{ type: "narration", text: "她等着。" }] },
};

describe("interaction forms", () => {
  beforeEach(stubBrowserApis);

  let sequence = 0;
  beforeEach(() => {
    sequence = 0;
  });

  /** Boot, click Start, open the socket and wait for client.ready. */
  async function bootStarted(): Promise<void> {
    // Deliberately lazy: importing main.js while #app is absent skips the
    // module-level auto-boot, so each test controls the boot itself.
    const { boot } = await import("./main.js");
    document.body.innerHTML = '<div id="app"></div>';
    await boot();
    startGame();
    await vi.waitFor(() => {
      expect(FakeWebSocket.last).not.toBeNull();
    });
    FakeWebSocket.last!.open();
    await vi.waitFor(() => {
      const ready = FakeWebSocket.last!.sent.find(
        (raw) => JSON.parse(raw).type === "client.ready",
      );
      expect(ready).toBeDefined();
    });
  }

  function feed(output: Record<string, unknown>): void {
    sequence += 1;
    FakeWebSocket.last!.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "runtime.output", sequence, output }),
      }),
    );
  }

  function feedProjection(projection: Record<string, unknown>): void {
    FakeWebSocket.last!.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "projection.snapshot", projection }),
      }),
    );
  }

  /** Runtime commands with the wire envelope unwrapped. */
  function sentCommands(): Array<Record<string, unknown>> {
    return FakeWebSocket.last!.sent.map((raw) => {
      const message = JSON.parse(raw) as { command?: Record<string, unknown> };
      return message.command ?? message;
    });
  }

  it("renders a choice interaction as options only", async () => {
    await bootStarted();
    feed({ type: "interaction_opened", interactionId: "int-1", interaction: choiceInteraction });

    const panel = document.querySelector(".interaction-panel") as HTMLElement;
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect(panel.querySelectorAll("button.choice")).toHaveLength(2);
    expect(
      (panel.querySelector(".interaction-panel__input") as HTMLElement).hasAttribute("hidden"),
    ).toBe(true);
    expect(
      (panel.querySelector(".interaction-panel__divider") as HTMLElement).hasAttribute("hidden"),
    ).toBe(true);
  });

  it("renders a hybrid interaction with options, textarea, divider and one prompt", async () => {
    await bootStarted();
    feed({ type: "interaction_opened", interactionId: "int-1", interaction: hybridInteraction });

    const panel = document.querySelector(".interaction-panel") as HTMLElement;
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect(panel.querySelectorAll("button.choice")).toHaveLength(2);
    expect(
      (panel.querySelector(".interaction-panel__input") as HTMLElement).hasAttribute("hidden"),
    ).toBe(false);
    expect(
      (panel.querySelector(".interaction-panel__divider") as HTMLElement).hasAttribute("hidden"),
    ).toBe(false);
    const prompts = panel.querySelectorAll(
      ".interaction-panel__prompt, .choices__prompt, .input-panel__prompt",
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.textContent).toBe("如何回应？");
  });

  it("renders an input interaction as the textarea only", async () => {
    await bootStarted();
    feed({ type: "interaction_opened", interactionId: "int-1", interaction: inputInteraction });

    const panel = document.querySelector(".interaction-panel") as HTMLElement;
    expect(panel.querySelectorAll("button.choice")).toHaveLength(0);
    expect(
      (panel.querySelector(".interaction-panel__choices") as HTMLElement).hasAttribute("hidden"),
    ).toBe(true);
    expect(
      (panel.querySelector(".interaction-panel__divider") as HTMLElement).hasAttribute("hidden"),
    ).toBe(true);
    const field = panel.querySelector("textarea") as HTMLTextAreaElement;
    expect(field.hasAttribute("hidden")).toBe(false);
    expect(field.placeholder).toBe("写下你的回应……");
  });

  it("locks the panel after an option click: further Enter and clicks send nothing", async () => {
    await bootStarted();
    feed({ type: "interaction_opened", interactionId: "int-1", interaction: hybridInteraction });

    const buttons = [...document.querySelectorAll("button.choice")] as HTMLButtonElement[];
    buttons[0]!.click();
    const sent = sentCommands();
    expect(
      sent.some(
        (cmd) =>
          cmd.type === "select_choice" && cmd.interactionId === "int-1" && cmd.optionId === "a",
      ),
    ).toBe(true);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    const field = document.querySelector(".interaction-panel textarea") as HTMLTextAreaElement;
    expect(field.disabled).toBe(true);

    const countBefore = sentCommands().length;
    buttons[1]!.click();
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(sentCommands().length).toBe(countBefore);
  });

  it("locks the panel after an input submit: option clicks send nothing", async () => {
    await bootStarted();
    feed({ type: "interaction_opened", interactionId: "int-1", interaction: hybridInteraction });

    const field = document.querySelector(".interaction-panel textarea") as HTMLTextAreaElement;
    field.value = "我自己来";
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    const sent = sentCommands();
    expect(
      sent.some(
        (cmd) =>
          cmd.type === "preview_input" && cmd.interactionId === "int-1" && cmd.text === "我自己来",
      ),
    ).toBe(true);
    expect(
      [...document.querySelectorAll("button.choice")].every(
        (button) => (button as HTMLButtonElement).disabled,
      ),
    ).toBe(true);
    expect(field.disabled).toBe(true);

    const countBefore = sentCommands().length;
    (document.querySelectorAll("button.choice")[0] as HTMLButtonElement).click();
    expect(sentCommands().length).toBe(countBefore);
  });

  it("restores the hybrid form with the original draft after preview cancel", async () => {
    await bootStarted();
    feed({ type: "interaction_opened", interactionId: "int-1", interaction: hybridInteraction });

    const field = document.querySelector(".interaction-panel textarea") as HTMLTextAreaElement;
    field.value = "我想跟她走";
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(
      sentCommands().some(
        (cmd) =>
          cmd.type === "preview_input" && cmd.interactionId === "int-1" && cmd.text === "我想跟她走",
      ),
    ).toBe(true);
    expect(field.disabled).toBe(true);

    feed({ type: "input_preview_opened", previewId: "pv-1", text: "我想跟她走" });
    const preview = document.querySelector(".preview") as HTMLElement;
    expect(preview.hasAttribute("hidden")).toBe(false);
    expect((document.querySelector(".preview__text") as HTMLElement).textContent).toBe("我想跟她走");

    (document.querySelector(".preview__cancel") as HTMLButtonElement).click();
    expect(
      sentCommands().some((cmd) => cmd.type === "cancel_input" && cmd.previewId === "pv-1"),
    ).toBe(true);
    feed({ type: "input_preview_canceled", previewId: "pv-1" });

    // Hybrid restored — not degraded to a pure input form.
    const panel = document.querySelector(".interaction-panel") as HTMLElement;
    expect(panel.hasAttribute("hidden")).toBe(false);
    const buttons = [...panel.querySelectorAll("button.choice")] as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(
      (panel.querySelector(".interaction-panel__divider") as HTMLElement).hasAttribute("hidden"),
    ).toBe(false);
    expect(
      (panel.querySelector(".interaction-panel__input") as HTMLElement).hasAttribute("hidden"),
    ).toBe(false);
    const restored = panel.querySelector("textarea") as HTMLTextAreaElement;
    expect(restored.disabled).toBe(false);
    expect(restored.value).toBe("我想跟她走");
  });

  it("never restores a previous interaction's draft when a new interaction opens", async () => {
    await bootStarted();
    feed({ type: "interaction_opened", interactionId: "int-a", interaction: inputInteraction });

    // Interaction A: type a draft, preview, cancel — the draft is restored in A.
    const field = document.querySelector(".interaction-panel textarea") as HTMLTextAreaElement;
    field.value = "A 的草稿";
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    feed({ type: "input_preview_opened", previewId: "pv-1", text: "A 的草稿" });
    (document.querySelector(".preview__cancel") as HTMLButtonElement).click();
    feed({ type: "input_preview_canceled", previewId: "pv-1" });

    expect(field.value).toBe("A 的草稿");

    // A resolves and B opens — A's draft must not leak into B.
    feed({ type: "interaction_resolved", interactionId: "int-a", resolution: "input" });
    feed({ type: "interaction_opened", interactionId: "int-b", interaction: inputInteraction });
    const fieldB = document.querySelector(".interaction-panel textarea") as HTMLTextAreaElement;
    expect(fieldB.value).toBe("");
  });

  it("re-opens the locked panel and resets the submit lock when a projection restores the same interaction", async () => {
    await bootStarted();
    feed({ type: "interaction_opened", interactionId: "int-1", interaction: hybridInteraction });

    // Submit free text while connected — the panel locks one-shot (§10.3).
    const field = document.querySelector(".interaction-panel textarea") as HTMLTextAreaElement;
    field.value = "我自己来";
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(
      sentCommands().some(
        (cmd) =>
          cmd.type === "preview_input" && cmd.interactionId === "int-1" && cmd.text === "我自己来",
      ),
    ).toBe(true);
    expect(field.disabled).toBe(true);
    expect(
      [...document.querySelectorAll("button.choice")].every(
        (button) => (button as HTMLButtonElement).disabled,
      ),
    ).toBe(true);

    // Reconnect: the server restores the SAME still-open interaction. The
    // panel must re-open with enabled options and an enabled textarea.
    feedProjection({
      phase: "running",
      recentLines: [],
      currentInteraction: hybridInteraction,
    });

    const panel = document.querySelector(".interaction-panel") as HTMLElement;
    expect(panel.hasAttribute("hidden")).toBe(false);
    const buttons = [...panel.querySelectorAll("button.choice")] as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    const restored = panel.querySelector("textarea") as HTMLTextAreaElement;
    expect(restored.disabled).toBe(false);

    // A further submit sends a new command (the lock is gone).
    restored.value = "重新提交";
    restored.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(
      sentCommands().some(
        (cmd) =>
          cmd.type === "preview_input" && cmd.interactionId === "int-1" && cmd.text === "重新提交",
      ),
    ).toBe(true);
  });
});
