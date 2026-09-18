/**
 * Tests for LocalQwen3TtsProvider — no network; fetch is injected.
 */
import { describe, expect, it } from "vitest";
import type { TtsSynthesisRequest } from "../../core/ports/tts-provider-port.js";
import {
  LOCAL_TTS_DEFAULT_BASE_URL,
  LocalQwen3TtsProvider,
  TtsProviderError,
} from "./local-qwen3-tts-provider.js";

function makeRequest(overrides: Partial<TtsSynthesisRequest> = {}): TtsSynthesisRequest {
  return {
    text: "欢迎来到展位！",
    model: "local-qwen3-tts",
    voiceId: "paimeng",
    rate: 1,
    pitch: 1,
    volume: 100,
    seed: 0,
    format: "pcm_s16le",
    sampleRate: 24000,
    ...overrides,
  };
}

function pcmResponse(chunks: number[][]): Response {
  const bytes = chunks.map((c) => new Uint8Array(c));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of bytes) controller.enqueue(b);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "X-Audio-Sample-Rate": "24000" },
  });
}

describe("LocalQwen3TtsProvider", () => {
  it("defaults to the openai dialect: posts /v1/audio/speech and streams PCM", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const provider = new LocalQwen3TtsProvider({
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return pcmResponse([[1, 2, 3], [4, 5, 6]]);
      }) as typeof fetch,
    });
    const session = await provider.start(makeRequest(), new AbortController().signal);
    expect(seen[0]?.url).toBe(`${LOCAL_TTS_DEFAULT_BASE_URL}/v1/audio/speech`);
    expect(seen[0]?.body).toEqual({
      model: "local-qwen3-tts",
      input: "欢迎来到展位！",
      voice: "paimeng",
      response_format: "pcm",
    });
    // openai dialect sends no X-Audio-* headers — falls back to the request rate
    expect(session.metadata.sampleRate).toBe(24000);
    expect(session.metadata.encoding).toBe("pcm_s16le");
    let total = 0;
    for await (const chunk of session.chunks) total += chunk.byteLength;
    expect(total).toBe(6);
    const completion = await session.completion;
    expect(completion.totalBytes).toBe(6);
    expect(completion.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("dialect tts-server posts {text, voice} to /tts with header metadata", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const provider = new LocalQwen3TtsProvider({
      dialect: "tts-server",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return pcmResponse([[9, 9]]);
      }) as typeof fetch,
    });
    const session = await provider.start(makeRequest(), new AbortController().signal);
    expect(seen[0]?.url).toBe(`${LOCAL_TTS_DEFAULT_BASE_URL}/tts`);
    expect(seen[0]?.body).toEqual({ text: "欢迎来到展位！", voice: "paimeng" });
    expect(session.metadata.sampleRate).toBe(24000); // from X-Audio-Sample-Rate
    for await (const _ of session.chunks); // drain
    expect((await session.completion).totalBytes).toBe(2);
  });

  it("rejects with http_<status> when the server errors (unknown voice -> 404)", async () => {
    const provider = new LocalQwen3TtsProvider({
      fetchImpl: (async () => new Response("not found", { status: 404 })) as typeof fetch,
    });
    await expect(
      provider.start(makeRequest({ voiceId: "nope" }), new AbortController().signal),
    ).rejects.toMatchObject({ code: "http_404" });
  });

  it("resolves completion with bytes-so-far when the upstream signal aborts mid-stream", async () => {
    let push!: (b: Uint8Array) => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (b) => controller.enqueue(b);
      },
    });
    const provider = new LocalQwen3TtsProvider({
      fetchImpl: (async () => new Response(stream, {
        status: 200, headers: { "X-Audio-Sample-Rate": "24000" },
      })) as typeof fetch,
    });
    const controller = new AbortController();
    const session = await provider.start(makeRequest(), controller.signal);
    // consume like the real task service; abort mid-stream after a chunk
    let consumed = 0;
    const pump = (async () => {
      try {
        for await (const chunk of session.chunks) consumed += chunk.byteLength;
      } catch {
        // reader torn down by the abort — expected
      }
    })();
    push(new Uint8Array([1, 2, 3, 4]));
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await pump;
    const completion = await session.completion;
    expect(consumed).toBe(4);
    expect(completion.totalBytes).toBe(4);
    expect(completion.durationMs).toBeUndefined();
  });

  it("rejects with a connection error when the server is unreachable", async () => {
    const provider = new LocalQwen3TtsProvider({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(
      provider.start(makeRequest(), new AbortController().signal),
    ).rejects.toMatchObject({ name: "TtsProviderError", code: "connection" });
  });

  it("surfaces the provider error type for typed handling", async () => {
    const err = new TtsProviderError("http_500", "boom");
    expect(err.code).toBe("http_500");
    expect(err).toBeInstanceOf(Error);
  });
});
