/**
 * AudioDspRoute — POST /api/config/audio-dsp（/monitor 音频面板保存入口）。
 *
 * 与 AudioStreamRoute 同一套纪律：method/content-type/会话 token 校验，
 * zod 语义校验（parseAudioDspParams：坏字段逐个回落默认，顶层非对象才拒）。
 * 保存成功后回调宿主 onSaved：刷新 publicConfig + 向玩家端广播 audio.dsp
 *（玩家窗口即时热生效），响应带规范化后的完整参数（UI 以服务端为准回填）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AudioDspStore } from "../../config/audio-dsp.js";
import { parseAudioDspParams, type AudioDspParams } from "../../shared/wire/audio-dsp.js";

export interface AudioDspRouteDeps {
  store: AudioDspStore;
  token: string;
  /** 保存成功后的宿主联动（刷新 GET /api/config 快照 + WS 广播）。 */
  onSaved: (params: AudioDspParams) => void;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 65_536;

export class AudioDspRoute {
  private readonly store: AudioDspStore;
  private readonly token: string;
  private readonly onSaved: (params: AudioDspParams) => void;
  private readonly maxBodyBytes: number;

  constructor(deps: AudioDspRouteDeps) {
    this.store = deps.store;
    this.token = deps.token;
    this.onSaved = deps.onSaved;
    this.maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      this.sendError(res, 405, "method not allowed");
      return;
    }
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      this.sendError(res, 415, "content-type must be application/json");
      return;
    }
    const token = req.headers["x-session-token"];
    if (typeof token !== "string" || token !== this.token) {
      this.sendError(res, 401, "missing or invalid session token");
      return;
    }
    const body = await this.readBody(req);
    if (!body.ok) {
      this.sendError(res, body.status, body.message);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.body);
    } catch {
      this.sendError(res, 400, "invalid JSON body");
      return;
    }
    const params = parseAudioDspParams(parsed);
    if (params === null) {
      this.sendError(res, 400, "invalid audio dsp params");
      return;
    }
    try {
      await this.store.save(params);
    } catch (error) {
      this.sendError(res, 500, error instanceof Error ? error.message : "save failed");
      return;
    }
    this.onSaved(params);
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, params }));
    }
  }

  private readBody(req: IncomingMessage): Promise<
    { ok: true; body: string } | { ok: false; status: number; message: string }
  > {
    const { promise, resolve } = Promise.withResolvers<
      { ok: true; body: string } | { ok: false; status: number; message: string }
    >();
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: { ok: true; body: string } | { ok: false; status: number; message: string }) => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > this.maxBodyBytes) {
        finish({ ok: false, status: 413, message: "request body too large" });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish({ ok: true, body: Buffer.concat(chunks).toString("utf8") });
    const onError = () => finish({ ok: false, status: 400, message: "could not read request body" });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    return promise;
  }

  private sendError(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: status, message } }));
  }
}
