/**
 * Tests for DashScopeCosyVoiceProvider — no network; fetch and decode are injected.
 */
import { describe, expect, it } from "vitest";
import type { TtsSynthesisRequest } from "../../core/ports/tts-provider-port.js";
import {
  DashScopeCosyVoiceProvider,
  DASHSCOPE_DEFAULT_BASE_URL,
  DASHSCOPE_QWEN3_TTS_DEFAULT_BASE_URL,
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

/** Canonical 44-byte PCM WAV header + payload (sizes are real; the live
 * qwen3 stream uses placeholder sizes, which the stripper never reads). */
function wavBytes(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function audioEvent(bytes: Buffer): string {
  return `data: {"output":{"audio":{"data":"${bytes.toString("base64")}"},"finish_reason":"null"}}\n\n`;
}

const STOP_EVENT = 'data: {"output":{"audio":{"data":"","url":"http://oss.example/x.wav"},"finish_reason":"stop"}}\n\n';

describe("DashScopeCosyVoiceProvider — qwen3-tts family", () => {
  it("posts the multimodal-generation body (text/voice only) and strips the WAV header", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const fetchImpl = (async (url: string, init: RequestInit): Promise<Response> => {
      seen.push({ url, init });
      return sseResponse([audioEvent(wavBytes(pcm)), STOP_EVENT]);
    }) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "k", fetchImpl });
    const req = makeRequest({
      model: "qwen3-tts-flash",
      voiceId: "Cherry",
      rate: 1.2,
      pitch: 0.9,
      volume: 70,
      seed: 99,
      sampleRate: 22050,
    });
    const session = await provider.start(req, new AbortController().signal);
    const chunks: Uint8Array[] = [];
    for await (const chunk of session.chunks) chunks.push(chunk);

    expect(seen[0]!.url).toBe(DASHSCOPE_QWEN3_TTS_DEFAULT_BASE_URL);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["X-DashScope-SSE"]).toBe("enable");
    expect(headers["X-DashScope-Data-Inspector"]).toBeUndefined();
    const body = JSON.parse(String(seen[0]!.init.body)) as {
      model: string;
      input: Record<string, unknown>;
    };
    expect(body.model).toBe("qwen3-tts-flash");
    // Only text + voice; the CosyVoice-only params are dropped.
    expect(body.input).toEqual({ text: "你好，世界", voice: "Cherry" });
    // The 44-byte WAV header is stripped; downstream sees raw PCM only.
    expect(Buffer.concat(chunks).equals(pcm)).toBe(true);
    // Metadata and duration math use the family's fixed 24 kHz.
    expect(session.metadata.sampleRate).toBe(24000);
    await expect(session.completion).resolves.toMatchObject({
      totalBytes: pcm.length,
      durationMs: Math.round((pcm.length / 2 / 24000) * 1000),
    });
  });

  it("maps instruction → instructions on instruct models only", async () => {
    const bodies: string[] = [];
    const pcm = Buffer.from([9, 9, 9, 9]);
    const fetchImpl = (async (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(String(init.body));
      return sseResponse([audioEvent(wavBytes(pcm)), STOP_EVENT]);
    }) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "k", fetchImpl });
    await drain(
      provider.start(
        makeRequest({
          model: "qwen3-tts-instruct-flash-2026-01-26",
          voiceId: "Cherry",
          instruction: "语气：温柔。",
        }),
        new AbortController().signal,
      ),
    );
    await drain(
      provider.start(
        makeRequest({
          model: "qwen3-tts-vc-2026-01-22",
          voiceId: "qwen3-tts-vc-suyao-abc",
          instruction: "语气：温柔。",
        }),
        new AbortController().signal,
      ),
    );

    const instruct = JSON.parse(bodies[0]!) as { input: Record<string, unknown> };
    expect(instruct.input.instructions).toBe("语气：温柔。");
    const nonInstruct = JSON.parse(bodies[1]!) as { input: Record<string, unknown> };
    expect(nonInstruct.input).not.toHaveProperty("instructions");
  });

  it("reassembles PCM when the WAV header spans two SSE chunks", async () => {
    const pcm = Buffer.alloc(64, 0xab);
    const wav = wavBytes(pcm);
    const fetchImpl = (async () =>
      sseResponse([
        audioEvent(wav.subarray(0, 20)), // partial header
        audioEvent(wav.subarray(20)), // rest of header + all PCM
        STOP_EVENT,
      ])) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "k", fetchImpl });
    const session = await provider.start(
      makeRequest({ model: "qwen3-tts-flash", voiceId: "Cherry" }),
      new AbortController().signal,
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of session.chunks) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(pcm)).toBe(true);
    await expect(session.completion).resolves.toMatchObject({ totalBytes: 64 });
  });

  it("passes a headerless qwen3 stream through as raw PCM (instruct models emit no WAV header)", async () => {
    const pcm = Buffer.from([0xfe, 0xff, 0xfd, 0xff, 0xfc, 0xff, 0xfb, 0xff]);
    const fetchImpl = (async () =>
      sseResponse([audioEvent(pcm), STOP_EVENT])) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "k", fetchImpl });
    const session = await provider.start(
      makeRequest({ model: "qwen3-tts-instruct-flash-2026-01-26", voiceId: "Cherry" }),
      new AbortController().signal,
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of session.chunks) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(pcm)).toBe(true);
    await expect(session.completion).resolves.toMatchObject({ totalBytes: pcm.length });
    expect(session.metadata.sampleRate).toBe(24000);
  });

  it("fails typed on a non-PCM WAV fmt chunk", async () => {
    // fmt audio_format = 0x0011 (ADPCM) — forwarding compressed payload as
    // raw PCM would be noise, so this stays a typed failure.
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(0x11, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(24000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(4, 40);
    const wav = Buffer.concat([header, Buffer.from([1, 2, 3, 4])]);
    const fetchImpl = (async () =>
      sseResponse([audioEvent(wav), STOP_EVENT])) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "k", fetchImpl });
    const session = await provider.start(
      makeRequest({ model: "qwen3-tts-flash", voiceId: "Cherry" }),
      new AbortController().signal,
    );
    const iterator = session.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(TtsProviderError);
    await expect(iterator.next()).rejects.toMatchObject({ code: "sse_parse" });
    await expect(session.completion).rejects.toMatchObject({ code: "sse_parse" });
  });

  it("fails typed when the qwen3 WAV layout deviates from 24 kHz mono", async () => {
    // A container layout change (e.g. 48 kHz stereo) would otherwise play
    // as pitch-shifted noise with no error anywhere.
    const pcm = Buffer.from([1, 2, 3, 4]);
    const fetchImpl = (async () =>
      sseResponse([audioEvent(wavBytes(pcm, 48000)), STOP_EVENT])) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({ apiKey: "k", fetchImpl });
    const session = await provider.start(
      makeRequest({ model: "qwen3-tts-flash", voiceId: "Cherry" }),
      new AbortController().signal,
    );
    const iterator = session.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "sse_parse" });
    await expect(session.completion).rejects.toMatchObject({ code: "sse_parse" });
  });

  it("respects the qwen3BaseUrl override", async () => {
    const pcm = Buffer.from([1, 1]);
    let url = "";
    const fetchImpl = (async (u: string): Promise<Response> => {
      url = u;
      return sseResponse([audioEvent(wavBytes(pcm)), STOP_EVENT]);
    }) as unknown as typeof fetch;

    const provider = new DashScopeCosyVoiceProvider({
      apiKey: "k",
      fetchImpl,
      qwen3BaseUrl: "https://proxy.example.com/generation",
    });
    await drain(
      provider.start(
        makeRequest({ model: "qwen3-tts-flash", voiceId: "Cherry" }),
        new AbortController().signal,
      ),
    );
    expect(url).toBe("https://proxy.example.com/generation");
  });
});

async function drain(sessionPromise: Promise<{ chunks: AsyncIterable<Uint8Array> }>): Promise<void> {
  for await (const _ of (await sessionPromise).chunks) {
    // drain
  }
}
