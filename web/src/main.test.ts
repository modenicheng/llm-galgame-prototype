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

describe("main bootstrap", () => {
  beforeEach(() => {
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
  });

  it("start click unlocks the AudioContext and connects the runtime socket", async () => {
    const { boot } = await import("./main.js");
    document.body.innerHTML = '<div id="app"></div>';
    boot();

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
    boot();
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
    boot();
    const warning = document.querySelector(".start-warning") as HTMLElement;
    expect(warning.textContent).toContain("令牌");
  });
});

function startGame(): void {
  (document.querySelector(".btn--start") as HTMLButtonElement).click();
}
