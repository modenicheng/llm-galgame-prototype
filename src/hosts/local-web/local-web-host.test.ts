/**
 * LocalWebHost tests: start on port 0, prod static serving from a temp
 * dist dir, GET /api/config, end-to-end TTS POST against the real wiring
 * with a fake app, the /ws/runtime upgrade path, and §15.3 shutdown order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { PNG } from "pngjs";
import { makeTestConfig } from "../../test-helpers.js";
import type { RuntimeApplication } from "../../application/runtime-application.js";
import { makeAssetCatalog } from "../../application/assets/asset-manifest.fixtures.js";
import type { Metrics } from "../../runtime/metrics.js";
import type { Game } from "../../game.js";
import type { UiProjectionStore } from "../../application/ui/ui-projection-store.js";
import type { TtsTaskService } from "../../application/audio/tts-task-service.js";
import { AudioCatalogServiceImpl } from "../../application/audio/audio-catalog-service.js";
import type { ServerMessage } from "../../shared/wire/server-message.js";
import { LocalWebHost } from "./local-web-host.js";
import {
  FakeTtsTasks,
  makeFakeGame,
  makeFakeProjection,
  makeSession,
  testDescriptor,
  testRecipe,
} from "./test-fakes.js";

const DIST_ENV = "LLM_GALGAME_WEB_DIST_DIR";

function makeConfig(overrides?: Parameters<typeof makeTestConfig>[0]) {
  return makeTestConfig({
    app: { default_host: "web" },
    local_web: { host: "127.0.0.1", port: 0, open_browser: false, controller_limit: 1 },
    characters: {},
    media: {
      audio: {
        enabled: true,
        provider: "mock",
        active_target_lines: 3,
        refill_threshold_lines: 2,
        branch_prefetch_lines: 2,
        batch_size: 2,
        max_concurrency: 2,
        mock_latency_ms: 0,
        output_dir: "assets/audio",
        planner: { candidate_prefetch_lines: 1, max_active_future_lines: 4 },
        playback: {
          startup_buffer_ms: 350,
          critical_watermark_ms: 500,
          low_watermark_ms: 2500,
          target_buffer_ms: 6500,
          voice_delay_ms: 0,
        },
        synthesis: {
          provider: "mock",
          max_concurrency: 2,
          model_profile: "cosyvoice_v3_flash",
          api_key_env: "DASHSCOPE_API_KEY",
          format: "pcm_s16le",
          sample_rate: 22050,
        },
        cache: {
          max_bytes: 536_870_912,
          cleanup_target_bytes: 402_653_184,
          write_batch_bytes: 262_144,
          write_flush_interval_ms: 300,
          partial_ttl_minutes: 10,
          candidate_ttl_hours: 1,
        },
      },
    },
    ...overrides,
  });
}

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  buffer: Buffer;
}

function request(
  port: number,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResult> {
  const { promise, resolve } = Promise.withResolvers<HttpResult>();
  const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => {
      const buffer = Buffer.concat(chunks);
      resolve({ status: res.statusCode ?? 0, headers: res.headers, text: buffer.toString("utf8"), buffer });
    });
  });
  req.on("error", (error) => {
    resolve({ status: 0, headers: {}, text: String(error), buffer: Buffer.alloc(0) });
  });
  if (body !== undefined) req.end(body);
  else req.end();
  return promise;
}

describe("LocalWebHost", () => {
  let distDir: string;
  let config: ReturnType<typeof makeConfig>;
  let catalog: AudioCatalogServiceImpl;
  let tts: FakeTtsTasks;
  let game: ReturnType<typeof makeFakeGame>;
  let projection: ReturnType<typeof makeFakeProjection>;
  let app: RuntimeApplication;
  let host: LocalWebHost;
  let port: number;

  beforeEach(async () => {
    distDir = mkdtempSync(path.join(tmpdir(), "web-dist-"));
    mkdirSync(path.join(distDir, "assets"));
    writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>galgame</title>");
    writeFileSync(path.join(distDir, "assets", "app.js"), "console.log('hi');");
    process.env[DIST_ENV] = distDir;

    config = makeConfig();
    catalog = new AudioCatalogServiceImpl();
    catalog.upsertDescriptor(testDescriptor, testRecipe);
    tts = new FakeTtsTasks();
    tts.createSession = () => makeSession();
    game = makeFakeGame();
    projection = makeFakeProjection();
    const shutdown = vi.fn(async () => {});
    const taskStatusSubscribe = vi.fn((_cb: never) => () => {});
    app = {
      game: game.game,
      audioCatalog: catalog,
      ttsTasks: tts as TtsTaskService,
      projection: projection.projection,
      config,
      metrics: {} as unknown as Metrics,
      shutdown,
      taskStatusSubscribe,
    } as unknown as RuntimeApplication;

    host = new LocalWebHost({ config, app, dev: false, logger: () => {} });
    const started = await host.start();
    port = started.port;
  });

  it("binds 127.0.0.1 on an OS-assigned port and reports the URL", async () => {
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("logs the token-bearing URL when auto-open is disabled", async () => {
    const lines: string[] = [];
    const host2 = new LocalWebHost({
      config,
      app,
      dev: false,
      logger: (line) => lines.push(line),
    });
    const started = await host2.start();

    // The returned URL stays token-free; the logged line carries the token
    // so the app stays reachable when no browser is opened.
    expect(started.url).not.toContain("token=");
    expect(lines).toContain(`open the game manually: ${started.url}?token=${host2.getToken()}`);
    await host2.shutdown();
  });

  it("serves index.html from the prod dist dir", async () => {
    const result = await request(port, "GET", "/");
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.text).toContain("galgame");
  });

  it("serves static assets with extension-based content types", async () => {
    const result = await request(port, "GET", "/assets/app.js");
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("text/javascript");
    expect(result.text).toBe("console.log('hi');");
  });

  it("falls back to index.html for extensionless SPA routes", async () => {
    const result = await request(port, "GET", "/some/spa/route");
    expect(result.status).toBe(200);
    expect(result.text).toContain("galgame");
  });

  it("returns 404 for missing files with extensions", async () => {
    expect((await request(port, "GET", "/missing.js")).status).toBe(404);
  });

  it("serves the public web config at GET /api/config", async () => {
    const result = await request(port, "GET", "/api/config");
    expect(result.status).toBe(200);
    const configJson = JSON.parse(result.text) as {
      audio: { format: { sampleRate: number }; playback: { target_buffer_ms: number } };
      game: { show_line_ids: boolean };
    };
    expect(configJson.audio.format.sampleRate).toBe(22050);
    expect(configJson.audio.playback.target_buffer_ms).toBe(6500);
    expect(configJson.game.show_line_ids).toBe(true);
  });

  it("serves the save archive at GET /api/saves", async () => {
    const savesDir = mkdtempSync(path.join(tmpdir(), "web-saves-"));
    try {
      mkdirSync(path.join(savesDir, "2026-09-16T09-00-00-000Z"), { recursive: true });
      writeFileSync(
        path.join(savesDir, "2026-09-16T09-00-00-000Z", "state.json"),
        JSON.stringify({ phase: "ended", ending: { ending_id: "end_a" } }),
      );
      const savesConfig = makeConfig({ game: { sessions_dir: savesDir } });
      const savesHost = new LocalWebHost({ config: savesConfig, app, dev: false, logger: () => {} });
      const started = await savesHost.start();
      try {
        const result = await request(started.port, "GET", "/api/saves");
        expect(result.status).toBe(200);
        const body = JSON.parse(result.text) as {
          saves: Array<{ sessionId: string; phase?: string; endingId?: string }>;
          stats: { totalSaves: number; ended: number; endings: Record<string, number> };
        };
        expect(body.saves).toHaveLength(1);
        const save = body.saves[0];
        expect(save?.sessionId).toBe("2026-09-16T09-00-00-000Z");
        expect(save?.phase).toBe("ended");
        expect(save?.endingId).toBe("end_a");
        expect(body.stats.totalSaves).toBe(1);
        expect(body.stats.endings).toEqual({ end_a: 1 });
      } finally {
        await savesHost.shutdown();
      }
    } finally {
      rmSync(savesDir, { recursive: true, force: true });
    }
  });

  it("returns 404 JSON for unknown API paths", async () => {
    const result = await request(port, "GET", "/api/nope");
    expect(result.status).toBe(404);
    expect(JSON.parse(result.text)).toEqual({ error: "not found" });
  });

  it("without an assetCatalog the manifest endpoint returns 404", async () => {
    // The outer host is built without assetCatalog; the asset service must
    // stay disabled so pre-existing hosts behave unchanged.
    const result = await request(port, "GET", "/api/assets/manifest");
    expect(result.status).toBe(404);
  });

  describe("asset manifest + /game-assets serving (with assetCatalog)", () => {
    let assetDir: string;
    let assetHost: LocalWebHost;
    let assetPort: number;

    beforeEach(async () => {
      // Real files under a temp asset root, catalog injected via host
      // options so tests bypass the YAML loader while /game-assets still
      // exercises the on-disk file path.
      assetDir = mkdtempSync(path.join(tmpdir(), "asset-root-"));
      mkdirSync(path.join(assetDir, "backgrounds"), { recursive: true });
      mkdirSync(path.join(assetDir, "audio", "bgm"), { recursive: true });
      mkdirSync(path.join(assetDir, "characters", "suyao"), { recursive: true });
      writeFileSync(path.join(assetDir, "backgrounds", "basement.jpg"), "jpeg-bytes");
      writeFileSync(path.join(assetDir, "audio", "bgm", "mystery.mp3"), "mp3-bytes");
      writeFileSync(path.join(assetDir, "characters", "suyao", "anxious.png"), "png-bytes");

      const assetConfig = makeConfig({
        assets: { catalog: path.join(assetDir, "resources.yaml") },
      });
      assetHost = new LocalWebHost({
        config: assetConfig,
        app,
        dev: false,
        logger: () => {},
        assetCatalog: makeAssetCatalog(),
      });
      const started = await assetHost.start();
      assetPort = started.port;
    });

    afterEach(async () => {
      await assetHost.shutdown();
      rmSync(assetDir, { recursive: true, force: true });
    });

    it("GET /api/assets/manifest returns projected URLs", async () => {
      const result = await request(assetPort, "GET", "/api/assets/manifest");
      expect(result.status).toBe(200);
      const manifest = JSON.parse(result.text) as {
        backgrounds: Record<string, { url: string }>;
      };
      expect(manifest.backgrounds.basement?.url).toBe(
        "/game-assets/backgrounds/basement.jpg",
      );
      expect(result.text).not.toContain("assets/resources.yaml");
    });

    it("GET /game-assets/... serves the asset file with a content-type", async () => {
      const result = await request(assetPort, "GET", "/game-assets/backgrounds/basement.jpg");
      expect(result.status).toBe(200);
      expect(result.headers["content-type"]).toContain("image/jpeg");
      expect(result.text).toBe("jpeg-bytes");
    });

    it("GET /game-assets/../config.yaml rejects traversal", async () => {
      const result = await request(assetPort, "GET", "/game-assets/../config.yaml");
      expect(result.status).toBe(403);
    });

    it("GET /game-assets/%2e%2e/config.yaml rejects encoded traversal", async () => {
      const result = await request(assetPort, "GET", "/game-assets/%2e%2e/config.yaml");
      expect(result.status).toBe(403);
    });

    it("GET /game-assets/missing.png returns 404", async () => {
      const result = await request(assetPort, "GET", "/game-assets/missing.png");
      expect(result.status).toBe(404);
    });

    it("non-GET /game-assets/... is rejected with 405", async () => {
      const result = await request(assetPort, "POST", "/game-assets/backgrounds/basement.jpg");
      expect(result.status).toBe(405);
    });
  });

  describe("sprite presentation derivation (with derivedAssetRoot override)", () => {
    let assetDir: string;
    let derivedDir: string;
    let deriveHost: LocalWebHost;
    let derivePort: number;

    beforeEach(async () => {
      assetDir = mkdtempSync(path.join(tmpdir(), "derive-asset-root-"));
      derivedDir = mkdtempSync(path.join(tmpdir(), "derive-out-"));
      mkdirSync(path.join(assetDir, "characters", "cast"), { recursive: true });
      // 4×4 不透明 PNG（真字节，会被解码+重编码）。
      const png = new PNG({ width: 4, height: 4 });
      for (let i = 0; i < 4 * 4; i += 1) {
        png.data[i * 4] = 200;
        png.data[i * 4 + 1] = 100;
        png.data[i * 4 + 2] = 50;
        png.data[i * 4 + 3] = 255;
      }
      writeFileSync(path.join(assetDir, "characters", "cast", "base.png"), PNG.sync.write(png));

      const catalog = makeAssetCatalog();
      catalog.spriteSets.cast = {
        id: "cast",
        presentation: { normalize: true },
        variants: { base: { id: "base", src: "characters/cast/base.png" } },
      };
      deriveHost = new LocalWebHost({
        config: makeConfig({ assets: { catalog: path.join(assetDir, "resources.yaml") } }),
        app,
        dev: false,
        logger: () => {},
        assetCatalog: catalog,
        derivedAssetRoot: derivedDir,
      });
      const started = await deriveHost.start();
      derivePort = started.port;
    });

    afterEach(async () => {
      await deriveHost.shutdown();
      rmSync(assetDir, { recursive: true, force: true });
      rmSync(derivedDir, { recursive: true, force: true });
    });

    it("manifest URL 重写为派生路径，派生文件可经 /game-assets 取到", async () => {
      const manifest = await request(derivePort, "GET", "/api/assets/manifest");
      const body = JSON.parse(manifest.text) as {
        spriteSets: Record<string, { variants: Record<string, { url: string }> }>;
      };
      expect(body.spriteSets.cast!.variants.base!.url).toBe("/game-assets/__derived__/cast/base.png");

      const derived = await request(derivePort, "GET", "/game-assets/__derived__/cast/base.png");
      expect(derived.status).toBe(200);
      expect(derived.headers["content-type"]).toBe("image/png");
      const image = PNG.sync.read(derived.buffer);
      // normalize 裁掉透明边后 = 原图（整图不透明 → 尺寸不变）。
      expect(image.width).toBe(4);
      expect(image.height).toBe(4);
    });

    it("派生路径同样拒绝目录逃逸", async () => {
      const result = await request(derivePort, "GET", "/game-assets/__derived__/../secrets.txt");
      expect(result.status).toBe(403);
    });
  });

  it("streams synthesized PCM end-to-end with the session token", async () => {
    const result = await request(
      port,
      "POST",
      "/api/audio/synthesize",
      { "Content-Type": "application/json", "X-Session-Token": host.getToken() },
      JSON.stringify({ taskId: "task_1", lineId: "line_1", cacheKey: "cache_1" }),
    );
    expect(result.status).toBe(200);
    expect(result.headers["x-audio-encoding"]).toBe("pcm_s16le");
    expect(result.headers["x-audio-task-id"]).toBe("task_1");
    expect(result.text).toBe("\u0001\u0002\u0003\u0004\u0005");
  });

  it("rejects TTS without the session token", async () => {
    const result = await request(
      port,
      "POST",
      "/api/audio/synthesize",
      { "Content-Type": "application/json" },
      JSON.stringify({ taskId: "task_1", lineId: "line_1", cacheKey: "cache_1" }),
    );
    expect(result.status).toBe(401);
  });

  it("accepts a /ws/runtime connection with token and origin", async () => {
    const { promise, resolve } = Promise.withResolvers<ServerMessage>();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/runtime?token=${host.getToken()}`, {
      origin: `http://127.0.0.1:${port}`,
    });
    ws.on("message", (data) => resolve(JSON.parse(String(data)) as ServerMessage));
    ws.on("error", (error) => resolve({ type: "runtime_error", code: "ws", message: String(error) } as never));
    const message = await promise;
    expect(message.type).toBe("projection.snapshot");
    ws.terminate();
    await sleep(20);
  });

  it("destroys non-runtime WebSocket upgrade attempts", async () => {
    const { promise, resolve } = Promise.withResolvers<number>();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`, {
      origin: `http://127.0.0.1:${port}`,
    });
    ws.on("close", (code) => resolve(code));
    ws.on("error", () => {});
    const code = await promise;
    expect(code).toBe(1006);
  });

  it("rebuilds the runtime on restart_session and pushes the fresh snapshot", async () => {
    // Fake RuntimeApplication.restart: mirror create-runtime-application —
    // reset the projection and swap in a fresh game under the same app.
    const nextGame = makeFakeGame();
    const restart = vi.fn(async () => {
      projection.reset("sess-next");
      app.game = nextGame.game;
      return app;
    });
    (app as unknown as { restart: unknown }).restart = restart;

    const { promise: open, resolve: resolveOpen } = Promise.withResolvers<void>();
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/runtime?token=${host.getToken()}`, {
      origin: `http://127.0.0.1:${port}`,
    });
    ws.on("open", () => resolveOpen());
    ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
    ws.on("error", () => {});
    await open;
    const start = Date.now();
    while (!messages.some((m) => m.type === "projection.snapshot")) {
      if (Date.now() - start > 2000) throw new Error("no initial snapshot");
      await sleep(5);
    }

    ws.send(
      JSON.stringify({
        type: "runtime.command",
        commandId: "cmd-restart-1",
        command: { type: "restart_session" },
      }),
    );

    // The host unwinds the old loop via a dispatched command, rebuilds the
    // app, rebases the websocket and starts the fresh run loop.
    let restartCalls = 0;
    let nextRuns = 0;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      restartCalls = restart.mock.calls.length;
      nextRuns = (nextGame.game as unknown as { run: { mock: { calls: unknown[] } } }).run.mock
        .calls.length;
      const freshSnapshot = messages.some(
        (m) =>
          m.type === "projection.snapshot" &&
          (m as { projection: { sessionId?: string } }).projection.sessionId === "sess-next",
      );
      if (restartCalls === 1 && nextRuns === 1 && freshSnapshot) break;
      await sleep(5);
    }
    expect(restartCalls).toBe(1);
    expect(nextRuns).toBe(1);
    expect(
      messages.some(
        (m) =>
          m.type === "projection.snapshot" &&
          (m as { projection: { sessionId?: string } }).projection.sessionId === "sess-next",
      ),
    ).toBe(true);
    expect(game.dispatch).toHaveBeenCalledWith({ type: "restart_session" });
    ws.terminate();
    await sleep(20);
  });

  it("broadcasts run_loop_exited to controllers when the run loop dies", async () => {
    // Simulate an API timeout killing the run loop before the game emitted
    // anything: the browser must get a notice instead of waiting forever.
    (game.game as unknown as { run: () => Promise<void> }).run = vi.fn(async () => {
      throw new Error("Request timed out");
    });
    const messages: ServerMessage[] = [];
    const { promise: open, resolve: resolveOpen } = Promise.withResolvers<void>();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/runtime?token=${host.getToken()}`, {
      origin: `http://127.0.0.1:${port}`,
    });
    ws.on("open", () => resolveOpen());
    ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
    ws.on("error", () => {});
    await open;
    const start = Date.now();
    while (
      !messages.some(
        (m) =>
          m.type === "runtime.output" &&
          (m as { output?: { type?: string; code?: string } }).output?.type === "runtime_error",
      )
    ) {
      if (Date.now() - start > 2000) throw new Error("no run_loop_exited broadcast");
      await sleep(5);
    }
    const notice = messages.find(
      (m) => m.type === "runtime.output",
    ) as Extract<ServerMessage, { type: "runtime.output" }>;
    const output = notice.output as { code: string; message: string };
    expect(output.code).toBe("run_loop_exited");
    expect(output.message).toContain("Request timed out");
    // The projection flips to error so a reconnecting browser restores the
    // ERROR picture instead of a silent waiting screen.
    expect(projection.projection.applyOutput).toHaveBeenCalledWith(
      expect.objectContaining({ type: "runtime_error", code: "run_loop_exited" }),
    );
    ws.terminate();
    await sleep(20);
  });

  it("shuts down in §15.3 order: stops commands, app shutdown, closes server", async () => {
    await host.shutdown();
    expect(app.shutdown).toHaveBeenCalledTimes(1);
    // The HTTP server is closed; new requests fail.
    const result = await request(port, "GET", "/");
    expect(result.status).toBe(0);
  });
});
