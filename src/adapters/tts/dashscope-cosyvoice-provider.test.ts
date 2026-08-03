/**
 * Tests for DashScopeCosyVoiceProvider — no network; fetch and decode are injected.
 */
import { describe, expect, it } from "vitest";
import type { TtsSynthesisRequest } from "../../core/ports/tts-provider-port.js";
import {
  DashScopeCosyVoiceProvider,
  DASHSCOPE_DEFAULT_BASE_URL,
  TtsProviderError,
} from "./dashscope-cosyvoice-provider.js";

function makeRequest(overrides: Partial<TtsSynthesisRequest> = {}): TtsSynthesisRequest {
  return {
    text: "你好，世界",
    model: "cosyvoice-v3-flash",
    voiceId: "longxiaochun_v3",
    rate: 1.1,
    pitch: 1.05,
    volume: 90,
    seed: 42,
    format: "pcm_s16le",
    sampleRate: 22050,
    ...overrides,
  };
}

/** Response whose body is a closed SSE byte stream carrying the given event strings. */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Response whose body stays open until the test pushes/closes it. */
function controlledStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (data: string) => void;
  close: () => void;
} {
  let push!: (data: string) => void;
  let close!: () => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (data) => controller.enqueue(new TextEncoder().encode(data));
      close = () => controller.close();
    },
  });
  return { stream, push, close };
}

describe("DashScopeCosyVoiceProvider", () => {
  it("posts the official SpeechSynthesizer body — params inside input — and decodes SSE audio", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit): Promise<Response> => {
      seen.push({ url, init });
      return sseResponse([
        'data: {"output":{"finish_reason":"null","type":"sentence-begin"}}\n\n',
        'data: {"output":{"finish_reason":"null","type":"sentence-synthesis","audio":{"data":"AAECAwQ="}}}\n\n',
        'data: {"output":{"finish_reason":"stop","type":"sentence-end"}}\n\n',
      ]);
    }) as unknown as typeof fetch;
    const provider = new DashScopeCosyVoiceProvider({ apiKey: "k", fetchImpl });
    const req = makeRequest({ instruction: "语气：温柔。", volume: 50, rate: 1.05, pitch: 1.0, seed: 7 });
    const session = await provider.start(req, new AbortController().signal);
    const chunks: Uint8Array[] = [];
    for await (const chunk of session.chunks) chunks.push(chunk);
    const body = JSON.parse(String(seen[0]!.init.body)) as {
      model: string;
      input: Record<string, unknown>;
    };
    expect(seen[0]!.url).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
    );
    expect(body.model).toBe("cosyvoice-v3-flash");
    expect(body.input).toEqual({
      text: "你好，世界",
      voice: "longxiaochun_v3",
      format: "pcm",
      sample_rate: 22050,
      rate: 1.05,
      pitch: 1.0,
      volume: 50,
      seed: 7,
      instruction: "语气：温柔。",
    });
    expect(seen[0]!.init.headers).toMatchObject({
      Authorization: "Bearer k",
      "Content-Type": "application/json",
      "X-DashScope-Data-Inspector": "enable",
      "X-DashScope-SSE": "enable",
    });
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(chunks.length).toBe(1);
    expect(Buffer.concat(chunks).equals(Buffer.from("AAECAwQ=", "base64"))).toBe(true);
  });

  it("omits instruction from input when the request has none", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(sseResponse(['data:{"output":{"audio":{"data":"AQIDBA=="},"finish_reason":"stop"}}\n\n']));
    }) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "sk-test", fetchImpl });
    const session = await provider.start(makeRequest(), new AbortController().signal);
    for await (const _ of session.chunks) {
      // drain
    }

    const body = JSON.parse(capturedBody as string) as { input: Record<string, unknown> };
    expect(body.input).not.toHaveProperty("instruction");
  });

  it("accepts the current official field name output.audio.data", async () => {
    const fetchImpl = ((_input: unknown, _init?: RequestInit) =>
      Promise.resolve(
        sseResponse(['data:{"output":{"audio":{"data":"CQoLDA=="},"finish_reason":"stop"}}\n\n']),
      )) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "sk-test", fetchImpl });
    const session = await provider.start(makeRequest(), new AbortController().signal);
    const first = await session.chunks[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    expect(Array.from(first.value as Uint8Array)).toEqual([9, 10, 11, 12]);
  });

  it("maps non-2xx responses to a typed TtsProviderError with code http_<status>", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: "InvalidApiKey", message: "bad key" }), { status: 401 })) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "sk-bad", fetchImpl });
    const promise = provider.start(makeRequest(), new AbortController().signal);
    await expect(promise).rejects.toBeInstanceOf(TtsProviderError);
    await expect(promise).rejects.toMatchObject({ code: "http_401" });
  });

  it("fails with sse_parse when the stream ends without any audio data", async () => {
    const fetchImpl = ((_input: unknown, _init?: RequestInit) =>
      Promise.resolve(sseResponse([": keepalive\n\n"]))) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "sk-test", fetchImpl });
    const session = await provider.start(makeRequest(), new AbortController().signal);
    const iterator = session.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "sse_parse" });
    await expect(session.completion).rejects.toMatchObject({ code: "sse_parse" });
  });

  it("aborts the fetch mid-stream and resolves completion with partial bytes", async () => {
    let fetchAborted = false;
    const controlled = controlledStream();
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        fetchAborted = true;
      });
      return Promise.resolve(
        new Response(controlled.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      );
    }) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "sk-test", fetchImpl });
    const external = new AbortController();
    const session = await provider.start(makeRequest(), external.signal);

    controlled.push('data:{"output":{"audio":{"audio_data":"AQIDBA=="},"finish_reason":"null"}}\n\n');
    const first = await session.chunks[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);

    external.abort();
    expect(fetchAborted).toBe(true);

    await expect(session.completion).resolves.toMatchObject({ totalBytes: 4 });
    const after = await session.chunks[Symbol.asyncIterator]().next();
    expect(after.done).toBe(true);

    controlled.close();
  });

  it("rejects with first_chunk_timeout and aborts the fetch when the first chunk is late", async () => {
    let fetchAborted = false;
    const controlled = controlledStream();
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        fetchAborted = true;
      });
      return Promise.resolve(new Response(controlled.stream, { status: 200 }));
    }) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "sk-test", fetchImpl, timeoutMs: 50 });
    const session = await provider.start(makeRequest(), new AbortController().signal);

    await expect(session.completion).rejects.toMatchObject({ code: "first_chunk_timeout" });
    expect(fetchAborted).toBe(true);

    controlled.close();
  });

  it("defaults to the official SpeechSynthesizer endpoint", () => {
    expect(DASHSCOPE_DEFAULT_BASE_URL).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
    );
  });
});
