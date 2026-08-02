/**
 * LocalWebHost — the single-process local web host (§6, §8).
 *
 * One Node process: static serving (Vite middleware in dev, `dist/web` in
 * prod), the `/ws/runtime` JSON WebSocket, the POST /api/audio/synthesize
 * PCM route, and GET /api/config. Binds only `127.0.0.1` (§22 invariant
 * 20) and enforces the Local Session Token + origin checks (§8.3).
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppConfig } from "../../config.js";
import { toPublicWebConfig } from "../../config/public-web-config.js";
import type { PublicWebConfig } from "../../shared/wire/public-web-config.js";
import type { RuntimeApplication } from "../../application/runtime-application.js";
import { RuntimeShutdownError } from "../../game.js";
import { isAllowedOrigin } from "./origin-guard.js";
import { AudioStreamRoute } from "./audio-stream-route.js";
import { RuntimeWebSocket } from "./runtime-websocket.js";
import { createViteDevMiddleware, type ViteDevMiddleware } from "./vite-middleware.js";
import { openBrowser } from "./open-browser.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_WEB_DIST_DIR = path.join(PROJECT_ROOT, "dist", "web");
/** Test seam: point the prod static handler at a different dist directory. */
const WEB_DIST_DIR_ENV = "LLM_GALGAME_WEB_DIST_DIR";

export interface LocalWebHostOptions {
  config: AppConfig;
  app: RuntimeApplication;
  dev: boolean;
  logger?: (line: string) => void;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

export class LocalWebHost {
  private readonly config: AppConfig;
  private readonly app: RuntimeApplication;
  private readonly dev: boolean;
  private readonly logger: (line: string) => void;
  private readonly token: string;
  private readonly publicConfig: PublicWebConfig;
  private readonly runtimeWs: RuntimeWebSocket;
  private readonly audioRoute: AudioStreamRoute;
  private readonly distRoot: string;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private devMiddleware: ViteDevMiddleware | null = null;
  private shutdownCalled = false;

  constructor(options: LocalWebHostOptions) {
    this.config = options.config;
    this.app = options.app;
    this.dev = options.dev;
    this.logger = options.logger ?? (() => {});
    this.token = randomBytes(16).toString("hex");
    this.publicConfig = toPublicWebConfig(this.config);
    this.distRoot = process.env[WEB_DIST_DIR_ENV]
      ? path.resolve(process.env[WEB_DIST_DIR_ENV])
      : DEFAULT_WEB_DIST_DIR;

    const host = this.config.local_web.host;
    const port = this.config.local_web.port;
    this.runtimeWs = new RuntimeWebSocket({
      game: this.app.game,
      projection: this.app.projection,
      catalog: this.app.audioCatalog,
      ttsStatus: (cb) => this.app.taskStatusSubscribe(cb),
      token: this.token,
      controllerLimit: this.config.local_web.controller_limit,
      originGuard: (origin) => isAllowedOrigin(origin, host, port),
      publicConfig: this.publicConfig,
    });
    this.audioRoute = new AudioStreamRoute({
      ttsTasks: this.app.ttsTasks,
      catalog: this.app.audioCatalog,
      token: this.token,
    });
  }

  /** The Local Session Token the browser must echo on WS and TTS requests. */
  getToken(): string {
    return this.token;
  }

  async start(): Promise<{ url: string; port: number }> {
    const host = this.config.local_web.host;
    const configuredPort = this.config.local_web.port > 0 ? this.config.local_web.port : 0;

    const server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    this.httpServer = server;

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    server.on("upgrade", (req, socket, head) => {
      const pathname = (req.url ?? "/").split("?")[0];
      if (pathname === "/ws/runtime") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.runtimeWs.handle(ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    if (this.dev) {
      this.devMiddleware = await createViteDevMiddleware();
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(configuredPort, host, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });

    const address = server.address();
    const actualPort =
      typeof address === "object" && address !== null ? address.port : configuredPort;

    // The run loop consumes browser commands; it exits on shutdown or story
    // end (RuntimeShutdownError is the expected shutdown path).
    void this.app.game.run().catch((error: unknown) => {
      if (error instanceof RuntimeShutdownError) return;
      this.logger(
        `game run loop exited: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    const url = `http://${host}:${actualPort}/`;
    if (this.config.local_web.open_browser) {
      // The page URL carries the session token so the browser can pass it
      // back on WS connect and TTS POSTs (§8.3).
      void openBrowser(`${url}?token=${this.token}`).catch(() => {
        this.logger("could not open a browser; continuing without one");
      });
    }
    return { url, port: actualPort };
  }

  /** §15.3 order: stop commands → abort runtime → close WS → close HTTP → close vite. */
  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;

    // 1) stop accepting runtime commands
    this.runtimeWs.stopAcceptingCommands();

    // 2) abort active LLM/TTS and persist state (app dispatches shutdown)
    await this.app.shutdown();

    // 3) close WebSocket clients
    const wss = this.wss;
    if (wss) {
      for (const client of wss.clients) {
        client.close(1001, "server shutting down");
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        for (const client of wss.clients) client.terminate();
      }, 1000);
      timer.unref();
      wss.close(() => {
        clearTimeout(timer);
        resolve();
      });
      await promise;
    }

    // 4) close the HTTP server (releases keep-alive + upgraded sockets)
    const server = this.httpServer;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    // 5) close the Vite dev middleware
    if (this.devMiddleware) {
      await this.devMiddleware.close();
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "POST" && pathname === "/api/audio/synthesize") {
      void this.audioRoute.handle(req, res);
      return;
    }
    if (req.method === "GET" && pathname === "/api/config") {
      this.sendJson(res, 200, this.publicConfig);
      return;
    }
    if (pathname.startsWith("/api/")) {
      this.sendJson(res, 404, { error: "not found" });
      return;
    }
    this.serveStatic(req, res);
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    if (this.devMiddleware) {
      this.devMiddleware.middleware(req, res, () => {
        this.sendJson(res, 404, { error: "not found" });
      });
    } else {
      void serveFile(this.distRoot, req, res);
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

/**
 * Minimal static file handler for the production bundle (`dist/web`).
 * Extension-based content types, path-traversal guard, SPA fallback to
 * index.html for extensionless routes.
 */
async function serveFile(rootDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }
    const pathname = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(rootDir, relative);
    const rootResolved = path.resolve(rootDir);
    if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }

    let content: Buffer | null = null;
    try {
      content = await readFile(filePath);
    } catch {
      // SPA fallback: extensionless routes render the app shell.
      if (path.extname(filePath) === "") {
        content = await readFile(path.join(rootDir, "index.html")).catch(() => null);
      }
    }
    if (content === null) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("internal server error");
    } else if (!res.destroyed) {
      res.destroy();
    }
  }
}
