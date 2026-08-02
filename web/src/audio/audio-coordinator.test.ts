import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioCoordinator, type AudioCoordinatorEvents } from "./audio-coordinator.js";
import type { PublicWebConfig } from "@shared/wire/public-web-config.js";

const playbackConfig: PublicWebConfig["audio"]["playback"] = {
  startup_buffer_ms: 350,
  critical_watermark_ms: 500,
  low_watermark_ms: 2500,
  target_buffer_ms: 6500,
};
const format: PublicWebConfig["audio"]["format"] = {
  encoding: "pcm_s16le",
  sampleRate: 22050,
  channels: 1,
  bitDepth: 16,
};

function makeEvents(): AudioCoordinatorEvents {
  return {
    onLinePlaybackStarted: vi.fn(),
    onLinePlaybackFinished: vi.fn(),
    onUnderrun: vi.fn(),
  };
}

interface FakeContext {
  context: AudioContext;
  port: { postMessage: ReturnType<typeof vi.fn>; onmessage: ((e: MessageEvent) => void) | null };
  node: { port: unknown; connect: ReturnType<typeof vi.fn> };
  gain: { gain: { value: number }; connect: ReturnType<typeof vi.fn> };
}

function makeFakeContext(): FakeContext {
  const port = { postMessage: vi.fn(), onmessage: null as ((e: MessageEvent) => void) | null };
  const node = { port, connect: vi.fn() };
  const gain = { gain: { value: 1 }, connect: vi.fn() };
  const context = {
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createAudioWorkletNode: vi.fn().mockReturnValue(node),
    createGain: vi.fn().mockReturnValue(gain),
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    sampleRate: 22050,
    currentTime: 0,
  } as unknown as AudioContext;
  return { context, port, node, gain };
}

const viewPosts = (port: { postMessage: ReturnType<typeof vi.fn> }): unknown[] =>
  port.postMessage.mock.calls.map((call) => call[0]).filter(ArrayBuffer.isView);

afterEach(() => {
  vi.useRealTimers();
});

describe("AudioCoordinator", () => {
  it("init loads the worklet module and wires a single node + gain", async () => {
    const { context, node, gain } = makeFakeContext();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, makeEvents());
    await coordinator.init();
    expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(context.createAudioWorkletNode).toHaveBeenCalledWith("pcm-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    expect(node.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(context.destination);
  });

  it("init resolves without throwing when the context lacks createAudioWorkletNode", async () => {
    const fake = makeFakeContext();
    const context = fake.context as unknown as {
      createAudioWorkletNode?: unknown;
    };
    delete context.createAudioWorkletNode;
    const coordinator = new AudioCoordinator(
      { context: fake.context, playbackConfig, format },
      makeEvents(),
    );
    await expect(coordinator.init()).resolves.toBeUndefined();
    expect(coordinator.bufferedAheadMs()).toBe(0);
  });

  it("startup buffer: feeds below threshold do not start playback", async () => {
    const { context, port } = makeFakeContext();
    const events = makeEvents();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, events);
    await coordinator.init();
    coordinator.enqueueLine("line-1", "cache-1", 0, 0);
    coordinator.start("line-1");
    expect(port.postMessage).toHaveBeenCalledWith({ type: "clear" });
    coordinator.feedPcm("line-1", new Int16Array(7000)); // 317ms < 350ms
    expect(coordinator.isPlaying()).toBe(false);
    expect(events.onLinePlaybackStarted).not.toHaveBeenCalled();
    expect(viewPosts(port)).toHaveLength(0);
    coordinator.feedPcm("line-1", new Int16Array(1000)); // 8000 → 363ms ≥ 350ms
    expect(coordinator.isPlaying()).toBe(true);
    expect(events.onLinePlaybackStarted).toHaveBeenCalledWith("line-1");
    const posts = viewPosts(port);
    expect(posts).toHaveLength(2);
    expect((posts[0] as Int16Array).length).toBe(7000);
    expect((posts[1] as Int16Array).length).toBe(1000);
  });

  it("auto mode emits finished after pause_after_ms (fake timers)", async () => {
    vi.useFakeTimers();
    const { context } = makeFakeContext();
    const events = makeEvents();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, events);
    await coordinator.init();
    coordinator.setMode("auto");
    coordinator.enqueueLine("line-1", "cache-1", 0, 150);
    coordinator.start("line-1");
    coordinator.feedPcm("line-1", new Int16Array(22050)); // exactly 1s of audio
    expect(events.onLinePlaybackStarted).toHaveBeenCalledWith("line-1");
    vi.advanceTimersByTime(1000 + 150);
    expect(events.onLinePlaybackFinished).toHaveBeenCalledWith("line-1");
    expect(coordinator.isPlaying()).toBe(false);
  });

  it("manual mode finishes without waiting pause_after_ms", async () => {
    vi.useFakeTimers();
    const { context } = makeFakeContext();
    const events = makeEvents();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, events);
    await coordinator.init();
    coordinator.enqueueLine("line-1", "cache-1", 0, 5000);
    coordinator.start("line-1");
    coordinator.feedPcm("line-1", new Int16Array(22050));
    vi.advanceTimersByTime(1000);
    expect(events.onLinePlaybackFinished).toHaveBeenCalledWith("line-1");
  });

  it("skip clears unplayed samples and drops dropped lines' pending chunks", async () => {
    const { context, port } = makeFakeContext();
    const events = makeEvents();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, events);
    await coordinator.init();
    coordinator.enqueueLine("line-1", "cache-1", 0, 0);
    coordinator.start("line-1");
    coordinator.feedPcm("line-1", new Int16Array(8000)); // starts line-1
    coordinator.enqueueLine("line-2", "cache-2", 0, 0);
    coordinator.feedPcm("line-2", new Int16Array(5000)); // future line — not played yet
    coordinator.skip("line-2");
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "clear" });
    expect(events.onLinePlaybackStarted).not.toHaveBeenCalledWith("line-2");
    expect(coordinator.bufferedAheadMs()).toBeCloseTo((5000 / 22050) * 1000, 1);
    coordinator.feedPcm("line-2", new Int16Array(3000)); // 8000 ≥ 7718 → starts
    expect(events.onLinePlaybackStarted).toHaveBeenCalledWith("line-2");
    const calls = port.postMessage.mock.calls;
    const isClear = (call: unknown[]) =>
      call[0] !== null && typeof call[0] === "object" && (call[0] as { type?: string }).type === "clear";
    let clearIndex = -1;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (isClear(calls[i]!)) {
        clearIndex = i;
        break;
      }
    }
    const viewsAfterClear = calls
      .slice(clearIndex + 1)
      .map((call) => call[0])
      .filter(ArrayBuffer.isView);
    expect(viewsAfterClear).toHaveLength(2); // only line-2's two chunks, never line-1's
    expect((viewsAfterClear[0] as Int16Array).length).toBe(5000);
    expect((viewsAfterClear[1] as Int16Array).length).toBe(3000);
  });

  it("bufferedAheadMs reflects fed samples", async () => {
    const { context } = makeFakeContext();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, makeEvents());
    coordinator.enqueueLine("line-1", "cache-1", 0, 200);
    coordinator.feedPcm("line-1", new Int16Array(22050)); // 1s
    expect(coordinator.bufferedAheadMs()).toBeCloseTo(1000, 1);
  });

  it("forwards worklet underrun messages to events", async () => {
    const { context, port } = makeFakeContext();
    const events = makeEvents();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, events);
    await coordinator.init();
    (port.onmessage as (e: MessageEvent) => void)({ data: { type: "underrun" } } as MessageEvent);
    expect(events.onUnderrun).toHaveBeenCalledTimes(1);
  });

  it("volume and mute control the gain node, clamped to 0..1", async () => {
    const { context, gain } = makeFakeContext();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, makeEvents());
    await coordinator.init();
    coordinator.setVolume(0.5);
    expect(gain.gain.value).toBe(0.5);
    coordinator.setVolume(1.5);
    expect(gain.gain.value).toBe(1);
    coordinator.setMuted(true);
    expect(gain.gain.value).toBe(0);
    coordinator.setMuted(false);
    expect(gain.gain.value).toBe(1);
  });

  it("volume set before init applies once the gain node exists", async () => {
    const { context, gain } = makeFakeContext();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, makeEvents());
    coordinator.setVolume(0.25);
    coordinator.setMuted(true);
    await coordinator.init();
    expect(gain.gain.value).toBe(0); // muted wins until unmuted
    coordinator.setMuted(false);
    expect(gain.gain.value).toBe(0.25);
  });

  it("stop halts playback without emitting finished", async () => {
    const { context } = makeFakeContext();
    const events = makeEvents();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, events);
    await coordinator.init();
    coordinator.enqueueLine("line-1", "cache-1", 0, 0);
    coordinator.start("line-1");
    coordinator.feedPcm("line-1", new Int16Array(8000));
    expect(coordinator.isPlaying()).toBe(true);
    coordinator.stop();
    expect(coordinator.isPlaying()).toBe(false);
    expect(events.onLinePlaybackFinished).not.toHaveBeenCalled();
  });

  it("start/skip on an unknown line is a no-op", async () => {
    const { context } = makeFakeContext();
    const events = makeEvents();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, events);
    await coordinator.init();
    coordinator.enqueueLine("line-1", "cache-1", 0, 0);
    coordinator.start("line-1");
    coordinator.start("unknown");
    coordinator.skip("unknown");
    expect(events.onLinePlaybackStarted).not.toHaveBeenCalled();
    expect(coordinator.isPlaying()).toBe(false);
    // currentLineId is unchanged (still line-1), so feeding line-1 drives startup playback
    coordinator.feedPcm("line-1", new Int16Array(8000)); // 363ms ≥ 350ms threshold
    expect(events.onLinePlaybackStarted).toHaveBeenCalledWith("line-1");
    expect(coordinator.isPlaying()).toBe(true);
  });

  it("start/skip on the currently playing line is a no-op (no duplicate events)", async () => {
    vi.useFakeTimers();
    const { context } = makeFakeContext();
    const events = makeEvents();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, events);
    await coordinator.init();
    coordinator.enqueueLine("line-1", "cache-1", 0, 0);
    coordinator.start("line-1");
    coordinator.feedPcm("line-1", new Int16Array(22050)); // exactly 1s — starts playback
    expect(events.onLinePlaybackStarted).toHaveBeenCalledTimes(1);
    coordinator.start("line-1");
    coordinator.skip("line-1");
    expect(events.onLinePlaybackStarted).toHaveBeenCalledTimes(1);
    expect(coordinator.isPlaying()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(events.onLinePlaybackFinished).toHaveBeenCalledTimes(1);
    expect(coordinator.isPlaying()).toBe(false);
  });

  it("flushes samples fed before init resolves once the worklet node exists", async () => {
    const { context, port } = makeFakeContext();
    const events = makeEvents();
    let resolveModule!: () => void;
    context.audioWorklet.addModule = vi
      .fn()
      .mockReturnValue(
        new Promise<void>((resolve) => {
          resolveModule = resolve;
        })
      );
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, events);
    coordinator.enqueueLine("line-1", "cache-1", 0, 0);
    coordinator.start("line-1");
    coordinator.feedPcm("line-1", new Int16Array(8000)); // crosses the startup threshold
    expect(events.onLinePlaybackStarted).toHaveBeenCalledWith("line-1");
    expect(viewPosts(port)).toHaveLength(0); // no worklet yet — nothing can be flushed
    const initPromise = coordinator.init();
    resolveModule();
    await initPromise;
    const posts = viewPosts(port);
    expect(posts).toHaveLength(1);
    expect((posts[0] as Int16Array).length).toBe(8000);
  });
  it("dropLine removes the segment, queued samples and pending PCM (invalidation)", async () => {
    const { context } = makeFakeContext();
    const events = makeEvents();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, events);
    await coordinator.init();
    coordinator.enqueueLine("line-1", "cache-1", 0, 0);
    coordinator.start("line-1");
    coordinator.feedPcm("line-1", new Int16Array(8000)); // starts line-1
    coordinator.enqueueLine("line-2", "cache-2", 0, 0);
    coordinator.feedPcm("line-2", new Int16Array(5000)); // future line — queued
    const before = coordinator.bufferedAheadMs();
    expect(before).toBeGreaterThan((8000 / 22050) * 1000);

    coordinator.dropLine("line-2");
    // Only line-1's samples remain — line-2's segment and count are gone.
    expect(coordinator.bufferedAheadMs()).toBeCloseTo((8000 / 22050) * 1000, 1);
    // Feeding the dropped line afterwards is a no-op (no segment to count).
    coordinator.feedPcm("line-2", new Int16Array(1000));
    expect(coordinator.bufferedAheadMs()).toBeCloseTo((8000 / 22050) * 1000, 1);
  });

  it("dropLine of the current line halts playback silently and frees the buffer", async () => {
    vi.useFakeTimers();
    const { context } = makeFakeContext();
    const events = makeEvents();
    const coordinator = new AudioCoordinator({ context, playbackConfig, format }, events);
    await coordinator.init();
    coordinator.enqueueLine("line-1", "cache-1", 0, 0);
    coordinator.start("line-1");
    coordinator.feedPcm("line-1", new Int16Array(22050)); // 1s — playback starts
    expect(events.onLinePlaybackStarted).toHaveBeenCalledWith("line-1");

    coordinator.dropLine("line-1");
    expect(coordinator.isPlaying()).toBe(false);
    expect(coordinator.bufferedAheadMs()).toBe(0);
    // The finish timer was cancelled — dead audio emits no finished event.
    vi.advanceTimersByTime(5000);
    expect(events.onLinePlaybackFinished).not.toHaveBeenCalled();
  });
});
