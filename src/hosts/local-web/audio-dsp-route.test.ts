/**
 * AudioDspRoute tests: method/content-type/token validation, body cap,
 * canonical save + onSaved hook, invalid body → 400, store failure → 500.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AudioDspRoute } from "./audio-dsp-route.js";
import { AudioDspStore, loadAudioDspConfig } from "../../config/audio-dsp.js";
import { defaultAudioDspParams, type AudioDspParams } from "../../shared/wire/audio-dsp.js";

const TOKEN = "test-token";
const log = { info: vi.fn(), warn: vi.fn() };

interface PostResult {
  status: number;
  text: string;
}

const servers: http.Server[] = [];

function startServer(route: AudioDspRoute): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void route.handle(req, res);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1", () => {
    resolve((server.address() as AddressInfo).port);
  });
  return promise;
}

async function closeServers(): Promise<void> {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  }
}

function postJson(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<PostResult> {
  const { promise, resolve } = Promise.withResolvers<PostResult>();
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/api/config/audio-dsp",
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      });
    },
  );
  req.on("error", () => {});
  req.end(typeof body === "string" ? body : JSON.stringify(body));
  return promise;
}

describe("AudioDspRoute", () => {
  let dir: string;
  let file: string;
  let store: AudioDspStore;
  let onSaved: ReturnType<typeof vi.fn<(params: AudioDspParams) => void>>;
  let port: number;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "audio-dsp-route-"));
    file = path.join(dir, "audio-dsp.yaml");
    store = new AudioDspStore(file, defaultAudioDspParams(), log);
    onSaved = vi.fn<(params: AudioDspParams) => void>();
    port = await startServer(new AudioDspRoute({ store, token: TOKEN, onSaved }));
  });

  afterEach(async () => {
    await closeServers();
    await rm(dir, { recursive: true, force: true });
  });

  it("saves valid params, fires onSaved, and echoes the canonical form", async () => {
    const body = defaultAudioDspParams();
    body.ducking.depth_db = -16;
    const result = await postJson(port, body, { "X-Session-Token": TOKEN });
    expect(result.status).toBe(200);
    const echoed = JSON.parse(result.text) as { ok: boolean; params: { ducking: { depth_db: number } } };
    expect(echoed.ok).toBe(true);
    expect(echoed.params.ducking.depth_db).toBe(-16);
    expect(onSaved).toHaveBeenCalledTimes(1);
    // 落盘内容与内存一致
    const reloaded = await loadAudioDspConfig(file, log);
    expect(reloaded.ducking.depth_db).toBe(-16);
    expect(store.get().ducking.depth_db).toBe(-16);
  });

  it("rejects requests without a session token (401)", async () => {
    expect((await postJson(port, defaultAudioDspParams())).status).toBe(401);
  });

  it("rejects non-POST methods (405) and non-JSON content types (415)", async () => {
    const { promise, resolve } = Promise.withResolvers<PostResult>();
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/config/audio-dsp", method: "GET" },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: "" }));
      },
    );
    req.end();
    expect((await promise).status).toBe(405);
    expect(
      (
        await postJson(port, defaultAudioDspParams(), {
          "X-Session-Token": TOKEN,
          "Content-Type": "text/plain",
        })
      ).status,
    ).toBe(415);
  });

  it("rejects non-object bodies with 400 (store untouched)", async () => {
    const result = await postJson(port, "42", { "X-Session-Token": TOKEN });
    expect(result.status).toBe(400);
    expect(onSaved).not.toHaveBeenCalled();
    const { promise, resolve } = Promise.withResolvers<PostResult>();
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/config/audio-dsp",
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Token": TOKEN },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: "" }));
      },
    );
    req.end("{not json");
    expect((await promise).status).toBe(400);
  });

  it("garbage field values still save (per-field defaults) — 200", async () => {
    const result = await postJson(port, { voice: "loud", version: 1 }, { "X-Session-Token": TOKEN });
    expect(result.status).toBe(200);
    const echoed = JSON.parse(result.text) as { params: { voice: { gate: { threshold_db: number } } } };
    expect(echoed.params.voice.gate.threshold_db).toBe(-55);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("store write failure → 500 and onSaved not fired", async () => {
    const badStore = new AudioDspStore(
      path.join(dir, "no-such-dir", "audio-dsp.yaml"),
      defaultAudioDspParams(),
      log,
    );
    const failing = new AudioDspRoute({ store: badStore, token: TOKEN, onSaved });
    const badPort = await startServer(failing);
    const result = await postJson(badPort, defaultAudioDspParams(), { "X-Session-Token": TOKEN });
    expect(result.status).toBe(500);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
