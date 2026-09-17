/**
 * MonitorClient — the dashboard's connection layer for /ws/monitor.
 *
 * A trimmed mirror of RuntimeClient: connect + exponential-backoff
 * reconnect, JSON decode, and a light structural guard (the server is
 * trusted; only `type` is checked). Read-only — the dashboard never sends.
 */
import type { MonitorServerMessage } from "@shared/wire/monitor-message.js";

export type MonitorConnectionState = "connecting" | "open" | "closed";

export interface MonitorClientOptions {
  wsUrl: string;
  token: string;
  onMessage(message: MonitorServerMessage): void;
  onConnectionChange(state: MonitorConnectionState): void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
}

export class MonitorClient {
  private ws: WebSocketLike | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyClosed = false;
  private state: MonitorConnectionState | "idle" = "idle";

  constructor(private readonly options: MonitorClientOptions) {}

  connect(): void {
    this.manuallyClosed = false;
    if (this.retryTimer === null && this.ws === null) this.openSocket();
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
    this.setConnectionState("closed");
  }

  private openSocket(): void {
    const url = new URL(this.options.wsUrl);
    if (this.options.token.length > 0) url.searchParams.set("token", this.options.token);
    const ws = new WebSocket(url.toString()) as WebSocketLike;
    this.ws = ws;
    this.setConnectionState("connecting");
    ws.onopen = () => this.handleOpen(ws);
    ws.onmessage = (ev) => this.handleMessage(ws, ev);
    ws.onclose = () => this.handleClose(ws);
    ws.onerror = () => {
      // close follows.
    };
  }

  private handleOpen(ws: WebSocketLike): void {
    if (this.ws !== ws) return;
    this.setConnectionState("open");
    this.backoffMs = INITIAL_BACKOFF_MS;
  }

  private handleMessage(ws: WebSocketLike, ev: MessageEvent): void {
    if (this.ws !== ws) return;
    if (typeof ev.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      return;
    }
    this.options.onMessage(parsed as MonitorServerMessage);
  }

  private handleClose(ws: WebSocketLike): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.setConnectionState("closed");
    if (!this.manuallyClosed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.retryTimer !== null || this.ws !== null) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.openSocket();
    }, delay);
  }

  private setConnectionState(next: MonitorConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onConnectionChange(next);
  }
}
