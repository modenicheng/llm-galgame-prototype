import { afterEach, describe, expect, it, vi } from "vitest";
import { PcmWorkletProcessor } from "./pcm-worklet.js";

const OLD_RING_SIZE = 44100;

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent) => void) | null;
}

function makeProcessor(sourceRate = 22050, outputRate = 22050): { proc: PcmWorkletProcessor; port: FakePort } {
  vi.stubGlobal("sampleRate", outputRate);
  const proc = new PcmWorkletProcessor({ processorOptions: { sourceRate } });
  const port: FakePort = { postMessage: vi.fn(), onmessage: null };
  Object.defineProperty(proc, "port", { value: port, configurable: true, writable: true });
  return { proc, port };
}

function post(proc: PcmWorkletProcessor, data: unknown): void {
  proc.handlePortMessage({ data } as MessageEvent);
}

function processBlock(proc: PcmWorkletProcessor, frames: number): Float32Array {
  const output = new Float32Array(frames);
  proc.process([[]], [[output]]);
  return output;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PcmWorkletProcessor", () => {
  it("converts Int16Array messages to Float32 samples on output", () => {
    const { proc, port } = makeProcessor();
    post(proc, new Int16Array([32767, -32768, 1000, -1000]));
    const output = processBlock(proc, 4);
    expect(output[0]).toBeCloseTo(32767 / 32768, 5);
    expect(output[1]).toBeCloseTo(-32768 / 32768, 5);
    expect(output[2]).toBeCloseTo(1000 / 32768, 5);
    expect(output[3]).toBeCloseTo(-1000 / 32768, 5);
    expect(port.postMessage).not.toHaveBeenCalled();
  });
  it("preserves queued audio beyond the old fixed ring capacity", () => {
    const { proc, port } = makeProcessor();
    const samples = new Int16Array(OLD_RING_SIZE + 1000).fill(1000);
    post(proc, samples);
    const output = processBlock(proc, samples.length);
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(output[output.length - 1]).toBeCloseTo(1000 / 32768, 5);
  });

  it("resamples 22050 Hz PCM to a 48000 Hz output without changing duration", () => {
    const { proc, port } = makeProcessor(22050, 48000);
    const source = new Int16Array(22051);
    source.fill(16384);
    post(proc, source);
    const output = processBlock(proc, 48000);
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(output[0]).toBeCloseTo(0.5, 5);
    expect(output[47999]).toBeCloseTo(0.5, 5);
  });

  it("posts a single underrun message when the ring runs dry", () => {
    const { proc, port } = makeProcessor();
    post(proc, new Int16Array([1000]));
    const output = processBlock(proc, 8);
    expect(output[0]).toBeCloseTo(1000 / 32768, 5);
    expect(output[1]).toBe(0);
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledWith({ type: "underrun" });
  });

  it("does not post underrun when the output is exactly satisfied", () => {
    const { proc, port } = makeProcessor();
    post(proc, new Int16Array(4));
    processBlock(proc, 4);
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it("clear resets the ring", () => {
    const { proc, port } = makeProcessor();
    post(proc, new Int16Array([1000]));
    post(proc, { type: "clear" });
    const output = processBlock(proc, 2);
    expect(output[0]).toBe(0);
    expect(output[1]).toBe(0);
    expect(port.postMessage).toHaveBeenCalledWith({ type: "underrun" });
  });

  it("exposes parameterDescriptors and keeps running (returns true)", () => {
    const { proc } = makeProcessor();
    expect(PcmWorkletProcessor.parameterDescriptors).toEqual([]);
    expect(proc.process([[]], [[]])).toBe(true);
  });
});
