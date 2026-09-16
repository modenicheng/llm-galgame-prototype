import { describe, expect, it, vi } from "vitest";
import { randomId } from "./random-id.js";

describe("randomId — non-secure-context fallback", () => {
  it("returns distinct uuid-shaped ids in the default environment", () => {
    const a = randomId();
    const b = randomId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("falls back to a getRandomValues v4 build when randomUUID is missing", () => {
    const original = globalThis.crypto;
    // A crypto object WITHOUT randomUUID — exactly what a plain-HTTP LAN
    // context exposes (getRandomValues remains available there).
    const shim = {
      // Uint8Array<ArrayBuffer> matches the DOM getRandomValues overload
      // (plain Uint8Array widens to ArrayBufferLike and fails variance).
      getRandomValues: ((array: Uint8Array<ArrayBuffer>) =>
        original.getRandomValues(array)) as (array: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>,
    };
    vi.stubGlobal("crypto", shim);
    try {
      const a = randomId();
      const b = randomId();
      expect(a).not.toBe(b);
      // v4 shape: version nibble 4, variant nibble 8-b.
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("degrades to time+entropy when Web Crypto is absent entirely", async () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", undefined);
    try {
      const a = randomId();
      expect(a).toMatch(/^id-/);
      expect(a).not.toBe(randomId());
    } finally {
      vi.unstubAllGlobals();
      void original;
    }
  });
});
