/**
 * AudioStreamRoute — POST /api/audio/synthesize (§8.2).
 *
 * Validates method, content type, session token, and the AudioFetchRequest
 * body; delegates synthesis to the TtsTaskService; streams PCM chunks with
 * the §8.2 response headers; aborts the upstream task when the client
 * disconnects. PCM never travels over the Runtime WebSocket (§22 invariant
 * 12).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TtsTaskService } from "../../application/audio/tts-task-service.js";
import { TtsTaskError } from "../../application/audio/tts-task-service.js";
import type { AudioCatalogService } from "../../application/audio/audio-catalog-service.js";
import { ttsLog } from "../../application/audio/tts-log.js";
import { AudioFetchRequestSchema } from "../../shared/wire/schemas.js";
import type { AudioFetchRequest } from "../../shared/wire/client-message.js";
import type { TtsStreamSession } from "../../core/ports/tts-provider-port.js";

export interface AudioStreamRouteDeps {
  ttsTasks: TtsTaskService;
  catalog: AudioCatalogService;
  token: string;
  maxBodyBytes?: number; // default 4096
}

const DEFAULT_MAX_BODY_BYTES = 4096;

/** Map a synthesis failure to an HTTP status; never leaks recipe/voice details. */
function ttsErrorStatus(error: unknown): number {
  if (error instanceof TtsTaskError) {
    switch (String(error.code)) {
      case "invalid_line":
      case "invalid_cache_key":
        return 404;
      case "concurrency_limit":
        return 409;
      case "audio_disabled":
        return 503;
      case "bad_request":
        return 400;
      case "canceled":
        return 499; // client closed the request
      default:
        return 400;
    }
  }
  // Provider failures and anything unexpected.
  return 502;
}

function errorMessageForStatus(status: number): string {
  switch (status) {
    case 404:
      return "unknown line or stale cache key";
    case 409:
      return "synthesis concurrency limit reached";
    case 503:
      return "audio synthesis is disabled";
    case 499:
      return "synthesis canceled";
    case 400:
      return "bad request";
    default:
      return "audio synthesis failed";
  }
}

type BodyResult =
  | { ok: true; body: string }
  | { ok: false; status: number; message: string };

export class AudioStreamRoute {
  private readonly ttsTasks: TtsTaskService;
  private readonly catalog: AudioCatalogService;
  private readonly token: string;
  private readonly maxBodyBytes: number;
  /** cacheKeys currently being streamed; one consumer per session (§22 invariant 11). */
  private readonly activeCacheKeys = new Set<string>();

  constructor(deps: AudioStreamRouteDeps) {
    this.ttsTasks = deps.ttsTasks;
    this.catalog = deps.catalog;
    this.token = deps.token;
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
    const request = this.parseRequest(body.body);
    if (request === null) {
      this.sendError(res, 400, "invalid audio fetch request");
      return;
    }

    // Fast-fail forged/stale requests before they enter the task queue.
    if (!this.catalog.validateFetchRequest(request)) {
      this.sendError(res, 404, "unknown line or stale cache key");
      return;
    }
    ttsLog("http-recv", request.lineId, `task=${request.taskId.slice(0, 8)} cache=${request.cacheKey.slice(0, 8)}`);
    // The task service joins concurrent synthesize() calls by cacheKey onto
    // the SAME single-iteration session, so the route allows only one
    // consumer per cacheKey; a second concurrent fetch is rejected (§22
    // invariant 11).
    if (this.activeCacheKeys.has(request.cacheKey)) {
      this.sendError(res, 409, "synthesis already in flight for this cache key");
      return;
    }
    this.activeCacheKeys.add(request.cacheKey);

    const controller = new AbortController();
    // Abort the upstream task ONLY on premature connection termination.
    // A normal end (res.end()) also fires 'close', so guard with a flag —
    // otherwise every completed stream would be reported "canceled" and
    // partial instead of "finished" (§8.2 task_status contract).
    const completion = { ended: false };
    const onClose = () => {
      if (!completion.ended) controller.abort();
    };
    res.once("close", onClose);

    try {
      const session = await this.ttsTasks.synthesize(request, controller.signal);
      await this.streamSession(res, session, request.taskId, completion);
    } catch (error) {
      if (!res.headersSent) {
        this.sendError(res, ttsErrorStatus(error), errorMessageForStatus(ttsErrorStatus(error)));
      } else if (!res.destroyed && !res.writableEnded) {
        // Mid-stream failure: the status is already committed; abort the body.
        res.destroy();
      }
    } finally {
      res.removeListener("close", onClose);
      this.activeCacheKeys.delete(request.cacheKey);
    }
  }

  private parseRequest(raw: string): AudioFetchRequest | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const result = AudioFetchRequestSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  private readBody(req: IncomingMessage): Promise<BodyResult> {
    const { promise, resolve } = Promise.withResolvers<BodyResult>();
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };
    const finish = (result: BodyResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > this.maxBodyBytes) {
        // Stop buffering; the response still flushes and Node closes the
        // connection because the request was never fully consumed.
        finish({ ok: false, status: 413, message: "request body too large" });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      finish({ ok: true, body: Buffer.concat(chunks).toString("utf8") });
    };
    const onError = () => {
      finish({ ok: false, status: 400, message: "could not read request body" });
    };

    req.on("data", onData);
    req.on("end", onEnd);
    return promise;
  }

  private async streamSession(
    res: ServerResponse,
    session: TtsStreamSession,
    taskId: string,
    completion: { ended: boolean },
  ): Promise<void> {
    const { metadata } = session;
    const startedAt = Date.now();
    let streamedBytes = 0;
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "X-Audio-Encoding": metadata.encoding,
      "X-Audio-Sample-Rate": String(metadata.sampleRate),
      "X-Audio-Channels": String(metadata.channels),
      "X-Audio-Bit-Depth": String(metadata.bitDepth),
      "X-Audio-Task-Id": taskId,
      "Cache-Control": "no-store",
    });
    ttsLog("http-stream", taskId.slice(0, 8), "start");


    for await (const chunk of session.chunks) {
      if (res.destroyed || res.writableEnded) break;
      streamedBytes += chunk.byteLength;
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => {
          const onDrain = () => resolve();
          const onAbort = () => {
            res.removeListener("drain", onDrain);
            resolve();
          };
          res.once("drain", onDrain);
          res.once("close", onAbort);
        });
      }
      if (res.destroyed || res.writableEnded) break;
    }

    if (!res.destroyed && !res.writableEnded) {
      // Normal end: mark ended BEFORE res.end() so the 'close' listener
      // does not abort the (already completed) upstream task.
      completion.ended = true;
      res.end();
    }
    ttsLog(
      "http-stream",
      taskId.slice(0, 8),
      `end bytes=${streamedBytes} elapsed=${Date.now() - startedAt}ms`,
    );
  }

  private sendError(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: status, message } }));
  }
}
