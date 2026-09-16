/**
 * randomId — UUID generation with a non-secure-context fallback.
 *
 * `crypto.randomUUID` exists only in secure contexts (HTTPS or localhost).
 * Booth deployments that serve the page over plain HTTP on a LAN address
 * (Raspberry Pi host + a second device browsing http://192.168.x.x) are not
 * secure contexts, and every command/audio task id would throw there.
 * Uniqueness is what consumers need (command dedup, task bookkeeping);
 * RFC-4122 shape is kept where possible but not load-bearing.
 */
export function randomId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // fall through to the manual build
    }
  }
  if (typeof c?.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last resort (no Web Crypto at all): time + entropy, still collision-safe
  // for the single-page, low-rate ids this app generates.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
