/**
 * RuntimeWebSocket — /ws/runtime (§8.1).
 *
 * Authenticates (session token + origin), enforces the single-controller
 * limit (§22 invariant 19), pushes the projection snapshot and descriptor
 * catalog on connect, forwards runtime outputs with a per-connection
 * sequence, forwards catalog + task-status events, and dedups commands by
 * commandId. JSON only — PCM never travels on this channel (§22 invariant
 * 12).
 */
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import type { Game } from "../../game.js";
import type { UiProjectionStore } from "../../application/ui/ui-projection-store.js";
import type {
  AudioCatalogEvent,
  AudioCatalogService,
} from "../../application/audio/audio-catalog-service.js";
import type { TaskStatusEvent } from "../../application/audio/tts-task-service.js";
import { ClientMessageSchema } from "../../shared/wire/schemas.js";
import type { ServerMessage } from "../../shared/wire/server-message.js";
import type { PublicWebConfig } from "../../shared/wire/public-web-config.js";
import type { RuntimeCommand } from "../../core/runtime/runtime-command.js";

export interface RuntimeWebSocketDeps {
  game: Game;
  projection: UiProjectionStore;
  catalog: AudioCatalogService;
  /** Subscribe bridge for TTS task status events (host: app.taskStatusSubscribe). */
  ttsStatus: (cb: (event: TaskStatusEvent) => void) => () => void;
  /** Start the game run loop on the first controller connection (§10.5). */
  startGame: () => void;
  /**
   * Host-owned session rebuild (LocalWebHost.handleRestart): the restart
   * command must never rely on the command queue — once the run loop has
   * exited (session ended or crashed) nothing would consume it.
   */
  onRestartSession: () => void;
  token: string;
  controllerLimit: number;
  originGuard: (origin: string | undefined) => boolean;
  publicConfig: PublicWebConfig;
}

const COMMAND_ID_DEDUP_CAP = 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;

interface ConnectionState {
  alive: boolean;
  /** Per-connection monotonic runtime.output sequence (survives a rebase). */
  sequence: number;
  /** Unsubscribes this socket from the currently bound game's outputs. */
  unsubGame: () => void;
}

export class RuntimeWebSocket {
  private game: Game;
  private readonly projection: UiProjectionStore;
  private readonly catalog: AudioCatalogService;
  private readonly ttsStatus: (cb: (event: TaskStatusEvent) => void) => () => void;
  private readonly token: string;
  private readonly controllerLimit: number;
  private readonly originGuard: (origin: string | undefined) => boolean;
  private readonly publicConfig: PublicWebConfig;
  private readonly deps: RuntimeWebSocketDeps;

  /** Accepted connections (all controllers; extras are rejected). */
  private readonly controllers = new Set<WebSocket>();
  private readonly connectionState = new Map<WebSocket, ConnectionState>();
  private readonly recentCommandIds = new Set<string>();
  private acceptingCommands = true;
  private sessionEnded = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(deps: RuntimeWebSocketDeps) {
    this.deps = deps;
    this.game = deps.game;
    this.projection = deps.projection;
    this.catalog = deps.catalog;
    this.ttsStatus = deps.ttsStatus;
    this.token = deps.token;
    this.controllerLimit = deps.controllerLimit;
    this.originGuard = deps.originGuard;
    this.publicConfig = deps.publicConfig;
  }

  /** Stop accepting runtime commands (shutdown step 1, §15.3). */
  stopAcceptingCommands(): void {
    this.acceptingCommands = false;
  }

  /**
   * Point the websocket at a freshly rebuilt game after a session restart
   * (RuntimeApplication.restart + restart_session command). Existing
   * controller connections are re-subscribed to the new game and receive a
   * fresh projection snapshot — restart() has already reset the projection,
   * so what goes out is the new session's clean state.
   */
  rebase(game: Game): void {
    this.game = game;
    this.sessionEnded = false;
    for (const ws of this.controllers) {
      const state = this.connectionState.get(ws);
      if (state === undefined) continue;
      this.bindGameSubscription(ws, state);
      this.send(ws, { type: "projection.snapshot", projection: this.projection.snapshot() });
    }
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
    if (this.controllers.size >= this.controllerLimit) {
      ws.close(4001, "controller-limit");
      return;
    }

    // §10.5: the browser's Start click opens this socket — the first
    // controller connection starts the story. Never start on a reconnect
    // (the host guards with its own flag).
    if (this.controllers.size === 0) {
      this.deps.startGame();
    }

    this.controllers.add(ws);
    const state: ConnectionState = { alive: true, sequence: 0, unsubGame: () => {} };
    this.connectionState.set(ws, state);
    this.ensureHeartbeat();

    // handleUpgrade invokes this callback while the socket is still
    // CONNECTING; `send` drops messages before OPEN, so defer the initial
    // snapshot + descriptor catalog until the handshake completes.
    setImmediate(() => {
      this.send(ws, { type: "projection.snapshot", projection: this.projection.snapshot() });
      for (const descriptor of this.catalog.listDescriptors()) {
        this.send(ws, { type: "audio.descriptor", descriptor });
      }
    });
    this.bindGameSubscription(ws, state);
    const unsubCatalog = this.catalog.subscribe((event) => {
      this.send(ws, this.mapCatalogEvent(event));
    });
    const unsubStatus = this.ttsStatus((event) => {
      this.send(ws, taskStatusMessage(event));
    });

    ws.on("pong", () => {
      const state = this.connectionState.get(ws);
      if (state) state.alive = true;
    });
    ws.on("message", (data) => {
      this.onMessage(data);
    });
    ws.on("close", () => {
      const state = this.connectionState.get(ws);
      state?.unsubGame();
      unsubCatalog();
      unsubStatus();
      this.connectionState.delete(ws);
      this.controllers.delete(ws);
      if (this.controllers.size === 0) this.stopHeartbeat();
      // Once the run loop has finished, no socket can ever drive the game
      // again; close the rest so clients reconnect to a fresh snapshot.
      if (this.sessionEnded && this.controllers.size > 0) {
        this.closeAllControllers();
      }
    });
    ws.on("error", () => {
      // The close event follows; nothing to recover here.
    });
  }

  /** Subscribe one controller to the bound game, replacing any prior binding. */
  private bindGameSubscription(ws: WebSocket, state: ConnectionState): void {
    state.unsubGame();
    state.unsubGame = this.game.subscribe((output) => {
      if (output.type === "session_ended") this.sessionEnded = true;
      this.send(ws, { type: "runtime.output", sequence: ++state.sequence, output });
    });
  }

  private onMessage(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) return;
    const message = result.data;
    switch (message.type) {
      case "runtime.command": {
        if (!this.acceptingCommands) return;
        if (this.recentCommandIds.has(message.commandId)) return; // dedup
        if (this.recentCommandIds.size >= COMMAND_ID_DEDUP_CAP) {
          this.recentCommandIds.clear();
        }
        this.recentCommandIds.add(message.commandId);
        if (message.command.type === "restart_session") {
          // Session rebuilds are host-owned: after a session end the run
          // loop has exited and a queued command would never be consumed.
          this.deps.onRestartSession();
          return;
        }
        this.game.dispatch(message.command);
        break;
      }
      case "audio.cache_report":
      case "audio.buffer_report":
      case "client.ready":
        // Acknowledged; no wire reply. Metrics/logging are the host's concern.
        break;
    }
  }

  private mapCatalogEvent(event: AudioCatalogEvent): ServerMessage {
    switch (event.type) {
      case "descriptor":
        return { type: "audio.descriptor", descriptor: event.descriptor };
      case "invalidated":
        return { type: "audio.invalidated", lineId: event.lineId, reason: event.reason };
      case "priority_changed":
        return { type: "audio.priority_changed", lineId: event.lineId, priority: event.priority };
    }
  }

  private extractToken(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null;
    try {
      return new URL(rawUrl, "http://localhost").searchParams.get("token");
    } catch {
      return null;
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, state] of this.connectionState) {
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

  private closeAllControllers(): void {
    for (const ws of this.controllers) {
      ws.close(1000, "session ended");
    }
  }
}

function taskStatusMessage(event: TaskStatusEvent): ServerMessage {
  const message: {
    type: "audio.task_status";
    taskId: string;
    lineId: string;
    status: "started" | "finished" | "failed" | "canceled";
    error?: string;
    totalBytes?: number;
  } = {
    type: "audio.task_status",
    taskId: event.taskId,
    lineId: event.lineId,
    status: event.status,
  };
  if (event.error !== undefined) message.error = event.error;
  if (event.totalBytes !== undefined) message.totalBytes = event.totalBytes;
  return message;
}
