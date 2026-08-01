/**
 * Unit tests for the InputBridgeBuffer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InputBridgeBuffer } from "./input-bridge.js";
import type { RuntimeNarrationEvent } from "../../schema.js";

function narration(text: string, lineId: string): RuntimeNarrationEvent {
  return { type: "narration", text, line_id: lineId };
}

describe("InputBridgeBuffer", () => {
  let buffer: InputBridgeBuffer;

  beforeEach(() => {
    buffer = new InputBridgeBuffer();
  });

  it("stores and peeks without removing", () => {
    buffer.store("int_1", [narration("One.", "line_1")]);
    expect(buffer.peek("int_1")).toHaveLength(1);
    expect(buffer.peek("int_1")).toHaveLength(1);
  });

  it("take retrieves and removes the bridge", () => {
    buffer.store("int_1", [narration("One.", "line_1")]);
    const taken = buffer.take("int_1");
    expect(taken).toHaveLength(1);
    expect(buffer.peek("int_1")).toBeNull();
    expect(buffer.take("int_1")).toBeNull();
  });

  it("discard removes the bridge", () => {
    buffer.store("int_1", [narration("One.", "line_1")]);
    buffer.discard("int_1");
    expect(buffer.peek("int_1")).toBeNull();
  });

  it("returns null for unknown interactions", () => {
    expect(buffer.peek("no_such")).toBeNull();
    expect(buffer.take("no_such")).toBeNull();
  });

  it("keeps interactions independent", () => {
    buffer.store("int_1", [narration("One.", "line_1")]);
    buffer.store("int_2", [narration("Two.", "line_2")]);
    expect(buffer.take("int_1")).toHaveLength(1);
    expect(buffer.peek("int_2")).toHaveLength(1);
  });
});
