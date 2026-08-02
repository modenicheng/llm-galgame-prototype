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
  it("posts the expected body and headers, and decodes SSE audio chunks", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: unknown;
    const fetchImpl = ((input: unknown, init?: RequestInit) => {
      capturedUrl = input;
      capturedInit = init;
      return Promise.resolve(
        sseResponse([
          'data:{"output":{"audio":{"audio_data":"AQIDBA=="},"finish_reason":"null"},"request_id":"req-1"}\n\n',
          'data:{"output":{"audio":{"audio_data":"BQYHCA=="},"finish_reason":"stop"},"request_id":"req-1"}\n\n',
        ]),
      );
    }) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "sk-test", fetchImpl });
    const session = await provider.start(makeRequest({ instruction: "用温柔的语气读" }), new AbortController().signal);

    const chunks: Uint8Array[] = [];
    for await (const chunk of session.chunks) chunks.push(chunk);
    const completion = await session.completion;

    expect(capturedInit?.method).toBe("POST");
    expect(capturedUrl).toBe(DASHSCOPE_DEFAULT_BASE_URL);
    expect(capturedInit?.headers).toMatchObject({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
      "X-DashScope-Data-Inspector": "enable",
      "X-DashScope-SSE": "enable",
    });
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      model: "cosyvoice-v3-flash",
      input: { text: "你好，世界", voice: "longxiaochun_v3" },
      parameters: {
        format: "pcm",
        sample_rate: 22050,
        rate: 1.1,
        pitch: 1.05,
        volume: 90,
        seed: 42,
        instruction: "用温柔的语气读",
      },
    });

    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0] as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(Array.from(chunks[1] as Uint8Array)).toEqual([5, 6, 7, 8]);
    expect(completion.totalBytes).toBe(8);
    expect(completion.providerRequestId).toBe("req-1");
    expect(completion.durationMs).toBeTypeOf("number");
  });

  it("omits instruction from parameters when the request has none", async () => {
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

    const body = JSON.parse(capturedBody as string) as { parameters: Record<string, unknown> };
    expect(body.parameters).not.toHaveProperty("instruction");
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

  it("defaults to the multimodal-generation endpoint", () => {
    expect(DASHSCOPE_DEFAULT_BASE_URL).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
  });
});
