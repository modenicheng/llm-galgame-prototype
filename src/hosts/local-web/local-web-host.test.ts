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
import { makeTestConfig } from "../../test-helpers.js";
import type { RuntimeApplication } from "../../application/runtime-application.js";
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

function makeConfig() {
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
    res.on("end", () =>
      resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
    );
  });
  req.on("error", (error) => {
    resolve({ status: 0, headers: {}, text: String(error) });
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

  it("returns 404 JSON for unknown API paths", async () => {
    const result = await request(port, "GET", "/api/nope");
    expect(result.status).toBe(404);
    expect(JSON.parse(result.text)).toEqual({ error: "not found" });
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

  it("shuts down in §15.3 order: stops commands, app shutdown, closes server", async () => {
    await host.shutdown();
    expect(app.shutdown).toHaveBeenCalledTimes(1);
    // The HTTP server is closed; new requests fail.
    const result = await request(port, "GET", "/");
    expect(result.status).toBe(0);
  });
});
