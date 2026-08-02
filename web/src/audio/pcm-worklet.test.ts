import { describe, expect, it, vi } from "vitest";
import { PcmWorkletProcessor } from "./pcm-worklet.js";

const RING_SIZE = 44100;

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent) => void) | null;
}

function makeProcessor(): { proc: PcmWorkletProcessor; port: FakePort } {
  const proc = new PcmWorkletProcessor();
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
  it("wraps the ring buffer across the boundary", () => {
    const { proc, port } = makeProcessor();
    // Fill the ring exactly, then drain it fully so readIndex wraps to 0.
    post(proc, new Int16Array(RING_SIZE).fill(1000));
    const drained = processBlock(proc, RING_SIZE);
    expect(port.postMessage).not.toHaveBeenCalled(); // exact fill → no underrun
    expect(drained[0]).toBeCloseTo(1000 / 32768, 5);
    expect(drained[RING_SIZE - 1]).toBeCloseTo(1000 / 32768, 5);
    // Second generation of samples still plays correctly after the wrap.
    post(proc, new Int16Array([16384]));
    const output = processBlock(proc, 1);
    expect(output[0]).toBeCloseTo(0.5, 5);
  });

  it("drops overflow when the ring is full", () => {
    const { proc, port } = makeProcessor();
    post(proc, new Int16Array(RING_SIZE + 1000).fill(1000));
    const output = processBlock(proc, RING_SIZE);
    // Only the first 44100 samples fit; no underrun while draining the fill.
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(output[RING_SIZE - 1]).toBeCloseTo(1000 / 32768, 5); // ring held samples to the end
    const after = processBlock(proc, 1);
    expect(after[0]).toBe(0); // overflowed samples were dropped
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
