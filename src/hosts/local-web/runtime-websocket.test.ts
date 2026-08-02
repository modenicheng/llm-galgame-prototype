/**
 * RuntimeWebSocket tests: real `ws` clients against a real HTTP server on
 * an ephemeral port. Covers the snapshot handshake, descriptor replay,
 * output forwarding with per-connection sequence, command dispatch +
 * commandId dedup, controller limit (4001), token/origin rejection,
 * catalog + task-status event forwarding, and session-end cleanup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { AudioCatalogServiceImpl } from "../../application/audio/audio-catalog-service.js";
import type { TaskStatusEvent } from "../../application/audio/tts-task-service.js";
import type { PublicWebConfig } from "../../shared/wire/public-web-config.js";
import type { ServerMessage } from "../../shared/wire/server-message.js";
import { isAllowedOrigin } from "./origin-guard.js";
import { RuntimeWebSocket } from "./runtime-websocket.js";
import { makeFakeGame, makeFakeProjection, testDescriptor, testRecipe } from "./test-fakes.js";

const TOKEN = "test-token";

const publicConfig: PublicWebConfig = {
  audio: {
    playback: { startup_buffer_ms: 350, critical_watermark_ms: 500, low_watermark_ms: 2500, target_buffer_ms: 6500 },
    cache: { write_batch_bytes: 262_144, write_flush_interval_ms: 300 },
    format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1, bitDepth: 16 },
  },
  game: { show_line_ids: true },
};

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

async function waitForMessage(
  messages: ServerMessage[],
  predicate: (m: ServerMessage) => boolean,
  timeoutMs = 2000,
): Promise<ServerMessage> {
  const start = Date.now();
  for (;;) {
    const found = messages.find(predicate);
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for message");
    await sleep(5);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

interface TestClient {
  ws: WebSocket;
  messages: ServerMessage[];
  closeInfo: Promise<{ code: number; reason: string }>;
}

function connectClient(url: string, origin: string): Promise<TestClient> {
  const { promise, resolve } = Promise.withResolvers<TestClient>();
  const ws = new WebSocket(url, { origin });
  const messages: ServerMessage[] = [];
  ws.on("message", (data) => {
    messages.push(JSON.parse(String(data)) as ServerMessage);
  });
  const { promise: closeInfo, resolve: resolveClose } = Promise.withResolvers<{
    code: number;
    reason: string;
  }>();
  ws.on("close", (code, reason) => {
    resolveClose({ code, reason: String(reason) });
    resolve({ ws, messages, closeInfo });
  });
  ws.on("open", () => {
    resolve({ ws, messages, closeInfo });
  });
  ws.on("error", () => {
    // The close event carries the outcome.
  });
  return promise;
}

describe("RuntimeWebSocket", () => {
  let server: http.Server;
  let port: number;
  let wss: WebSocketServer;
  let runtimeWs: RuntimeWebSocket;
  let catalog: AudioCatalogServiceImpl;
  let game: ReturnType<typeof makeFakeGame>;
  let statusListener: ((event: TaskStatusEvent) => void) | null;
  let startedGame = false;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    catalog = new AudioCatalogServiceImpl();
    startedGame = false;
    game = makeFakeGame();
    const projection = makeFakeProjection();
    statusListener = null;

    server = http.createServer();
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => resolve());
    await promise;
    const address = server.address() as AddressInfo;
    port = address.port;

    runtimeWs = new RuntimeWebSocket({
      game: game.game,
      projection: projection.projection,
      catalog,
      ttsStatus: (cb) => {
        statusListener = cb;
        return () => {
          statusListener = null;
        };
      },
      startGame: () => {
        startedGame = true;
      },
      token: TOKEN,
      controllerLimit: 1,
      originGuard: (origin) => isAllowedOrigin(origin, "127.0.0.1", port),
      publicConfig,
    });

    wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const pathname = (req.url ?? "/").split("?")[0];
      if (pathname === "/ws/runtime") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          runtimeWs.handle(ws, req);
        });
      } else {
        socket.destroy();
      }
    });
  });

  afterEach(async () => {
    for (const ws of clients.splice(0)) {
      try {
        ws.terminate();
      } catch {
        // already closed
      }
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    wss.close(() => resolve());
    await promise;
    server.closeAllConnections();
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
    server.close(() => resolveClosed());
    await closed;
  });

  function connect(token: string = TOKEN, origin = `http://127.0.0.1:${port}`): Promise<TestClient> {
    const client = connectClient(`ws://127.0.0.1:${port}/ws/runtime?token=${token}`, origin);
    void client.then((c) => clients.push(c.ws));
    return client;
  }

  it("sends projection.snapshot on open", async () => {
    const client = await connect();
    const message = await waitForMessage(client.messages, (m) => m.type === "projection.snapshot");
    expect(message).toEqual({ type: "projection.snapshot", projection: { phase: "idle", recentLines: [] } });
  });

  it("starts the game on the first controller connection (§10.5)", async () => {
    expect(startedGame).toBe(false);
    const client = await connect();
    await waitForMessage(client.messages, (m) => m.type === "projection.snapshot");
    expect(startedGame).toBe(true);
  });

  it("replays all catalog descriptors on open", async () => {
    catalog.upsertDescriptor(testDescriptor, testRecipe);
    const client = await connect();
    const message = await waitForMessage(client.messages, (m) => m.type === "audio.descriptor");
    expect(message.type).toBe("audio.descriptor");
    if (message.type === "audio.descriptor") {
      expect(message.descriptor.lineId).toBe("line_1");
      expect(message.descriptor.cacheKey).toBe("cache_1");
    }
  });

  it("forwards runtime outputs with a per-connection sequence", async () => {
    const client = await connect();
    game.emit({ type: "session_started", sessionId: "s1", location: "mem" });
    const first = await waitForMessage(client.messages, (m) => m.type === "runtime.output");
    expect(first.type).toBe("runtime.output");
    if (first.type === "runtime.output") {
      expect(first.sequence).toBe(1);
      expect(first.output).toEqual({ type: "session_started", sessionId: "s1", location: "mem" });
    }
    game.emit({ type: "runtime_error", code: "seg_failed", message: "boom" });
    const second = await waitForMessage(client.messages, (m) => m.type === "runtime.output" && m.sequence === 2);
    expect(second.type).toBe("runtime.output");
  });

  it("uses an independent sequence per connection", async () => {
    const multi = await startMultiServer(2);
    const a = await connectClient(`ws://127.0.0.1:${multi.port}/ws/runtime?token=${TOKEN}`, `http://127.0.0.1:${multi.port}`);
    const b = await connectClient(`ws://127.0.0.1:${multi.port}/ws/runtime?token=${TOKEN}`, `http://127.0.0.1:${multi.port}`);
    clients.push(a.ws, b.ws);
    try {
      await waitForMessage(b.messages, (m) => m.type === "projection.snapshot");
      game.emit({ type: "session_started", sessionId: "s1", location: "mem" });
      await waitForMessage(a.messages, (m) => m.type === "runtime.output");
      await waitForMessage(b.messages, (m) => m.type === "runtime.output");
      expect(a.messages.find((m) => m.type === "runtime.output")).toMatchObject({ sequence: 1 });
      expect(b.messages.find((m) => m.type === "runtime.output")).toMatchObject({ sequence: 1 });
    } finally {
      await closeMultiServer(multi, a.ws, b.ws);
    }
  });

  it("dispatches validated runtime commands to the game", async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ type: "runtime.command", commandId: "c1", command: { type: "advance" } }));
    await waitFor(() => game.dispatch.mock.calls.length === 1);
    expect(game.dispatch.mock.calls[0]?.[0]).toEqual({ type: "advance" });
  });

  it("dedups runtime commands by commandId", async () => {
    const client = await connect();
    const command = JSON.stringify({ type: "runtime.command", commandId: "c1", command: { type: "advance" } });
    client.ws.send(command);
    client.ws.send(command);
    await waitFor(() => game.dispatch.mock.calls.length === 1);
    client.ws.send(JSON.stringify({ type: "runtime.command", commandId: "c2", command: { type: "advance" } }));
    await waitFor(() => game.dispatch.mock.calls.length === 2);
  });

  it("drops commands after stopAcceptingCommands", async () => {
    const client = await connect();
    runtimeWs.stopAcceptingCommands();
    client.ws.send(JSON.stringify({ type: "runtime.command", commandId: "c1", command: { type: "advance" } }));
    await sleep(30);
    expect(game.dispatch.mock.calls).toHaveLength(0);
  });

  it("ignores malformed and schema-invalid messages", async () => {
    const client = await connect();
    client.ws.send("not json");
    client.ws.send(JSON.stringify({ type: "runtime.command", commandId: "", command: { type: "advance" } }));
    await sleep(30);
    expect(game.dispatch.mock.calls).toHaveLength(0);
  });

  it("rejects a second controller with close 4001 controller-limit", async () => {
    const first = await connect();
    await waitForMessage(first.messages, (m) => m.type === "projection.snapshot");
    const second = await connect();
    const { code, reason } = await second.closeInfo;
    expect(code).toBe(4001);
    expect(reason).toBe("controller-limit");
  });

  it("rejects a wrong session token", async () => {
    const client = await connect("wrong-token");
    const { code } = await client.closeInfo;
    expect(code).toBe(1006);
  });

  it("rejects a missing session token", async () => {
    const clientPromise = connectClient(`ws://127.0.0.1:${port}/ws/runtime`, `http://127.0.0.1:${port}`);
    void clientPromise.then((c) => clients.push(c.ws));
    const client = await clientPromise;
    const { code } = await client.closeInfo;
    expect(code).toBe(1006);
  });

  it("rejects a disallowed origin", async () => {
    const client = await connect(TOKEN, "http://evil.example.com");
    const { code } = await client.closeInfo;
    expect(code).toBe(1006);
  });

  it("forwards catalog lifecycle events", async () => {
    const client = await connect();
    await waitForMessage(client.messages, (m) => m.type === "projection.snapshot");

    catalog.upsertDescriptor(
      { ...testDescriptor, lineId: "line_2", cacheKey: "cache_2" },
      { ...testRecipe, lineId: "line_2", cacheKey: "cache_2" },
    );
    const descriptorMsg = await waitForMessage(client.messages, (m) => m.type === "audio.descriptor" && m.descriptor?.lineId === "line_2");
    expect(descriptorMsg.type).toBe("audio.descriptor");

    catalog.setPriority("line_2", "next");
    const priorityMsg = await waitForMessage(client.messages, (m) => m.type === "audio.priority_changed");
    expect(priorityMsg.type).toBe("audio.priority_changed");
    if (priorityMsg.type === "audio.priority_changed") {
      expect(priorityMsg.priority).toBe("next");
    }

    catalog.invalidate("line_2", "branch_discarded");
    const invalidatedMsg = await waitForMessage(client.messages, (m) => m.type === "audio.invalidated");
    expect(invalidatedMsg.type).toBe("audio.invalidated");
    if (invalidatedMsg.type === "audio.invalidated") {
      expect(invalidatedMsg.lineId).toBe("line_2");
      expect(invalidatedMsg.reason).toBe("branch_discarded");
    }
  });

  it("forwards TTS task status events", async () => {
    const client = await connect();
    await waitForMessage(client.messages, (m) => m.type === "projection.snapshot");
    expect(statusListener).not.toBeNull();

    statusListener?.({ taskId: "t1", lineId: "line_1", status: "started" });
    const started = await waitForMessage(client.messages, (m) => m.type === "audio.task_status");
    expect(started).toEqual({ type: "audio.task_status", taskId: "t1", lineId: "line_1", status: "started" });

    statusListener?.({ taskId: "t1", lineId: "line_1", status: "finished", totalBytes: 1234 });
    const finished = await waitForMessage(client.messages, (m) => m.type === "audio.task_status" && m.status === "finished");
    expect(finished).toEqual({ type: "audio.task_status", taskId: "t1", lineId: "line_1", status: "finished", totalBytes: 1234 });

    statusListener?.({ taskId: "t1", lineId: "line_1", status: "failed", error: "provider error" });
    const failed = await waitForMessage(client.messages, (m) => m.type === "audio.task_status" && m.status === "failed");
    expect(failed).toEqual({ type: "audio.task_status", taskId: "t1", lineId: "line_1", status: "failed", error: "provider error" });
  });

  it("closes remaining controllers after the session ends", async () => {
    const multi = await startMultiServer(2);
    const a = await connectClient(`ws://127.0.0.1:${multi.port}/ws/runtime?token=${TOKEN}`, `http://127.0.0.1:${multi.port}`);
    const b = await connectClient(`ws://127.0.0.1:${multi.port}/ws/runtime?token=${TOKEN}`, `http://127.0.0.1:${multi.port}`);
    clients.push(a.ws, b.ws);
    try {
      await waitForMessage(b.messages, (m) => m.type === "projection.snapshot");

      // Session ends; the first controller disconnects and the rest are closed.
      game.emit({ type: "session_ended", ending: { type: "end", ending_id: "e1", text: "fin" } });
      a.ws.close();
      const { code } = await b.closeInfo;
      expect(code).toBe(1000);
    } finally {
      await closeMultiServer(multi, a.ws, b.ws);
    }
  });
  interface MultiServer {
    port: number;
    server: http.Server;
  }

  async function startMultiServer(controllerLimit: number): Promise<MultiServer> {
    const server = http.createServer();
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => resolve());
    await promise;
    const multiPort = (server.address() as AddressInfo).port;

    const multiWs = new RuntimeWebSocket({
      game: game.game,
      projection: makeFakeProjection().projection,
      catalog,
      ttsStatus: () => () => {},
      startGame: () => {
        startedGame = true;
      },
      token: TOKEN,
      controllerLimit,
      originGuard: (origin) => isAllowedOrigin(origin, "127.0.0.1", multiPort),
      publicConfig,
    });
    const multiWss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      multiWss.handleUpgrade(req, socket, head, (ws) => multiWs.handle(ws, req));
    });
    return { port: multiPort, server };
  }

  async function closeMultiServer(multi: MultiServer, ...sockets: WebSocket[]): Promise<void> {
    for (const ws of sockets) {
      try {
        ws.terminate();
      } catch {
        // already closed
      }
    }
    multi.server.closeAllConnections();
    const { promise, resolve } = Promise.withResolvers<void>();
    multi.server.close(() => resolve());
    await promise;
  }
});
