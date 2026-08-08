import { describe, it, expect } from "vitest";
import { StreamLineDecoder } from "./stream-decoder.js";

describe("StreamLineDecoder", () => {
  it("returns a single complete line per chunk", () => {
    const decoder = new StreamLineDecoder();
    expect(decoder.push("苏遥: 等等。\n")).toEqual(["苏遥: 等等。"]);
    expect(decoder.hasPending()).toBe(false);
  });

  it("accumulates a line split across multiple chunks", () => {
    const decoder = new StreamLineDecoder();
    expect(decoder.push("苏遥[anx")).toEqual([]);
    expect(decoder.push("ious|left]: 等等。\n")).toEqual(["苏遥[anxious|left]: 等等。"]);
    expect(decoder.hasPending()).toBe(false);
  });

  it("handles \\r\\n line endings and strips the trailing \\r", () => {
    const decoder = new StreamLineDecoder();
    expect(decoder.push("第一行\r\n第二行\r\n")).toEqual(["第一行", "第二行"]);
  });

  it("returns multiple lines from a single chunk", () => {
    const decoder = new StreamLineDecoder();
    expect(decoder.push("bg black\n苏遥: 你好。\nbeat\n")).toEqual([
      "bg black",
      "苏遥: 你好。",
      "beat",
    ]);
  });

  it("keeps a line that ends exactly at a chunk boundary pending until the newline arrives", () => {
    const decoder = new StreamLineDecoder();
    expect(decoder.push("bg black\n未完成的对白")).toEqual(["bg black"]);
    expect(decoder.hasPending()).toBe(true);
    expect(decoder.push("\n")).toEqual(["未完成的对白"]);
    expect(decoder.hasPending()).toBe(false);
  });

  it("flush returns the remaining partial line and clears it", () => {
    const decoder = new StreamLineDecoder();
    expect(decoder.push("bg black\n未完成的对白")).toEqual(["bg black"]);
    expect(decoder.hasPending()).toBe(true);
    expect(decoder.flush()).toBe("未完成的对白");
    expect(decoder.hasPending()).toBe(false);
    expect(decoder.flush()).toBeNull();
  });

  it("flush returns null when nothing is pending", () => {
    const decoder = new StreamLineDecoder();
    expect(decoder.flush()).toBeNull();
  });

  it("drops empty lines", () => {
    const decoder = new StreamLineDecoder();
    expect(decoder.push("a\n\nb\n\n\n")).toEqual(["a", "b"]);
  });

  it("drops empty \\r\\n lines", () => {
    const decoder = new StreamLineDecoder();
    expect(decoder.push("\r\n\r\n")).toEqual([]);
  });

  it("empty chunks produce no lines and leave no pending state", () => {
    const decoder = new StreamLineDecoder();
    expect(decoder.push("")).toEqual([]);
    expect(decoder.push("")).toEqual([]);
    expect(decoder.hasPending()).toBe(false);
  });
});
