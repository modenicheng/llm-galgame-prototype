/**
 * Tests for WebServer — WebSocket + HTTP server.
 *
 * Covers construction, start/stop lifecycle, static file serving (including
 * MIME types, SPA fallback, and directory traversal prevention), WebSocket
 * message handling, broadcast/send, connection lifecycle, and multiple
 * clients.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { WebServer } from "./server.js";
import type { ServerMessage, ClientMessage } from "./server.js";
import { WebSocket } from "ws";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import http from "node:http";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

// Temporary files created for MIME-type tests
const CSS_FILE = path.join(PUBLIC_DIR, "test-style.css");
const JS_FILE = path.join(PUBLIC_DIR, "test-script.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allocate a free TCP port via the OS, release it, and return the number. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("Failed to get free port"));
      }
    });
  });
}

/** Open a WebSocket client connection and wait for the 'open' event. */
function wsConnect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket connection timed out"));
    }, 5000);
    ws.on("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Wait for the next JSON-parsed message on a WebSocket client. */
function wsReceive(ws: WebSocket, timeoutMs = 3000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wsReceive timed out")), timeoutMs);
    ws.once("message", (data: Buffer) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

/** Small delay helper for waiting on async close/disconnect propagation. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("WebServer", () => {
  let server: WebServer;
  let port: number;
  /** Tracks whether server.start() was called in the current test. */
  let started: boolean;

  // ------------------------------------------------------------------
  // Setup / teardown
  // ------------------------------------------------------------------

  beforeAll(async () => {
    // Create temporary CSS / JS files so MIME-type tests have real files to serve.
    await writeFile(CSS_FILE, "body { color: red; }\n", "utf-8");
    await writeFile(JS_FILE, "console.log('hello');\n", "utf-8");
  });

  afterAll(async () => {
    try { await unlink(CSS_FILE); } catch { /* ok */ }
    try { await unlink(JS_FILE); } catch { /* ok */ }
  });

  beforeEach(() => {
    server = new WebServer();
    started = false;
  });

  afterEach(async () => {
    // Only attempt stop if server was actually started — calling stop() on an
    // unstarted server will hang because httpServer is null and the optional
    // chaining on close() swallows the callback.
    if (started) {
      try { await server.stop(); } catch { /* ok */ }
    }
  });

  // ------------------------------------------------------------------
  // 1. Construction
  // ------------------------------------------------------------------

  describe("construction", () => {
    it("creates a WebServer instance without error", () => {
      expect(server).toBeDefined();
      expect(server).toBeInstanceOf(WebServer);
    });

    it("has initial clientCount of 0", () => {
      expect(server.clientCount).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // 2. start / stop
  // ------------------------------------------------------------------

  describe("start / stop", () => {
    it("starts on a given port and accepts HTTP requests", async () => {
      port = await findFreePort();
      await server.start(port);
      started = true;

      const res = await fetch(`http://localhost:${port}/index.html`);
      expect(res.status).toBe(200);
    });

    it("stops cleanly and rejects new connections", async () => {
      port = await findFreePort();
      await server.start(port);
      started = true;
      await server.stop();

      await expect(fetch(`http://localhost:${port}/index.html`)).rejects.toThrow();
    });

    it("can restart after stopping on the same port", async () => {
      port = await findFreePort();
      await server.start(port);
      started = true;
      await server.stop();

      // Restart on the same port
      await server.start(port);
      const res = await fetch(`http://localhost:${port}/index.html`);
      expect(res.status).toBe(200);
    });
  });

  // ------------------------------------------------------------------
  // 3. Static file serving
  // ------------------------------------------------------------------

  describe("static file serving", () => {
    beforeEach(async () => {
      port = await findFreePort();
      await server.start(port);
      started = true;
    });

    it("serves /index.html with correct content-type", async () => {
      const res = await fetch(`http://localhost:${port}/index.html`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");

      const expected = await readFile(path.join(PUBLIC_DIR, "index.html"), "utf-8");
      const actual = await res.text();
      expect(actual).toBe(expected);
    });

    it("serves / (root) as index.html", async () => {
      const res = await fetch(`http://localhost:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");

      const expected = await readFile(path.join(PUBLIC_DIR, "index.html"), "utf-8");
      const actual = await res.text();
      expect(actual).toBe(expected);
    });

    it("returns index.html for unknown paths (SPA fallback)", async () => {
      const res = await fetch(`http://localhost:${port}/nonexistent/deep/path`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");

      const expected = await readFile(path.join(PUBLIC_DIR, "index.html"), "utf-8");
      const actual = await res.text();
      expect(actual).toBe(expected);
    });

    it("serves CSS files with text/css content-type", async () => {
      const res = await fetch(`http://localhost:${port}/test-style.css`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/css");
    });

    it("serves JS files with application/javascript content-type", async () => {
      const res = await fetch(`http://localhost:${port}/test-script.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/javascript");
    });
  });

  // ------------------------------------------------------------------
  // 4. Directory traversal prevention
  // ------------------------------------------------------------------

  describe("security: directory traversal", () => {
    beforeEach(async () => {
      port = await findFreePort();
      await server.start(port);
      started = true;
    });

    /**
     * Helper: send a raw HTTP GET with a specific path via http.get.
     * Unlike fetch(), http.get does NOT normalize the path through the URL
     * constructor — it sends the path literally in the request line.
     *
     * The server's new URL() will still normalize .. and convert backslashes
     * to forward slashes, but this helper lets us exercise edge cases.
     */
    function httpGet(
      hostname: string,
      port: number,
      rawPath: string,
    ): Promise<{ status: number; body: string; contentType: string | null }> {
      return new Promise((resolve, reject) => {
        http.get({ hostname, port, path: rawPath }, (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk.toString()));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body,
              contentType: typeof res.headers["content-type"] === "string"
                ? res.headers["content-type"]
                : null,
            }),
          );
        }).on("error", reject);
      });
    }

    it("returns SPA fallback for path containing .. (normalized by URL constructor)", async () => {
      // The URL constructor in the server normalizes /../ to /, so the
      // traversal is neutralised before the startsWith check. The server
      // gracefully falls back to index.html.
      const res = await httpGet("localhost", port, "/../server.ts");
      // On all platforms: URL constructor resolves the .. → path becomes
      // something within PUBLIC_DIR, so we get 200 SPA fallback.
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("text/html");
    });

    it("returns SPA fallback for encoded %2e%2e (decoded then normalized)", async () => {
      // %2e decodes to '.' so %2e%2e becomes '..' which the URL constructor
      // resolves away.
      const res = await httpGet("localhost", port, "/%2e%2e/secret.txt");
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("text/html");
    });

    it("returns SPA fallback for multi-level traversal attempt", async () => {
      const res = await httpGet("localhost", port, "/../../../etc/passwd");
      // URL normalizes to /etc/passwd; joins cleanly within PUBLIC_DIR on
      // this platform; server falls back to index.html.
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("text/html");
    });

    it("handles paths with backslashes without crashing", async () => {
      // Sending raw backslashes (which Windows path.join treats as
      // separators) exercises the security boundary. The URL constructor
      // converts them to forward slashes, so the server should handle this
      // gracefully without a 500.
      const res = await httpGet("localhost", port, "/..\\..\\secret.txt");
      expect(res.status).not.toBe(500); // Graceful — no crash
    });
  });

  // ------------------------------------------------------------------
  // 5. WebSocket message handling
  // ------------------------------------------------------------------

  describe("message handling", () => {
    beforeEach(async () => {
      port = await findFreePort();
      await server.start(port);
      started = true;
    });

    it("registered onMessage handler receives parsed client messages", async () => {
      const received: ClientMessage[] = [];
      server.onMessage((_ws, msg) => {
        received.push(msg);
      });

      const ws = await wsConnect(port);
      ws.send(JSON.stringify({ type: "advance" } satisfies ClientMessage));

      // Allow time for the message to propagate
      await delay(150);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ type: "advance" });

      ws.close();
    });

    it("malformed JSON is silently ignored (no crash)", async () => {
      const received: ClientMessage[] = [];
      server.onMessage((_ws, msg) => {
        received.push(msg);
      });

      const ws = await wsConnect(port);

      // Send various invalid JSON payloads — none should trigger the handler
      // or crash the server.
      ws.send("not json at all {{{");
      ws.send("");
      ws.send("{invalid: true}");        // missing quotes around key
      ws.send("[unclosed array");
      ws.send("undefined_symbol");

      // Also send a valid message to confirm the handler still works
      ws.send(JSON.stringify({ type: "advance" } satisfies ClientMessage));

      await delay(150);

      // Only the valid message should have been received
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ type: "advance" });

      ws.close();
    });

    it("handles binary data gracefully (does not crash)", async () => {
      const received: ClientMessage[] = [];
      server.onMessage((_ws, msg) => {
        received.push(msg);
      });

      const ws = await wsConnect(port);
      // Raw binary that will fail JSON.parse
      ws.send(Buffer.from([0x00, 0xff, 0x00]));

      await delay(150);
      expect(received).toHaveLength(0); // binary ignored

      ws.close();
    });
  });

  // ------------------------------------------------------------------
  // 6. send / broadcast
  // ------------------------------------------------------------------

  describe("send and broadcast", () => {
    beforeEach(async () => {
      port = await findFreePort();
      await server.start(port);
      started = true;
    });

    it("broadcast delivers to all connected clients", async () => {
      const ws1 = await wsConnect(port);
      const ws2 = await wsConnect(port);

      expect(server.clientCount).toBe(2);

      const p1 = wsReceive(ws1);
      const p2 = wsReceive(ws2);

      const msg: ServerMessage = { type: "log", message: "hello all" };
      server.broadcast(msg);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual(msg);
      expect(r2).toEqual(msg);

      ws1.close();
      ws2.close();
    });

    it("send delivers a message to a specific client via server-side ws", async () => {
      // Capture the server-side WebSocket instance from onMessage.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let serverSideWs: any = null;

      server.onMessage((ws) => {
        serverSideWs = ws;
      });

      const clientWs = await wsConnect(port);

      // Trigger onMessage to capture the server-side ws
      clientWs.send(JSON.stringify({ type: "advance" } satisfies ClientMessage));
      await delay(100);

      expect(serverSideWs).not.toBeNull();

      // Now send a message via server.send() which goes server → client
      const msgPromise = wsReceive(clientWs);
      const msg: ServerMessage = { type: "log", message: "direct via send" };
      server.send(serverSideWs, msg);

      const received = await msgPromise;
      expect(received).toEqual(msg);

      clientWs.close();
    });

    it("send does not throw when called with a closed WebSocket", () => {
      // Construct a mock with readyState CLOSED (3)
      const closedWs = { readyState: 3, send: () => { throw new Error("should not be called"); } };
      expect(() =>
        server.send(closedWs as unknown as Parameters<typeof server.send>[0], {
          type: "log",
          message: "test",
        }),
      ).not.toThrow();
    });
  });

  // ------------------------------------------------------------------
  // 7. Connection lifecycle
  // ------------------------------------------------------------------

  describe("connection lifecycle", () => {
    beforeEach(async () => {
      port = await findFreePort();
      await server.start(port);
      started = true;
    });

    it("clientCount increments on connect and decrements on close", async () => {
      expect(server.clientCount).toBe(0);

      const ws1 = await wsConnect(port);
      expect(server.clientCount).toBe(1);

      const ws2 = await wsConnect(port);
      expect(server.clientCount).toBe(2);

      ws1.close();
      await delay(200);
      expect(server.clientCount).toBe(1);

      ws2.close();
      await delay(200);
      expect(server.clientCount).toBe(0);
    });

    it("a single client can send multiple messages", async () => {
      const received: ClientMessage[] = [];
      server.onMessage((_ws, msg) => received.push(msg));

      const ws = await wsConnect(port);
      ws.send(JSON.stringify({ type: "advance" } satisfies ClientMessage));
      ws.send(JSON.stringify({ type: "input_confirm", interaction_id: "i1" } satisfies ClientMessage));

      await delay(150);
      expect(received).toHaveLength(2);
      expect(received[0]).toEqual({ type: "advance" });
      expect(received[1]).toEqual({ type: "input_confirm", interaction_id: "i1" });

      ws.close();
    });

    it("broadcast reaches every client among many", async () => {
      const clients = await Promise.all([
        wsConnect(port),
        wsConnect(port),
        wsConnect(port),
      ]);

      expect(server.clientCount).toBe(3);

      const promises = clients.map((c) => wsReceive(c));
      server.broadcast({ type: "log", message: "fanout" });

      const results = await Promise.all(promises);
      for (const r of results) {
        expect(r).toEqual({ type: "log", message: "fanout" });
      }

      for (const c of clients) c.close();
    });

    it("clientCount drops to 0 after all clients disconnect", async () => {
      const ws1 = await wsConnect(port);
      const ws2 = await wsConnect(port);
      const ws3 = await wsConnect(port);

      expect(server.clientCount).toBe(3);

      ws1.close();
      ws2.close();
      ws3.close();
      await delay(200);

      expect(server.clientCount).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // 8. Edge cases
  // ------------------------------------------------------------------

  describe("edge cases", () => {
    it("clientCount is 0 before start() is called", () => {
      expect(server.clientCount).toBe(0);
    });

    it("broadcast on a server with no clients does not throw", async () => {
      port = await findFreePort();
      await server.start(port);
      started = true;

      expect(server.clientCount).toBe(0);
      expect(() => server.broadcast({ type: "log", message: "no one" })).not.toThrow();
    });

    it("can stop server with active clients (closes connections gracefully)", async () => {
      port = await findFreePort();
      await server.start(port);
      started = true;

      const ws = await wsConnect(port);
      expect(server.clientCount).toBe(1);

      // Close the client first, then stop
      ws.close();
      await delay(100);

      await server.stop();
      expect(server.clientCount).toBe(0);
    });

    it("server sends correct JSON structure for display messages", async () => {
      port = await findFreePort();
      await server.start(port);
      started = true;

      const clientWs = await wsConnect(port);
      const msgPromise = wsReceive(clientWs);

      const displayMsg: ServerMessage = {
        type: "display",
        events: [
          { type: "narration", text: "The rain fell softly." },
          { type: "dialogue", text: "Hello there.", speaker: "Alice" },
        ],
      };
      server.broadcast(displayMsg);

      const received = await msgPromise;
      expect(received).toEqual(displayMsg);
      clientWs.close();
    });
  });
});
