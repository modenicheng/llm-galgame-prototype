/**
 * GameApp integration tests — fake WebSocket, fake AudioContext, fake fetch
 * and fake-indexeddb. Covers §10.5 (Start unlock), command sending, the
 * two-stage input flow, auto-advance, the cache-hit path and the download
 * pipeline (PCM feed + cache write, dedup, abort, failure).
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameApp, DEFAULT_PUBLIC_WEB_CONFIG } from "./app.js";
import { AudioDb } from "./storage/audio-db.js";
import { AudioCacheWriter } from "./storage/audio-cache-writer.js";
import { resetDb } from "./storage/test-utils.js";
import type { AudioDescriptor } from "@shared/wire/audio-descriptor.js";
import type { PublicWebConfig } from "@shared/wire/public-web-config.js";
import type { WebSocketLike, WebSocketCtor } from "./runtime/runtime-client.js";

const WS_URL = "ws://127.0.0.1:8080/ws/runtime";
const TOKEN = "local-session-token";
const CONFIG: PublicWebConfig = DEFAULT_PUBLIC_WEB_CONFIG;

/* ------------------------------------------------------------------ fakes */

class FakeWebSocket implements WebSocketLike {
  static last: FakeWebSocket | null = null;
  url: string;
  sent: string[] = [];
  readyState = 0; // CONNECTING
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  receive(raw: unknown): void {
    this.onmessage?.({ data: raw } as MessageEvent);
  }
}

function makeFakeAudioContext(): { context: AudioContext; addModule: ReturnType<typeof vi.fn> } {
  const port = { postMessage: vi.fn(), onmessage: null as ((e: MessageEvent) => void) | null };
  const node = { port, connect: vi.fn() };
  const gain = { gain: { value: 1 }, connect: vi.fn() };
  const addModule = vi.fn().mockResolvedValue(undefined);
  const context = {
    audioWorklet: { addModule },
    createAudioWorkletNode: vi.fn(() => node),
    createGain: vi.fn(() => gain),
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    currentTime: 0,
    state: "running",
  } as unknown as AudioContext;
  return { context, addModule };
}

/** A fetch stub that routes /api/config and /api/audio/synthesize. */
function makeFetchImpl(): { fetchImpl: typeof fetch; synthesizeCalls: unknown[] } {
  const synthesizeCalls: unknown[] = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/config") {
      return Promise.resolve(new Response(JSON.stringify(CONFIG), { status: 200 }));
    }
    if (url === "/api/audio/synthesize") {
      synthesizeCalls.push(JSON.parse(String(init?.body)));
      return Promise.resolve(streamResponse([pcmChunk(22050)])); // 1s at 22050 Hz
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, synthesizeCalls };
}

function streamResponse(chunks: Uint8Array[]): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!);
        index += 1;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
}

/** A response whose body never produces data unless the signal aborts it. */
function pendingStreamResponse(signal?: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      signal?.addEventListener(
        "abort",
        () => controller.error(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    },
  });
  return new Response(stream, { status: 200 });
}

function pcmChunk(sampleCount: number): Uint8Array {
  const bytes = new Uint8Array(sampleCount * 2);
  return bytes;
}

/* ------------------------------------------------------------ message builders */

function playbackReady(sequence: number, lineId: string, text: string): string {
  return JSON.stringify({
    type: "runtime.output",
    sequence,
    output: {
      type: "playback_ready",
      event: { type: "dialogue", line_id: lineId, speaker: "苏遥", text },
    },
  });
}

function descriptorMsg(lineId: string, cacheKey: string, overrides: Partial<AudioDescriptor> = {}): string {
  return JSON.stringify({
    type: "audio.descriptor",
    descriptor: {
      lineId,
      cacheKey,
      scope: { type: "active" },
      priority: "current",
      speakerId: "su-yao",
      displaySpeaker: "苏遥",
      format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
      ...overrides,
    },
  });
}

function taskStatusMsg(taskId: string, lineId: string, status: "started" | "finished" | "failed" | "canceled"): string {
  return JSON.stringify({ type: "audio.task_status", taskId, lineId, status });
}

function choiceOpened(sequence: number, interactionId: string): string {
  return JSON.stringify({
    type: "runtime.output",
    sequence,
    output: {
      type: "interaction_opened",
      interactionId,
      interaction: {
        type: "interaction",
        interaction_id: interactionId,
        prompt: "你要怎么做？",
        mode: "choice",
        options: [
          { id: "a", text: "跟上她" },
          { id: "b", text: "留在原地" },
        ],
      },
    },
  });
}

function inputOpened(sequence: number, interactionId: string): string {
  return JSON.stringify({
    type: "runtime.output",
    sequence,
    output: {
      type: "interaction_opened",
      interactionId,
      interaction: {
        type: "interaction",
        interaction_id: interactionId,
        prompt: "说点什么",
        mode: "input",
        input: { kind: "question", placeholder: "……", max_length: 200 },
        input_bridge: { events: [] },
      },
    },
  });
}

function previewOpened(sequence: number, previewId: string, text: string): string {
  return JSON.stringify({
    type: "runtime.output",
    sequence,
    output: { type: "input_preview_opened", previewId, text },
  });
}

/* ------------------------------------------------------------------- setup */

let db: AudioDb;

beforeEach(async () => {
  db = new AudioDb();
  await resetDb(db);
  db.close();
  // RuntimeClient reports audioWorklet capability from the global.
  vi.stubGlobal("AudioContext", class {});
});

afterEach(() => {
  FakeWebSocket.last = null;
  db.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface SetupResult {
  app: GameApp;
  ws: FakeWebSocket;
  db: AudioDb;
  fetchImpl: ReturnType<typeof makeFetchImpl>["fetchImpl"];
  synthesizeCalls: unknown[];
  addModule: ReturnType<typeof vi.fn>;
}

async function setupApp(overrides: { db?: AudioDb; fetchImpl?: typeof fetch } = {}): Promise<SetupResult> {
  const { fetchImpl, synthesizeCalls } = makeFetchImpl();
  const app = new GameApp({
    wsUrl: WS_URL,
    token: TOKEN,
    fetchImpl: overrides.fetchImpl ?? fetchImpl,
    webSocketImpl: FakeWebSocket as unknown as WebSocketCtor,
    db: overrides.db ?? db,
  });
  const { context, addModule } = makeFakeAudioContext();
  await app.start(context);
  const ws = FakeWebSocket.last as FakeWebSocket;
  ws.open(); // → client.ready
  return { app, ws, db: overrides.db ?? db, fetchImpl, synthesizeCalls, addModule };
}

/** Yield to the event loop so IDB (setImmediate) and fetch chains settle. */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function sentCommands(ws: FakeWebSocket): Array<{ type: string; commandId?: string; command?: unknown }> {
  return ws.sent
    .map((raw) => JSON.parse(raw) as { type: string; commandId?: string; command?: unknown })
    .filter((msg) => msg.type === "runtime.command");
}

/* ------------------------------------------------------------------- tests */

describe("GameApp", () => {
  it("start unlocks audio (worklet registered) and opens the socket with client.ready", async () => {
    const { app, ws, addModule } = await setupApp();
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(ws.url).toContain(`token=${TOKEN}`);
    const ready = ws.sent.find((raw) => JSON.parse(raw).type === "client.ready");
    expect(ready).toBeDefined();
    expect(JSON.parse(ready!)).toMatchObject({
      capabilities: { audioWorklet: true, indexedDb: true },
    });
    expect(app.state().connection).toBe("open");
  });

  it("advance sends a runtime.command with a commandId", async () => {
    const { app, ws } = await setupApp();
    ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
    app.advance();
    const commands = sentCommands(ws);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: { type: "advance" } });
    expect(typeof commands[0]!.commandId).toBe("string");
    expect(commands[0]!.commandId!.length).toBeGreaterThan(0);
  });

  it("selectChoice sends select_choice with the interaction id", async () => {
    const { app, ws } = await setupApp();
    ws.receive(choiceOpened(2, "inter-1"));
    app.selectChoice("b");
    expect(sentCommands(ws)).toEqual([
      expect.objectContaining({
        command: { type: "select_choice", interactionId: "inter-1", optionId: "b" },
      }),
    ]);
  });

  it("submits trimmed input, then confirm_input on the preview; Esc sends cancel_input", async () => {
    const { app, ws } = await setupApp();
    ws.receive(inputOpened(3, "inter-2"));

    app.submitInput("  我想知道真相  ");
    expect(sentCommands(ws)).toEqual([
      expect.objectContaining({
        command: { type: "preview_input", interactionId: "inter-2", text: "我想知道真相" },
      }),
    ]);

    app.submitInput("   ");
    expect(sentCommands(ws)).toHaveLength(1); // empty input is ignored

    ws.receive(previewOpened(4, "prev-1", "我想知道真相"));
    app.confirmPreview();
    expect(sentCommands(ws).at(-1)).toEqual(
      expect.objectContaining({ command: { type: "confirm_input", previewId: "prev-1" } }),
    );

    app.cancelPreview();
    expect(sentCommands(ws).at(-1)).toEqual(
      expect.objectContaining({ command: { type: "cancel_input", previewId: "prev-1" } }),
    );
  });

  it("auto mode advances after the line's playback finishes", async () => {
    const { app, ws } = await setupApp();
    vi.useFakeTimers();
    app.setMode("auto");
    ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
    ws.receive(descriptorMsg("line-1", "cache-1"));
    // Flush the IDB lookup + download chain (fake immediates + microtasks).
    await vi.advanceTimersByTimeAsync(5);

    // The 1s PCM chunk fills past the 350ms startup buffer → playback starts.
    expect(app.state().audioPlaying).toBe(true);
    // The coordinator schedules the finish at ~1000ms of audio.
    await vi.advanceTimersByTimeAsync(1100);
    expect(sentCommands(ws)).toEqual([
      expect.objectContaining({ command: { type: "advance" } }),
    ]);
  });

  it("auto mode falls back to a reading-time advance when a line has no audio", async () => {
    const { app, ws } = await setupApp();
    vi.useFakeTimers();
    app.setMode("auto");
    ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
    // No descriptor arrives — no audio path exists; the reading fallback
    // (≥1500ms for the text length) advances the story.
    await vi.advanceTimersByTimeAsync(2000);
    expect(sentCommands(ws)).toEqual([
      expect.objectContaining({ command: { type: "advance" } }),
    ]);
  });

  it("cache hit skips the download and feeds PCM from IndexedDB", async () => {
    const seeded = new AudioDb();
    await seeded.open();
    const writer = new AudioCacheWriter(seeded, { writeBatchBytes: 4096, flushIntervalMs: 1000 });
    await writer.startAsset("cache-1", "line-1", {
      encoding: "pcm_s16le",
      sampleRate: 22050,
      channels: 1,
      bitDepth: 16,
      scopeAtCreation: "active",
    });
    writer.append("cache-1", pcmChunk(22050));
    await writer.finishComplete("cache-1");

    const { app, ws, synthesizeCalls, fetchImpl } = await setupApp({ db: seeded });
    ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
    ws.receive(descriptorMsg("line-1", "cache-1"));
    await flush();

    expect(fetchImpl).not.toHaveBeenCalledWith(
      "/api/audio/synthesize",
      expect.anything(),
    );
    expect(synthesizeCalls).toHaveLength(0);
    const report = ws.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === "audio.cache_report");
    expect(report).toMatchObject({ lineId: "line-1", cacheKey: "cache-1", result: "hit" });
    // The cached samples crossed the startup buffer → playback started.
    await vi.waitFor(() => {
      expect(app.state().audioPlaying).toBe(true);
    });
    seeded.close();
  });

  it("download posts {taskId,lineId,cacheKey} with the session token, feeds PCM and completes the cache", async () => {
    const { app, ws, db, fetchImpl, synthesizeCalls } = await setupApp();
    ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
    ws.receive(descriptorMsg("line-1", "cache-1"));
    await vi.waitFor(() => {
      expect(app.state().audioPlaying).toBe(true);
    });
    expect(synthesizeCalls).toEqual([
      expect.objectContaining({ lineId: "line-1", cacheKey: "cache-1" }),
    ]);
    expect(typeof (synthesizeCalls[0] as { taskId?: string }).taskId).toBe("string");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/audio/synthesize",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Session-Token": TOKEN }),
      }),
    );
    // Streaming until the authoritative task_status finished arrives.
    let asset = await db.getAsset("cache-1");
    expect(asset?.status).toBe("streaming");

    ws.receive(taskStatusMsg("t-1", "line-1", "finished"));
    await vi.waitFor(async () => {
      asset = await db.getAsset("cache-1");
      expect(asset?.status).toBe("complete");
    });
    expect(asset?.totalBytes).toBe(22050 * 2);
  });

  it("dedups concurrent downloads for the same cacheKey", async () => {
    const { app, ws, synthesizeCalls } = await setupApp();
    ws.receive(descriptorMsg("line-1", "cache-x"));
    ws.receive(descriptorMsg("line-2", "cache-x"));
    await flush();
    expect(synthesizeCalls).toHaveLength(1);
  });

  it("invalidation aborts the in-flight download and marks the cache partial", async () => {
    let capturedSignal: AbortSignal | null = null;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/config") {
        return Promise.resolve(new Response(JSON.stringify(CONFIG), { status: 200 }));
      }
      capturedSignal = init?.signal ?? null;
      return Promise.resolve(pendingStreamResponse(init?.signal ?? undefined));
    }) as unknown as typeof fetch;

    const { app, ws, db } = await setupApp({ fetchImpl });
    ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
    ws.receive(descriptorMsg("line-1", "cache-1"));
    await vi.waitFor(() => {
      expect(capturedSignal).not.toBeNull();
    });

    ws.receive(
      JSON.stringify({ type: "audio.invalidated", lineId: "line-1", reason: "branch_discarded" }),
    );
    await vi.waitFor(async () => {
      const asset = await db.getAsset("cache-1");
      expect(asset?.status).toBe("partial");
    });
    expect(app.state().view.mode).toBe("PLAYING"); // story continues
  });

  it("a failed synthesis marks the cache failed without breaking the story", async () => {
    const fetchImpl = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/config") {
        return Promise.resolve(new Response(JSON.stringify(CONFIG), { status: 200 }));
      }
      return Promise.resolve(new Response("boom", { status: 500 }));
    }) as unknown as typeof fetch;

    const { app, ws, db } = await setupApp({ fetchImpl });
    ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
    ws.receive(descriptorMsg("line-1", "cache-1"));
    await vi.waitFor(async () => {
      const asset = await db.getAsset("cache-1");
      expect(asset?.status).toBe("failed");
    });
    expect(app.state().view.mode).toBe("PLAYING");
  });


  it("restores PLAYING from a projection snapshot after reconnect", async () => {
    const { app, ws } = await setupApp();
    const snapshot = JSON.stringify({
      type: "projection.snapshot",
      projection: {
        phase: "running",
        currentLine: { type: "dialogue", line_id: "line-9", speaker: "苏遥", text: "你回来了。" },
        recentLines: [],
      },
    });
    ws.receive(snapshot);
    await flush();
    expect(app.state().view.mode).toBe("PLAYING");
    expect(app.state().view.currentLine?.text).toBe("你回来了。");
  });

  it("falls back to §10.3 defaults when GET /api/config is absent", async () => {
    const fetchImpl = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/config") {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(streamResponse([pcmChunk(22050)]));
    }) as unknown as typeof fetch;
    const { app, ws } = await setupApp({ fetchImpl });
    expect(app.state().configSource).toBe("defaults");
    expect(app.state().showLineIds).toBe(false);

    // Playback still works end to end with the hardcoded defaults.
    ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
    ws.receive(descriptorMsg("line-1", "cache-1"));
    await vi.waitFor(() => {
      expect(app.state().audioPlaying).toBe(true);
    });
  });

  it("serves a coordinator-backed state (buffered ms, mode, volume) through the public surface", async () => {
    const { app, ws } = await setupApp();
    app.setMode("auto");
    app.setVolume(0.42);
    app.setMuted(true);
    app.setTextSpeed(48);
    const state = app.state();
    expect(state.playbackMode).toBe("auto");
    expect(state.volume).toBe(0.42);
    expect(state.muted).toBe(true);
    expect(state.textSpeed).toBe(48);
    expect(state.configSource).toBe("server");
    expect(typeof state.bufferedAheadMs).toBe("number");

    ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
    ws.receive(descriptorMsg("line-1", "cache-1"));
    // 1s of audio fed → bufferedAheadMs reflects the queued samples.
    await vi.waitFor(() => {
      expect(app.state().bufferedAheadMs).toBeGreaterThan(0);
    });
  });
  it("task_status finished does not re-feed the cache (samples play exactly once)", async () => {
    const { app, ws } = await setupApp();
    ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
    ws.receive(descriptorMsg("line-1", "cache-1"));
    await vi.waitFor(() => {
      expect(app.state().audioPlaying).toBe(true);
    });
    const bufferedBefore = app.state().bufferedAheadMs; // ~1000ms of streamed PCM

    ws.receive(taskStatusMsg("t-1", "line-1", "finished"));
    await flush();

    // The finished branch is cache bookkeeping only — it must NOT feed the
    // cache a second time (the downloader already fed every chunk live).
    expect(app.state().bufferedAheadMs).toBeLessThanOrEqual(bufferedBefore + 100);
  });

  it("invalidating a non-owner deduped consumer aborts the shared fetch", async () => {
    let capturedSignal: AbortSignal | null = null;
    let aborted = false;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/config") {
        return Promise.resolve(new Response(JSON.stringify(CONFIG), { status: 200 }));
      }
      capturedSignal = init?.signal ?? null;
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return Promise.resolve(pendingStreamResponse(init?.signal ?? undefined));
    }) as unknown as typeof fetch;

    const { app, ws } = await setupApp({ fetchImpl });
    ws.receive(descriptorMsg("line-1", "cache-x"));
    ws.receive(descriptorMsg("line-2", "cache-x"));
    await vi.waitFor(() => {
      expect(capturedSignal).not.toBeNull();
    });

    // line-2 is the deduped (non-owner) consumer — aborting IT must abort
    // the shared fetch, not just strand its own controller.
    ws.receive(
      JSON.stringify({ type: "audio.invalidated", lineId: "line-2", reason: "branch_discarded" }),
    );
    await vi.waitFor(() => {
      expect(aborted).toBe(true);
    });
  });

  it("invalidation during an in-flight cache lookup prevents the download", async () => {
    let releaseLookup!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    class SlowLookupDb extends AudioDb {
      override async getAsset(cacheKey: string): Promise<Awaited<ReturnType<AudioDb["getAsset"]>>> {
        if (cacheKey === "cache-1") await gate;
        return super.getAsset(cacheKey);
      }
    }
    const slowDb = new SlowLookupDb();
    await resetDb(slowDb);
    try {
      const { app, ws, synthesizeCalls } = await setupApp({ db: slowDb });
      ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
      ws.receive(descriptorMsg("line-1", "cache-1"));
      await flush(2); // ensureAudio is inside reader.lookup, awaiting the gate

      ws.receive(
        JSON.stringify({
          type: "audio.invalidated",
          lineId: "line-1",
          reason: "branch_discarded",
        }),
      );
      releaseLookup();
      await flush();

      // The stale lookup continuation must not start a download for a
      // forgotten line.
      expect(synthesizeCalls).toHaveLength(0);
    } finally {
      slowDb.close();
    }
  });

  it("start failure resets the gate, surfaces the error and allows retry", async () => {
    const failing = makeFakeAudioContext();
    failing.addModule.mockRejectedValue(new Error("worklet module failed"));
    const app = new GameApp({
      wsUrl: WS_URL,
      token: TOKEN,
      fetchImpl: makeFetchImpl().fetchImpl,
      webSocketImpl: FakeWebSocket as unknown as WebSocketCtor,
      db,
    });

    await expect(app.start(failing.context)).rejects.toThrow("worklet module failed");
    expect(app.state().startError).toBe("worklet module failed");

    // The session is not wedged: a retry constructs everything fresh.
    const { context } = makeFakeAudioContext();
    await app.start(context);
    expect(app.state().startError).toBeNull();
    expect(FakeWebSocket.last).not.toBeNull();
  });

  it("manual advance during the auto pause window sends only one advance", async () => {
    const { app, ws } = await setupApp();
    vi.useFakeTimers();
    app.setMode("auto");
    ws.receive(
      JSON.stringify({
        type: "runtime.output",
        sequence: 1,
        output: {
          type: "playback_ready",
          event: {
            type: "dialogue",
            line_id: "line-1",
            speaker: "苏遥",
            text: "夜色正浓。",
            performance: { pause_after_ms: 500 },
          },
        },
      }),
    );
    ws.receive(descriptorMsg("line-1", "cache-1"));
    await vi.advanceTimersByTimeAsync(5); // download chain settles
    expect(app.state().audioPlaying).toBe(true);

    // 1s of audio → playback finishes at ~1000ms, opening the 500ms pause.
    await vi.advanceTimersByTimeAsync(1100);
    expect(sentCommands(ws)).toHaveLength(0); // pause window — not advanced yet

    // Manual click during the pause window: exactly one advance, and the
    // pending pause timer must be cancelled so it cannot fire a second one.
    app.advance();
    expect(sentCommands(ws)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentCommands(ws)).toHaveLength(1);
  });
  it("reconcileAudio does not start fills once bufferedAheadMs reaches target_buffer_ms", async () => {
    const synthCalls: unknown[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/config") {
        return Promise.resolve(new Response(JSON.stringify(CONFIG), { status: 200 }));
      }
      synthCalls.push(JSON.parse(String(init?.body)));
      return Promise.resolve(streamResponse([pcmChunk(22050 * 7)])); // 7s ≥ target 6500ms
    }) as unknown as typeof fetch;
    const { app, ws } = await setupApp({ fetchImpl });
    ws.receive(playbackReady(1, "line-1", "夜色正浓。"));
    ws.receive(descriptorMsg("line-1", "cache-1"));
    await vi.waitFor(() => {
      expect(app.state().bufferedAheadMs).toBeGreaterThanOrEqual(6500);
    });

    // Idle descriptors arriving while the buffer is at target must not
    // trigger a prefetch burst.
    ws.receive(descriptorMsg("line-2", "cache-2"));
    ws.receive(descriptorMsg("line-3", "cache-3"));
    await flush();
    expect(synthCalls).toHaveLength(1); // only line-1 was fetched
  });
});
