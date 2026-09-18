import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClipPlayer, int16ToFloat32, type ClipPlayerSource } from "./clip-player.js";

interface FakeContext {
  context: AudioContext;
  createGain: ReturnType<typeof vi.fn>;
  createBuffer: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
  sources: Array<{ source: ClipPlayerSource; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>;
  gains: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn> }>;
}

function makeFakeContext(): FakeContext {
  const sources: FakeContext["sources"] = [];
  const gains: FakeContext["gains"] = [];
  const createGain = vi.fn(() => {
    const gain = { gain: { value: 1 }, connect: vi.fn() };
    gains.push(gain);
    return gain;
  });
  const createBuffer = vi.fn((_channels: number, length: number, sampleRate: number) => ({
    length,
    sampleRate,
    getChannelData: (channel: number) => new Float32Array(channel === 0 ? length : 0),
    copyToChannel: (data: Float32Array, channel: number) => {
      const target = new Float32Array(channel === 0 ? length : 0);
      target.set(data.subarray(0, target.length));
      return target;
    },
  }));
  const createBufferSource = vi.fn(() => {
    const source = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    sources.push({ source: source as unknown as ClipPlayerSource, start: source.start, stop: source.stop });
    return source;
  });
  const context = {
    createGain,
    createBuffer,
    createBufferSource,
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext;
  return { context, createGain, createBuffer, createBufferSource, sources, gains };
}

describe("int16ToFloat32", () => {
  it("maps s16 range to [-1, 1)", () => {
    const out = int16ToFloat32(Int16Array.from([0, 16384, -32768, 32767]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBe(-1);
    expect(out[3]).toBeCloseTo(0.99997, 4);
  });
});

describe("ClipPlayer", () => {
  let fake: FakeContext;
  beforeEach(() => {
    fake = makeFakeContext();
  });

  it("plays a clip: buffer built at the asset sample rate, chained through gain", () => {
    const player = new ClipPlayer(fake.context);
    player.setVolume(0.4);
    expect(fake.gains[0]!.gain.value).toBe(0.4);
    const onEnded = vi.fn();
    player.play(new Int16Array(2205), 22050, onEnded);
    expect(fake.createBuffer).toHaveBeenCalledWith(1, 2205, 22050);
    const { source, start } = fake.sources[0]!;
    expect(source.buffer).not.toBeNull();
    expect(source.buffer!.length).toBe(2205);
    expect(source.connect).toHaveBeenCalledWith(fake.gains[0]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(true);
    expect(onEnded).not.toHaveBeenCalled();

    // Natural end fires the callback exactly once, detaching itself —
    // a second completion can never happen.
    expect(source.onended).toBeTypeOf("function");
    source.onended!();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(false);
    expect(source.onended).toBeNull();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("stop() halts playback and detaches the completion callback", () => {
    const player = new ClipPlayer(fake.context);
    const onEnded = vi.fn();
    player.play(new Int16Array(100), 24000, onEnded);
    const { source, stop } = fake.sources[0]!;
    player.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(false);
    // stop() detaches onended — nothing can fire a completion afterwards.
    expect(source.onended).toBeNull();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("a new play() replaces the in-flight replay (old onended detached)", () => {
    const player = new ClipPlayer(fake.context);
    const firstEnded = vi.fn();
    const secondEnded = vi.fn();
    player.play(new Int16Array(100), 24000, firstEnded);
    player.play(new Int16Array(200), 24000, secondEnded);
    expect(fake.sources[0]!.stop).toHaveBeenCalledTimes(1);
    expect(fake.sources).toHaveLength(2);
    // The replaced source's callback was detached — it can never report.
    expect(fake.sources[0]!.source.onended).toBeNull();
    fake.sources[1]!.source.onended!(); // current
    expect(secondEnded).toHaveBeenCalledTimes(1);
    expect(firstEnded).not.toHaveBeenCalled();
  });

  it("mute zeroes the gain without stopping the source", () => {
    const player = new ClipPlayer(fake.context);
    player.setVolume(0.8);
    player.play(new Int16Array(100), 24000, () => {});
    player.setMuted(true);
    expect(fake.gains[0]!.gain.value).toBe(0);
    expect(player.playing).toBe(true);
    player.setMuted(false);
    expect(fake.gains[0]!.gain.value).toBeCloseTo(0.8, 5);
  });

  it("empty samples complete immediately instead of wedging the UI", () => {
    const player = new ClipPlayer(fake.context);
    const onEnded = vi.fn();
    player.play(new Int16Array(0), 24000, onEnded);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(fake.createBufferSource).not.toHaveBeenCalled();
    expect(player.playing).toBe(false);
  });
});
