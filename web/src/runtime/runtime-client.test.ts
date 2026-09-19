/**
 * RuntimeClient tests — node env, fake WebSocket injected via
 * `webSocketImpl` (design doc §9.1, §8.1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeClient,
  type RuntimeClientOptions,
  type WebSocketCtor,
} from "./runtime-client.js";

const WS_URL = "ws://127.0.0.1:8080/ws/runtime";
const TOKEN = "local-session-token";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  readyState = 0; // CONNECTING
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  /** Simulate a server close with a code/reason (C7 wire gate tests). */
  closeWith(code: number, reason: string): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  receive(raw: unknown): void {
    this.onmessage?.({ data: raw } as MessageEvent);
  }
}

function makeClient(overrides?: Partial<RuntimeClientOptions>): RuntimeClient {
  return new RuntimeClient({
    wsUrl: WS_URL,
    token: TOKEN,
    onServerMessage: vi.fn(),
    onConnectionChange: vi.fn(),
    webSocketImpl: FakeWebSocket as unknown as WebSocketCtor,
    ...overrides,
  });
}

function runtimeOutput(sequence: number, output: unknown) {
  return JSON.stringify({ type: "runtime.output", sequence, output });
}

describe("RuntimeClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends client.ready with capabilities on open, carrying the token", async () => {
    const onServerMessage = vi.fn();
    const onConnectionChange = vi.fn();
    const client = makeClient({ onServerMessage, onConnectionChange });

    const connected = client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(new URL(ws.url).searchParams.get("token")).toBe(TOKEN);
    expect(ws.url.startsWith(WS_URL)).toBe(true);

    ws.open();
    await connected;

    expect(ws.sent).toHaveLength(1);
    const ready = JSON.parse(ws.sent[0]!) as {
      type: string;
      capabilities: Record<string, unknown>;
      wireVersion?: number;
    };
    expect(ready.type).toBe("client.ready");
    expect(typeof ready.capabilities.audioWorklet).toBe("boolean");
    expect(typeof ready.capabilities.indexedDb).toBe("boolean");
    // C7：ready 携带 wire 协议版本（服务端据此拒绝过旧客户端）。
    expect(typeof ready.wireVersion).toBe("number");
    expect(onConnectionChange.mock.calls.map((c) => c[0])).toEqual([
      "connecting",
      "open",
    ]);
  });

  it("C7：wire 版本过旧被服务端 close(4002) 时不重连，给出升级提示", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onConnectionChange = vi.fn();
    const client = makeClient({ onConnectionChange });

    const connected = client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await connected;

    ws.closeWith(4002, "wire-version-stale: refresh the page to upgrade");

    // 不安排任何重连：推进足够长时间也不开新 socket。
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onConnectionChange.mock.calls.map((c) => c[0])).toEqual([
      "connecting",
      "open",
      "closed",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain("refresh");
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("drops stale runtime.output by monotonic sequence", async () => {
    const delivered: unknown[] = [];
    const client = makeClient({
      onServerMessage: (msg) => delivered.push(msg),
    });
    const connected = client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await connected;

    ws.receive(runtimeOutput(2, { type: "session_started", sessionId: "s", location: "l" }));
    ws.receive(runtimeOutput(2, { type: "session_started", sessionId: "s", location: "l" })); // duplicate
    ws.receive(runtimeOutput(1, { type: "session_started", sessionId: "s", location: "l" })); // stale
    ws.receive(runtimeOutput(3, { type: "session_started", sessionId: "s", location: "l" }));

    expect(delivered).toHaveLength(2);
    expect((delivered[0] as { sequence: number }).sequence).toBe(2);
    expect((delivered[1] as { sequence: number }).sequence).toBe(3);
  });

  it("reconnects with backoff and re-sends client.ready", async () => {
    vi.useFakeTimers();
    const onConnectionChange = vi.fn();
    const client = makeClient({ onConnectionChange });

    const connected = client.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.open();
    await connected;
    expect(ws1.sent).toHaveLength(1);

    ws1.close(); // drop the connection
    expect(FakeWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.open();

    const types = ws2.sent.map((m) => (JSON.parse(m) as { type: string }).type);
    expect(types).toContain("client.ready");
    expect(onConnectionChange.mock.calls.map((c) => c[0])).toEqual([
      "connecting",
      "open",
      "closed",
      "connecting",
      "open",
    ]);
  });

  it("drops invalid messages and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onServerMessage = vi.fn();
    const client = makeClient({ onServerMessage });

    const connected = client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await connected;

    ws.receive("not-json");
    ws.receive(JSON.stringify({ type: "bogus" }));
    ws.receive(JSON.stringify({ type: "runtime.output", sequence: 1 })); // missing output

    expect(onServerMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("sends runtime.command with commandId and raw reports", async () => {
    const client = makeClient();
    const connected = client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await connected;

    client.sendCommand("cmd-42", { type: "advance" });
    client.send({ type: "audio.buffer_report", bufferedAheadMs: 120, underrunCount: 0 });

    const sent = ws.sent.map((m) => JSON.parse(m));
    expect(sent[1]).toEqual({
      type: "runtime.command",
      commandId: "cmd-42",
      command: { type: "advance" },
    });
    expect(sent[2]).toEqual({
      type: "audio.buffer_report",
      bufferedAheadMs: 120,
      underrunCount: 0,
    });
  });

  it("drops commands sent while not connected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient();
    client.sendCommand("cmd-1", { type: "shutdown" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("close() stops reconnecting and reports closed", async () => {
    vi.useFakeTimers();
    const onConnectionChange = vi.fn();
    const client = makeClient({ onConnectionChange });

    const connected = client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await connected;

    client.close();
    expect(ws.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect attempt
    expect(onConnectionChange.mock.calls.map((c) => c[0])).toEqual([
      "connecting",
      "open",
      "closed",
    ]);
  });
});
