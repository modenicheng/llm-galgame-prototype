/**
 * Tests for the Node-host session ID generator.
 */
import { describe, it, expect } from "vitest";
import { SessionIdGenerator } from "./session-id-generator.js";

describe("SessionIdGenerator", () => {
  it("should produce a session ID with only safe filename characters", () => {
    const ids = new SessionIdGenerator();
    const sid = ids.nextSessionId();
    expect(sid).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  it("should not contain colons or dots", () => {
    const ids = new SessionIdGenerator();
    const sid = ids.nextSessionId();
    expect(sid).not.toContain(":");
    expect(sid).not.toContain(".");
  });

  it("should produce distinct session IDs across calls", async () => {
    const ids = new SessionIdGenerator();
    const first = ids.nextSessionId();
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(ids.nextSessionId()).not.toBe(first);
  });

  it("should produce padded monotonic line IDs within a session", () => {
    const ids = new SessionIdGenerator();
    const sid = ids.nextSessionId();
    expect(ids.nextLineId(sid)).toBe(`line_${sid}_000001`);
    expect(ids.nextLineId(sid)).toBe(`line_${sid}_000002`);
  });

  it("should embed the session id and stay monotonic", () => {
    const ids = new SessionIdGenerator();
    const sid = ids.nextSessionId();
    const a = ids.nextLineId(sid);
    const b = ids.nextLineId(sid);
    expect(a).toContain(sid);
    expect(b).toContain(sid);
    expect(a).not.toBe(b);
  });

  it("should produce unique generation and preview ids", () => {
    const ids = new SessionIdGenerator();
    expect(ids.nextGenerationId("opening")).not.toBe(ids.nextGenerationId("opening"));
    expect(ids.nextPreviewId("int_1")).not.toBe(ids.nextPreviewId("int_1"));
  });
});
