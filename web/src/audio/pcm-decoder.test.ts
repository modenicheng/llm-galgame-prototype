import { describe, expect, it } from "vitest";
import { PcmDecoder } from "./pcm-decoder.js";

describe("PcmDecoder", () => {
  it("decodes a single chunk of even length as little-endian s16", () => {
    const decoder = new PcmDecoder();
    const samples = decoder.push(new Uint8Array([0x34, 0x12, 0x00, 0x80]));
    expect(Array.from(samples)).toEqual([0x1234, -0x8000]);
  });

  it("carries an odd byte tail across two chunks (3 + 1 bytes)", () => {
    const decoder = new PcmDecoder();
    const first = decoder.push(new Uint8Array([0x34, 0x12, 0x78]));
    expect(Array.from(first)).toEqual([0x1234]); // 0x78 held back
    const second = decoder.push(new Uint8Array([0x56]));
    expect(Array.from(second)).toEqual([0x5678]);
    expect(decoder.flush().length).toBe(0); // no remainder after the pair
  });

  it("concatenates an odd tail with a multi-sample next chunk", () => {
    const decoder = new PcmDecoder();
    decoder.push(new Uint8Array([0x01, 0x02, 0x03]));
    const samples = decoder.push(new Uint8Array([0x04, 0x05, 0x06]));
    expect(Array.from(samples)).toEqual([0x0403, 0x0605]);
  });

  it("flush returns the remaining partial sample (high byte zero)", () => {
    const decoder = new PcmDecoder();
    decoder.push(new Uint8Array([0x01, 0x02, 0x03]));
    expect(Array.from(decoder.flush())).toEqual([0x03]);
    expect(decoder.flush().length).toBe(0);
  });

  it("flush on a clean decoder returns an empty array", () => {
    const decoder = new PcmDecoder();
    expect(decoder.flush().length).toBe(0);
  });

  it("reset drops any pending partial byte", () => {
    const decoder = new PcmDecoder();
    decoder.push(new Uint8Array([0x01, 0x02, 0x03]));
    decoder.reset();
    expect(decoder.flush().length).toBe(0);
  });

  it("empty pushes do not disturb a pending byte", () => {
    const decoder = new PcmDecoder();
    decoder.push(new Uint8Array([0x01, 0x02, 0x03]));
    expect(decoder.push(new Uint8Array(0)).length).toBe(0);
    expect(Array.from(decoder.flush())).toEqual([0x03]);
  });
});
