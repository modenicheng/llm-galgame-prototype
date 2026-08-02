/**
 * AudioStreamRoute tests: §8.2 headers, chunk streaming, client-abort
 * propagation, error mapping, token/content-type/method validation, the
 * body cap, and the one-consumer-per-cacheKey rule.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AudioCatalogServiceImpl } from "../../application/audio/audio-catalog-service.js";
import { TtsTaskError } from "../../application/audio/tts-task-service.js";
import { AudioStreamRoute } from "./audio-stream-route.js";
import { FakeTtsTasks, makeSession, testDescriptor, testRecipe } from "./test-fakes.js";

const TOKEN = "test-token";
const validBody = { taskId: "task_1", lineId: "line_1", cacheKey: "cache_1" };

interface PostResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

function openPost(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
): { req: http.ClientRequest; firstData: Promise<void>; response: Promise<PostResult> } {
  const { promise: firstData, resolve: resolveFirstData } = Promise.withResolvers<void>();
  const { promise: response, resolve: resolveResponse } = Promise.withResolvers<PostResult>();
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/api/audio/synthesize",
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.once("data", () => resolveFirstData());
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolveResponse({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", () => {
        resolveResponse({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    },
  );
  req.on("error", () => {
    // The request may die after an early response (e.g. 413); the response
    // promise already settled in that case.
  });
  req.end(JSON.stringify(body));
  return { req, firstData, response };
}

function postJson(port: number, body: unknown, headers: Record<string, string> = {}): Promise<PostResult> {
  return openPost(port, body, headers).response;
}

function startServer(route: AudioStreamRoute, registry: http.Server[]): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void route.handle(req, res);
  });
  registry.push(server);
  server.listen(0, "127.0.0.1", () => {
    resolve((server.address() as AddressInfo).port);
  });
  return promise;
}

async function closeServers(registry: http.Server[]): Promise<void> {
  for (const server of registry.splice(0)) {
    server.closeAllConnections();
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  }
}

describe("AudioStreamRoute", () => {
  let catalog: AudioCatalogServiceImpl;
  let tts: FakeTtsTasks;
  let route: AudioStreamRoute;
  let port: number;
  const servers: http.Server[] = [];

  beforeEach(async () => {
    catalog = new AudioCatalogServiceImpl();
    catalog.upsertDescriptor(testDescriptor, testRecipe);
    tts = new FakeTtsTasks();
    tts.createSession = () => makeSession();
    route = new AudioStreamRoute({ ttsTasks: tts, catalog, token: TOKEN });
    port = await startServer(route, servers);
  });

  afterEach(async () => {
    await closeServers(servers);
  });

  it("streams PCM chunks with the §8.2 response headers", async () => {
    const result = await postJson(port, validBody, { "X-Session-Token": TOKEN });
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("application/octet-stream");
    expect(result.headers["x-audio-encoding"]).toBe("pcm_s16le");
    expect(result.headers["x-audio-sample-rate"]).toBe("22050");
    expect(result.headers["x-audio-channels"]).toBe("1");
    expect(result.headers["x-audio-bit-depth"]).toBe("16");
    expect(result.headers["x-audio-task-id"]).toBe("task_1");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.text).toBe("\u0001\u0002\u0003\u0004\u0005");
  });

  it("rejects requests without a session token (401)", async () => {
    expect((await postJson(port, validBody)).status).toBe(401);
  });

  it("rejects requests with a mismatched session token (401)", async () => {
    expect((await postJson(port, validBody, { "X-Session-Token": "wrong" })).status).toBe(401);
  });

  it("rejects non-JSON content types (415)", async () => {
    const result = await postJson(port, validBody, {
      "X-Session-Token": TOKEN,
      "Content-Type": "text/plain",
    });
    expect(result.status).toBe(415);
  });

  it("rejects non-POST methods (405)", async () => {
    const { promise, resolve } = Promise.withResolvers<PostResult>();
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/audio/synthesize", method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.end();
    expect((await promise).status).toBe(405);
  });

  it("rejects malformed JSON (400)", async () => {
    const { promise, resolve } = Promise.withResolvers<PostResult>();
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/audio/synthesize",
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Token": TOKEN },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.end("not json{");
    expect((await promise).status).toBe(400);
  });

  it("rejects schema-invalid bodies (400)", async () => {
    const result = await postJson(port, { taskId: "", lineId: "l", cacheKey: "c" }, { "X-Session-Token": TOKEN });
    expect(result.status).toBe(400);
  });

  it("rejects oversized bodies (413)", async () => {
    const smallRoute = new AudioStreamRoute({ ttsTasks: tts, catalog, token: TOKEN, maxBodyBytes: 64 });
    const smallPort = await startServer(smallRoute, servers);
    const bigBody = { taskId: "t", lineId: "l", cacheKey: "c".repeat(200) };
    const result = await postJson(smallPort, bigBody, { "X-Session-Token": TOKEN });
    expect(result.status).toBe(413);
  });

  it("rejects unknown lines (404)", async () => {
    const result = await postJson(port, { ...validBody, lineId: "line_unknown" }, { "X-Session-Token": TOKEN });
    expect(result.status).toBe(404);
  });

  it("rejects stale cache keys (404)", async () => {
    const result = await postJson(port, { ...validBody, cacheKey: "wrong_cache" }, { "X-Session-Token": TOKEN });
    expect(result.status).toBe(404);
    expect(tts.calls).toHaveLength(0);
  });

  it("maps TtsTaskError codes to HTTP statuses", async () => {
    tts.error = new TtsTaskError("invalid_line");
    expect((await postJson(port, validBody, { "X-Session-Token": TOKEN })).status).toBe(404);

    tts.error = new TtsTaskError("audio_disabled");
    expect((await postJson(port, validBody, { "X-Session-Token": TOKEN })).status).toBe(503);

    tts.error = new Error("provider exploded with secret details");
    expect((await postJson(port, validBody, { "X-Session-Token": TOKEN })).status).toBe(502);
  });

  it("rejects a second concurrent fetch for the same cacheKey (409)", async () => {
    tts.createSession = (signal) => ({
      metadata: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1, bitDepth: 16 },
      chunks: (async function* () {
        yield new Uint8Array([9]);
        const { promise, resolve } = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => resolve(), { once: true });
        await promise;
      })(),
      completion: Promise.resolve({ totalBytes: 1 }),
    });

    const first = openPost(port, validBody, { "X-Session-Token": TOKEN });
    await waitFor(() => tts.calls.length === 1);
    const second = await postJson(port, validBody, { "X-Session-Token": TOKEN });
    expect(second.status).toBe(409);
    first.req.destroy();
  });

  it("aborts the synthesis signal when the client disconnects mid-stream", async () => {
    tts.createSession = (signal) => ({
      metadata: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1, bitDepth: 16 },
      chunks: (async function* () {
        yield new Uint8Array([1, 2, 3]);
        const { promise, resolve } = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => resolve(), { once: true });
        await promise;
      })(),
      completion: Promise.resolve({ totalBytes: 3 }),
    });

    const request = openPost(port, validBody, { "X-Session-Token": TOKEN });
    await request.firstData;
    request.req.destroy();
    await waitFor(() => tts.calls[0]?.signal.aborted === true);
    expect(tts.calls[0]?.signal.aborted).toBe(true);
  });
});
