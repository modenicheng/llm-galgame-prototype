/**
 * Origin guard tests (§8.3): allowed/denied origins, port matching, the
 * dev port-0 rule, missing-origin opt-in, and malformed headers.
 */
import { describe, it, expect } from "vitest";
import { isAllowedOrigin } from "./origin-guard.js";

describe("isAllowedOrigin", () => {
  it("allows http://127.0.0.1:<port> and http://localhost:<port>", () => {
    expect(isAllowedOrigin("http://127.0.0.1:5173", "127.0.0.1", 5173)).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173", "127.0.0.1", 5173)).toBe(true);
  });

  it("is case-insensitive on hostnames", () => {
    expect(isAllowedOrigin("http://LOCALHOST:5173", "127.0.0.1", 5173)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173", "LocalHost", 5173)).toBe(true);
  });

  it("rejects foreign hosts", () => {
    expect(isAllowedOrigin("http://evil.example.com:5173", "127.0.0.1", 5173)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1.evil.com:5173", "127.0.0.1", 5173)).toBe(false);
    expect(isAllowedOrigin("http://0.0.0.0:5173", "127.0.0.1", 5173)).toBe(false);
  });

  it("rejects a wrong port", () => {
    expect(isAllowedOrigin("http://127.0.0.1:9999", "127.0.0.1", 5173)).toBe(false);
    expect(isAllowedOrigin("http://localhost:9999", "127.0.0.1", 5173)).toBe(false);
  });

  it("rejects non-http schemes", () => {
    expect(isAllowedOrigin("https://127.0.0.1:5173", "127.0.0.1", 5173)).toBe(false);
    expect(isAllowedOrigin("file:///etc/passwd", "127.0.0.1", 5173)).toBe(false);
    expect(isAllowedOrigin("ws://127.0.0.1:5173", "127.0.0.1", 5173)).toBe(false);
  });

  it("port 0 accepts any origin port (dev, OS-assigned)", () => {
    expect(isAllowedOrigin("http://127.0.0.1:43210", "127.0.0.1", 0)).toBe(true);
    expect(isAllowedOrigin("http://localhost:43210", "127.0.0.1", 0)).toBe(true);
  });

  it("rejects a missing origin unless allowMissing opts in", () => {
    expect(isAllowedOrigin(undefined, "127.0.0.1", 5173)).toBe(false);
    expect(isAllowedOrigin(undefined, "127.0.0.1", 5173, true)).toBe(true);
    expect(isAllowedOrigin("", "127.0.0.1", 5173, true)).toBe(true);
  });

  it("rejects malformed origins", () => {
    expect(isAllowedOrigin("not a url", "127.0.0.1", 5173)).toBe(false);
    expect(isAllowedOrigin("null", "127.0.0.1", 5173)).toBe(false);
    expect(isAllowedOrigin("http://", "127.0.0.1", 5173)).toBe(false);
  });
});
