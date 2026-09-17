/**
 * `/monitor/records/…` — read-only HTTP access to the writer LLM's on-disk
 * DSL stream records (observability; served next to the /monitor page).
 *
 * Every path shape is allowlisted, so traversal is rejected by
 * construction:
 * - `/monitor/records/index.jsonl`                       session attempt index
 * - `/monitor/records/<seq>-<attemptDir>/<file>`         direct, dir pattern-checked
 * - `/monitor/records/by-attempt/<attemptId>/<file>`     the panel builds these
 *   from the attempt id alone (sanitized exactly like the recorder names dirs)
 *
 * `<file>` is always one of the three record files. The route still
 * requires the session token (query param) — records carry the full
 * prompts and story text.
 */
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const RECORD_FILES: readonly string[] = ["prompts.jsonl", "output.raw.txt", "events.jsonl"];

const RECORD_ROUTE_PREFIX = "/monitor/records/";
const ATTEMPT_DIR_PATTERN = /^\d{4}-[A-Za-z0-9._-]+$/;

/** Mirrors LlmStreamRecorder's dir-name sanitizer (attemptId → safe segment). */
export function sanitizeAttemptIdSegment(attemptId: string): string {
  return attemptId.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Resolve one record pathname to a file inside `recordDir`; null when
 * recording is off, the shape is unknown, the name fails the allowlist or
 * the target does not exist.
 */
export async function resolveMonitorRecordFile(
  recordDir: string | null,
  pathname: string,
): Promise<string | null> {
  if (recordDir === null || !pathname.startsWith(RECORD_ROUTE_PREFIX)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(RECORD_ROUTE_PREFIX.length));
  } catch {
    return null; // Malformed % sequence — never guess.
  }
  const segments = decoded.split("/").filter((segment) => segment !== "");

  let relative: string | null = null;
  if (segments.length === 1 && segments[0] === "index.jsonl") {
    relative = "index.jsonl";
  } else if (segments.length === 2 && RECORD_FILES.includes(segments[1]!)) {
    if (ATTEMPT_DIR_PATTERN.test(segments[0]!)) relative = `${segments[0]}/${segments[1]}`;
  } else if (segments.length === 3 && segments[0] === "by-attempt" && RECORD_FILES.includes(segments[2]!)) {
    relative = await resolveByAttempt(recordDir, segments[1]!, segments[2]!);
  }
  if (relative === null) return null;

  // Containment guard on top of the allowlists (belt and suspenders).
  const base = path.resolve(recordDir);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  try {
    await access(resolved);
  } catch {
    return null;
  }
  return resolved;
}

/** Scan the record dir for the one `<seq4>-<sanitized>` dir for this attempt. */
async function resolveByAttempt(
  recordDir: string,
  attemptId: string,
  file: string,
): Promise<string | null> {
  const sanitized = sanitizeAttemptIdSegment(attemptId);
  if (sanitized === "") return null;
  const dirPattern = new RegExp(`^\\d{4}-${escapeRegExp(sanitized)}$`);
  try {
    for (const entry of await readdir(recordDir)) {
      if (!dirPattern.test(entry)) continue;
      return `${entry}/${file}`;
    }
  } catch {
    return null; // Unreadable record dir — nothing to serve.
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Serve one record file as plain text (404s never confirm existence). */
export async function handleMonitorRecordsRequest(
  deps: {
    recordDir: () => string | null;
    token: string;
    logger: (line: string) => void;
  },
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  if (requestUrl.searchParams.get("token") !== deps.token) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const file = await resolveMonitorRecordFile(deps.recordDir(), pathname);
  if (file === null) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  try {
    const content = await readFile(file, "utf8");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(content);
  } catch (error) {
    deps.logger(`record serving failed: ${error instanceof Error ? error.message : String(error)}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "record serving failed" }));
  }
}
