/**
 * MonitorWebSocket — /ws/monitor (docs/monitor-dashboard.md).
 *
 * Read-only observability channel for the monitor dashboard: authenticates
 * with the same Local Session Token + origin guard as /ws/runtime, but has
 * no controller semantics — any number of dashboard tabs may connect, and
 * nothing a dashboard sends can reach the game. On connect the full
 * MonitorSnapshot goes out; afterwards hub events and changed state frames
 * are forwarded verbatim.
 */
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import type { MonitorHub } from "../../application/monitor/monitor-hub.js";
import type { MonitorServerMessage } from "../../shared/wire/monitor-message.js";

export interface MonitorWebSocketDeps {
  hub: MonitorHub;
  token: string;
  originGuard: (origin: string | undefined) => boolean;
  /** Max simultaneous dashboard connections (default 8). */
  connectionLimit?: number;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

interface ConnectionState {
  alive: boolean;
  unsubscribe: () => void;
}

export class MonitorWebSocket {
  private readonly hub: MonitorHub;
  private readonly token: string;
  private readonly originGuard: (origin: string | undefined) => boolean;
  private readonly connectionLimit: number;
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(deps: MonitorWebSocketDeps) {
    this.hub = deps.hub;
    this.token = deps.token;
    this.originGuard = deps.originGuard;
    this.connectionLimit = deps.connectionLimit ?? 8;
  }

  handle(ws: WebSocket, req: IncomingMessage): void {
    if (this.extractToken(req.url) !== this.token) {
      ws.terminate();
      return;
    }
    if (!this.originGuard(req.headers.origin)) {
      ws.terminate();
      return;
    }
    if (this.connections.size >= this.connectionLimit) {
      ws.close(4001, "monitor-connection-limit");
      return;
    }

    const send = (message: MonitorServerMessage): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(message));
    };

    // handleUpgrade runs while the socket is still CONNECTING; defer the
    // snapshot until the handshake completes (mirrors RuntimeWebSocket).
    setImmediate(() => {
      send({ type: "monitor.snapshot", snapshot: this.hub.snapshot() });
    });
    const unsubscribe = this.hub.subscribe(send);

    this.connections.set(ws, { alive: true, unsubscribe });
    this.ensureHeartbeat();

    ws.on("pong", () => {
      const state = this.connections.get(ws);
      if (state !== undefined) state.alive = true;
    });
    ws.on("message", () => {
      // Read-only channel: dashboard inbound traffic is ignored on purpose.
    });
    ws.on("close", () => {
      const state = this.connections.get(ws);
      state?.unsubscribe();
      this.connections.delete(ws);
      if (this.connections.size === 0) this.stopHeartbeat();
    });
    ws.on("error", () => {
      // The close event follows; nothing to recover here.
    });
  }

  /** Close every dashboard connection (shutdown step; host-owned). */
  close(): void {
    for (const ws of this.connections.keys()) {
      ws.close(1001, "server shutting down");
    }
    const timer = setTimeout(() => {
      for (const ws of this.connections.keys()) ws.terminate();
    }, 1000);
    timer.unref();
    this.stopHeartbeat();
  }

  private extractToken(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null;
    try {
      return new URL(rawUrl, "http://localhost").searchParams.get("token");
    } catch {
      return null;
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, state] of this.connections) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (!state.alive) {
          ws.terminate();
          continue;
        }
        state.alive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
