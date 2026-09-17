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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppConfig } from "../../config.js";
import { toPublicWebConfig } from "../../config/public-web-config.js";
import type { PublicWebConfig } from "../../shared/wire/public-web-config.js";
import type { RuntimeApplication } from "../../application/runtime-application.js";
import type { AssetCatalog, PublicAssetManifest } from "../../core/assets/types.js";
import { buildPublicAssetManifest } from "../../application/assets/asset-manifest.js";
import { RestartRequestedError, RetraceRequestedError, RuntimeShutdownError } from "../../core/runtime/errors.js";
import { isAllowedOrigin } from "./origin-guard.js";
import { AudioStreamRoute } from "./audio-stream-route.js";
import { RuntimeWebSocket } from "./runtime-websocket.js";
import { createViteDevMiddleware, type ViteDevMiddleware } from "./vite-middleware.js";
import { openBrowser } from "./open-browser.js";
import { DEFAULT_GAMES_ROOT } from "../../bootstrap/create-runtime-application.js";

/** 「继续游戏」探测根：与 entrypoint 的 cwd 约定一致（不引 Node 专属状态）。 */
function gamesRootForWorldHint(): string {
  return process.cwd();
}

/**
 * Walk up from this module until a directory containing package.json is
 * found. Works in both layouts: dev (tsx: <repo>/src/hosts/local-web) and
 * prod (compiled: <repo>/dist/node/hosts/local-web).
 */
function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("无法定位项目根目录（未找到 package.json）");
}

const PROJECT_ROOT = findProjectRoot();
const DEFAULT_WEB_DIST_DIR = path.join(PROJECT_ROOT, "dist", "web");
/** Test seam: point the prod static handler at a different dist directory. */
const WEB_DIST_DIR_ENV = "LLM_GALGAME_WEB_DIST_DIR";

export interface LocalWebHostOptions {
  config: AppConfig;
  app: RuntimeApplication;
  dev: boolean;
  logger?: (line: string) => void;
  /** Asset catalog for manifest + /game-assets serving. 缺省时不启用资源服务。 */
  assetCatalog?: AssetCatalog;
  /**
   * M3.3 世界生成通道（直通开玩）：POST /api/worlds 时调用 create——
   * 实现方（entrypoint）负责生成世界、装配并返回新世界的 RuntimeApplication，
   * 宿主负责在进程内换绑（旧 app shutdown → rebase → run）。缺省时
   * /api/worlds 返回 404。
   */
  worlds?: {
    create: (text: string) => Promise<{ gameId: string; app: RuntimeApplication }>;
  };
  /**
   * M5.1 图视图通道：GET /api/graph 时调用 build——实现方（entrypoint）
   * 负责用当前 gameId 装配图存储并产出脱敏视图。缺省时 /api/graph 返回 404。
   * M5.4：settlement（结算）/gallery（图鉴）同理。
   */
  graph?: {
    build: (gameId: string) => Promise<import("../../application/graph/graph-view.js").GraphView>;
    settlement?: (gameId: string) => Promise<unknown>;
    gallery?: (gameId: string) => Promise<unknown>;
  };
  /** M5.5 ①：通关评分通道（rating 由玩家给定；评注由编剧 LLM 产出）。缺省 404。 */
  reviews?: {
    submit: (gameId: string, rating: number, sessionId: string) => Promise<unknown>;
  };
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
  private app: RuntimeApplication;
  private readonly dev: boolean;
  private readonly logger: (line: string) => void;
  private readonly token: string;
  private readonly publicConfig: PublicWebConfig;
  private readonly runtimeWs: RuntimeWebSocket;
  private readonly audioRoute: AudioStreamRoute;
  private readonly distRoot: string;
  private readonly assetRoot: string | null;
  private readonly assetManifest: PublicAssetManifest | null;
  private readonly worlds: LocalWebHostOptions["worlds"];
  private readonly graph: LocalWebHostOptions["graph"];
  private readonly reviews: LocalWebHostOptions["reviews"];
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private devMiddleware: ViteDevMiddleware | null = null;
  private shutdownCalled = false;

  constructor(options: LocalWebHostOptions) {
    this.config = options.config;
    this.app = options.app;
    this.worlds = options.worlds;
    this.graph = options.graph;
    this.reviews = options.reviews;
    this.dev = options.dev;
    this.logger = options.logger ?? (() => {});
    this.token = randomBytes(16).toString("hex");
    this.publicConfig = toPublicWebConfig(this.config);
    this.distRoot = process.env[WEB_DIST_DIR_ENV]
      ? path.resolve(process.env[WEB_DIST_DIR_ENV])
      : DEFAULT_WEB_DIST_DIR;

    // Explicit options win; fall back to the runtime's catalog so the
    // web.ts entrypoint (config/app/dev/logger only) keeps working
    // unchanged — app.assetCatalog is provided by createRuntimeApplication.
    const assetCatalog = options.assetCatalog ?? this.app.assetCatalog;
    this.assetRoot =
      assetCatalog !== undefined
        ? path.dirname(path.resolve(this.config.assets.catalog))
        : null;
    this.assetManifest =
      assetCatalog !== undefined
        ? buildPublicAssetManifest(assetCatalog, "/game-assets/")
        : null;

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
      startGame: () => this.startGame(),
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
    const url = `http://${host}:${actualPort}/`;

    // The page URL carries the session token so the browser can pass it
    // back on WS connect and TTS POSTs (§8.3). If auto-open is disabled or
    // fails, surface the token-bearing URL so the app stays reachable.
    const tokenUrl = `${url}?token=${this.token}`;
    if (this.config.local_web.open_browser) {
      void openBrowser(tokenUrl).catch(() => {
        this.logger("could not open a browser; continuing without one");
        this.logger(`open the game manually: ${tokenUrl}`);
      });
    } else {
      this.logger(`open the game manually: ${tokenUrl}`);
    }
    return { url, port: actualPort };
  }

  /**
   * Kick off the game run loop on the FIRST controller connection
   * (§10.5: the browser's Start click opens the WebSocket, which starts
   * the story). Never auto-runs at boot: that would burn LLM calls before
   * any player connects. Guarded so a reconnect (refresh) cannot start a
   * second run loop.
   */
  private gameStarted = false;

  private startGame(): void {
    if (this.gameStarted) return;
    this.gameStarted = true;
    void this.app.game.run().catch((error: unknown) => {
      // RuntimeShutdownError is the expected shutdown path.
      if (error instanceof RuntimeShutdownError) return;
      if (error instanceof RestartRequestedError) {
        void this.handleRestart();
        return;
      }
      if (error instanceof RetraceRequestedError) {
        void this.handleRetrace(error.decisionId);
        return;
      }
      this.logger(
        `game run loop exited: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /**
   * M5.3 回溯：同一 Game 实例在目标节点重入 run 循环（图零删除；旧周目
   * 已弃局记账）。ws 不换绑——客户端通过 session_started/表单重放观察。
   */
  private async handleRetrace(decisionId: string): Promise<void> {
    this.logger(`retracing to ${decisionId}…`);
    try {
      await this.app.game.prepareRetrace(decisionId);
    } catch (error: unknown) {
      this.logger(`retrace failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    void this.app.game.run().catch((error: unknown) => {
      if (error instanceof RuntimeShutdownError) return;
      this.logger(`game run loop exited after retrace: ${String(error)}`);
    });
  }

  /**
   * Rebuild the runtime with a fresh session id and restart the run loop
   * (Task 10: restart_session command). The websocket is rebased onto the
   * new game so reconnecting clients observe the fresh session.
   */
  private async handleRestart(): Promise<void> {
    this.logger("restarting session…");
    await this.app.restart();
    this.runtimeWs.rebase(this.app.game);
    void this.app.game.run().catch((error: unknown) => {
      if (error instanceof RuntimeShutdownError) return;
      this.logger(`game run loop exited after restart: ${String(error)}`);
    });
  }

  /**
   * M5.5 ①：通关评分提交（rating 1–5 由玩家给定；编剧评注在通道实现内产出）。
   */
  private async handleReviewSubmission(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = (await this.readJsonBody(req)) as { rating?: unknown };
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        this.sendJson(res, 400, { error: "rating must be an integer 1–5" });
        return;
      }
      const review = await this.reviews!.submit(this.app.gameId, rating, this.app.game.currentSessionId);
      this.sendJson(res, 200, review);
    } catch (error) {
      this.sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * M3.3 直通开玩：把运行时整体换成新世界的 RuntimeApplication。旧 app
   * 正常关停（落盘），websocket rebase 到新 game 并重开 run 循环。
   */
  private async handleWorldCreation(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = (await this.readJsonBody(req)) as { text?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length === 0) {
        this.sendJson(res, 400, { error: "text required" });
        return;
      }
      const { gameId, app } = await this.worlds!.create(text);
      this.logger(`world created: ${gameId}; swapping runtime…`);
      await this.app.shutdown();
      this.app = app;
      this.runtimeWs.rebase(this.app.game);
      void this.app.game.run().catch((error: unknown) => {
        if (error instanceof RuntimeShutdownError) return;
        this.logger(`game run loop exited after world swap: ${String(error)}`);
      });
      this.sendJson(res, 200, { gameId });
    } catch (error) {
      this.logger(`world creation failed: ${String(error)}`);
      this.sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async readJsonBody(req: IncomingMessage, maxBytes = 65536): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
    const raw = await promise;
    if (raw.trim().length === 0) return {};
    return JSON.parse(raw) as unknown;
  }

  /** 是否已有可玩世界（当前 app 的世界大纲已落盘；未知 id → 无）。 */
  private hasWorld(): boolean {
    const gameId = this.app.gameId;
    if (gameId === undefined) return false;
    return existsSync(
      path.join(gamesRootForWorldHint(), DEFAULT_GAMES_ROOT, gameId, "outline.json"),
    );
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
      this.sendJson(res, 200, { ...this.publicConfig, has_world: this.hasWorld() });
      return;
    }
    if (req.method === "POST" && pathname === "/api/worlds") {
      if (this.worlds === undefined) {
        this.sendJson(res, 404, { error: "world creation unavailable" });
        return;
      }
      void this.handleWorldCreation(req, res);
      return;
    }
    if (req.method === "POST" && pathname === "/api/reviews") {
      if (this.reviews === undefined) {
        this.sendJson(res, 404, { error: "review submission unavailable" });
        return;
      }
      void this.handleReviewSubmission(req, res);
      return;
    }
    if (req.method === "GET" && pathname === "/api/graph/settlement") {
      if (this.graph?.settlement === undefined) {
        this.sendJson(res, 404, { error: "settlement view unavailable" });
        return;
      }
      this.graph
        .settlement(this.app.gameId)
        .then((view) => this.sendJson(res, 200, view))
        .catch((err: unknown) => {
          this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }
    if (req.method === "GET" && pathname === "/api/graph/gallery") {
      if (this.graph?.gallery === undefined) {
        this.sendJson(res, 404, { error: "gallery view unavailable" });
        return;
      }
      this.graph
        .gallery(this.app.gameId)
        .then((view) => this.sendJson(res, 200, view))
        .catch((err: unknown) => {
          this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }
    if (req.method === "GET" && pathname === "/api/graph") {
      if (this.graph === undefined) {
        this.sendJson(res, 404, { error: "graph view unavailable" });
        return;
      }
      this.graph
        .build(this.app.gameId)
        .then((view) => this.sendJson(res, 200, view))
        .catch((err: unknown) => {
          this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }
    if (req.method === "GET" && pathname === "/api/assets/manifest") {
      if (this.assetManifest === null) {
        this.sendJson(res, 404, { error: "asset catalog unavailable" });
        return;
      }
      this.sendJson(res, 200, this.assetManifest);
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/game-assets/")) {
      if (this.assetRoot === null) {
        this.sendJson(res, 404, { error: "asset catalog unavailable" });
        return;
      }
      void serveAssetFile(this.assetRoot, req, res, pathname);
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

/**
 * Asset file MIME table: static types plus the media extensions the
 * asset catalog can reference (webp/jpg/jpeg/ogg/mp3/wav).
 */
const ASSET_MIME_TYPES: Record<string, string> = {
  ...MIME_TYPES,
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/**
 * Serve one asset file from the catalog root (spec §5.2). Same shape as
 * serveFile but with NO SPA fallback: an asset id always maps to a real
 * file or 404. Traversal (raw or percent-encoded) → 403.
 */
async function serveAssetFile(
  assetRoot: string,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("method not allowed");
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice("/game-assets/".length));
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("bad request");
    return;
  }
  const filePath = path.resolve(assetRoot, relative);
  const rootResolved = path.resolve(assetRoot);
  if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  let content: Buffer | null = null;
  try {
    content = await readFile(filePath);
  } catch {
    // fall through to 404
  }
  if (content === null) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type":
      ASSET_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : content);
}
