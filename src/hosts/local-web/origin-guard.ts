/**
 * Origin guard for the local web host (§8.3).
 *
 * Only the page's own origin may open the Runtime WebSocket or call TTS
 * endpoints: `http://127.0.0.1:<port>` and `http://localhost:<port>`.
 * A missing Origin header is rejected unless the caller opts in
 * (`allowMissing`), which is useful for non-browser clients (tests).
 */
export function isAllowedOrigin(
  originHeader: string | undefined,
  host: string,
  port: number,
  allowMissing = false,
): boolean {
  if (originHeader === undefined || originHeader === "") {
    return allowMissing;
  }

  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }

  if (origin.protocol !== "http:") return false;

  const originHost = origin.hostname.toLowerCase();
  const boundHost = host.toLowerCase();
  if (
    originHost !== boundHost &&
    originHost !== "127.0.0.1" &&
    originHost !== "localhost"
  ) {
    return false;
  }

  // Port 0 (dev, OS-assigned) accepts any origin port.
  if (port !== 0) {
    const originPort = origin.port === "" ? 80 : Number(origin.port);
    if (originPort !== port) return false;
  }

  return true;
}
