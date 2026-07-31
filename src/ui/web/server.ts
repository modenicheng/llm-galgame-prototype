/**
 * WebSocket + HTTP server for the GalGame web UI.
 *
 * Serves static files and relays real-time game communication between the
 * browser frontend and the GameBridge.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket as WsImpl } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------------------------------------------------------------------------
// Message types (mirrored from the protocol spec)
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: "display"; events: DisplayEvent[] }
  | { type: "interaction"; interaction: InteractionPayload }
  | { type: "autocomplete"; result: AutocompletePayload | null }
  | { type: "state"; state: UIStatePayload }
  | { type: "log"; message: string };

export type ClientMessage =
  | { type: "input_change"; text: string; interaction_id: string; revision: number }
  | { type: "input_confirm"; interaction_id: string }
  | { type: "input_cancel"; interaction_id: string }
  | { type: "option_select"; option_id: string; interaction_id: string }
  | { type: "advance" }
  | { type: "advance_ack" }
  | { type: "preview_confirm" }
  | { type: "preview_cancel" }
  | { type: "hybrid_choice"; option_id: string }
  | { type: "hybrid_input"; text: string }
  | { type: "hybrid_cancel" }
  | { type: "composition_start" }
  | { type: "composition_end" };

// Sub-types for ServerMessage payloads
export interface DisplayEvent {
  type: "narration" | "dialogue" | "end";
  line_id?: string;
  text: string;
  speaker?: string;
  portrait?: {
    character: string;
    expression: string;
    position: string;
  } | null;
  ending_id?: string;
}

export interface InteractionPayload {
  interaction_id: string;
  prompt: string;
  mode: "choice" | "input" | "hybrid";
  options?: Array<{ id: string; text: string }> | undefined;
  input?: {
    kind: string;
    placeholder: string;
    max_length: number;
  } | undefined;
  /** Draft text (only for input/hybrid when in editor) */
  draft?: string | undefined;
  /** Whether we're in preview phase */
  preview_phase?: boolean | undefined;
  /** Frozen preview text */
  preview_text?: string | undefined;
  /** Whether the NPC response is still generating */
  generating_response?: boolean | undefined;
}

export interface AutocompletePayload {
  suffix: string;
  intent: string;
  confidence: number;
  revision: number;
}

export interface UIStatePayload {
  phase: string;
  message: string;
  buffered_events: number;
  buffered_dialogue_lines: number;
}

// ---------------------------------------------------------------------------
// WebServer
// ---------------------------------------------------------------------------

type MessageHandler = (ws: WsImpl, message: ClientMessage) => void;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export class WebServer {
  private httpServer: Server | null = null;
  private wss: import("ws").WebSocketServer | null = null;
  private handler: MessageHandler | null = null;

  async start(port: number): Promise<void> {
    const { WebSocketServer } = await import("ws");

    this.httpServer = createServer(async (req: IncomingMessage, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        let filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);

        // Prevent directory traversal
        if (!filePath.startsWith(PUBLIC_DIR)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

        try {
          const content = await readFile(filePath);
          res.writeHead(200, { "Content-Type": contentType });
          res.end(content);
        } catch {
          // SPA fallback: serve index.html for unknown paths
          const indexContent = await readFile(path.join(PUBLIC_DIR, "index.html"));
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(indexContent);
        }
      } catch (err) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });

    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws: WsImpl) => {
      ws.on("message", (raw: Buffer) => {
        try {
          const msg: ClientMessage = JSON.parse(raw.toString());
          this.handler?.(ws, msg);
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on("error", () => {
        // Connection errors are typically transient
      });
    });

    return new Promise<void>((resolve) => {
      this.httpServer!.listen(port, () => resolve());
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Send a message to a specific client. */
  send(ws: WsImpl, message: ServerMessage): void {
    if (ws.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(JSON.stringify(message));
    }
  }

  /** Broadcast a message to all connected clients. */
  broadcast(message: ServerMessage): void {
    this.wss?.clients.forEach((ws) => this.send(ws as WsImpl, message));
  }

  /** Get the number of connected clients. */
  get clientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  async stop(): Promise<void> {
    this.wss?.close();
    return new Promise<void>((resolve, reject) => {
      this.httpServer?.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
