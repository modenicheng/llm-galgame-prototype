/**
 * Session archive — statistics & management over existing saves.
 *
 * Complements NodeJsonlSessionStore (single-session read/write) with the
 * cross-session view nothing else provides: what saves exist under
 * `sessions/`, how far each got, and safe deletion. Read-only scanning is
 * deliberately tolerant (a damaged save is reported, not fatal); deletion
 * is the only mutating operation and validates the session id against the
 * same path-escape discipline as the asset catalog loader.
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { RuntimeSnapshot } from "../../core/ports/session-store-port.js";

/** Files the narrative memory store writes next to events.jsonl. */
const NARRATIVE_FILES = [
  "narrative-state.json",
  "episodes.jsonl",
  "narrative-ops.jsonl",
  "director-plan.json",
] as const;

/** Per-save summary produced by scanning `sessions/<sessionId>/`. */
export interface SessionSaveSummary {
  sessionId: string;
  /** Absolute path of the save directory. */
  dir: string;
  /** First event timestamp; undefined for a snapshot-only save. */
  createdAt?: string;
  /** Last event timestamp; undefined when the log is empty. */
  lastPlayedAt?: string;
  /** Number of parseable event lines. */
  eventCount: number;
  /** Events the model authored, by type (dialogue/narration/interaction/end). */
  modelEvents: Record<string, number>;
  /** Player events, by type (player_choice/player_input/player_dialogue). */
  playerEvents: Record<string, number>;
  /** Lines that are not valid JSON or not recognizable events. */
  malformedLines: number;
  /** Highest turn number seen in the log. */
  turnCount: number;
  /** Model→player interaction prompts the log contains. */
  interactionCount: number;
  hasSnapshot: boolean;
  /** Snapshot phase, when state.json is readable. */
  phase?: RuntimeSnapshot["phase"];
  /** Terminal ending recorded in the snapshot, when the save has ended. */
  endingId?: string;
  hasNarrativeMemory: boolean;
  /** Total bytes of events.jsonl + state.json + narrative files. */
  sizeBytes: number;
}

/** Aggregate view over all saves plus the sessions base directory itself. */
export interface SessionArchiveStats {
  totalSaves: number;
  active: number;
  ended: number;
  /** Saves with no readable state.json (event replay still works). */
  withoutSnapshot: number;
  /** Distribution of ending ids across ended saves. */
  endings: Record<string, number>;
  totalEvents: number;
  totalSizeBytes: number;
  /**
   * Legacy flat `*.jsonl` files sitting directly in the sessions base
   * directory — pre-P1-7 layout, not loadable saves, report-only.
   */
  legacyFiles: number;
  legacyBytes: number;
}

/**
 * A session id must be a single safe path segment (timestamps by default,
 * but any user-chosen name): letters/digits first, then `._-` allowed.
 * Blocks separators, `.`/`..`, and absolute/Windows-style paths outright.
 */
export function isValidSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(sessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Count one events.jsonl line into the summary buckets. */
function countEventLine(
  line: string,
  summary: {
    eventCount: number;
    malformedLines: number;
    modelEvents: Record<string, number>;
    playerEvents: Record<string, number>;
    turnCount: number;
    interactionCount: number;
    firstTs: string | undefined;
    lastTs: string | undefined;
  },
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    summary.malformedLines += 1;
    return;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    summary.malformedLines += 1;
    return;
  }
  const source = parsed.source === "player" ? "player" : parsed.source === "model" ? "model" : null;
  if (source === null) {
    summary.malformedLines += 1;
    return;
  }
  summary.eventCount += 1;
  if (typeof parsed.timestamp === "string" && parsed.timestamp.length > 0) {
    if (summary.firstTs === undefined || parsed.timestamp < summary.firstTs) {
      summary.firstTs = parsed.timestamp;
    }
    if (summary.lastTs === undefined || parsed.timestamp > summary.lastTs) {
      summary.lastTs = parsed.timestamp;
    }
  }
  if (typeof parsed.turn === "number" && Number.isInteger(parsed.turn) && parsed.turn > summary.turnCount) {
    summary.turnCount = parsed.turn;
  }
  const bucket = source === "model" ? summary.modelEvents : summary.playerEvents;
  bucket[parsed.type] = (bucket[parsed.type] ?? 0) + 1;
  if (source === "model" && parsed.type === "interaction") summary.interactionCount += 1;
}

/** Light state.json read: existence + phase/ending only, tolerant of damage. */
async function readSnapshotInfo(
  saveDir: string,
): Promise<{ hasSnapshot: boolean; phase?: RuntimeSnapshot["phase"]; endingId?: string }> {
  try {
    const raw = await readFile(path.join(saveDir, "state.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { hasSnapshot: true };
    const phase =
      parsed.phase === "active" || parsed.phase === "ended" ? parsed.phase : undefined;
    const ending = isRecord(parsed.ending) && typeof parsed.ending.ending_id === "string"
      ? { endingId: parsed.ending.ending_id }
      : {};
    return { hasSnapshot: true, phase, ...ending };
  } catch {
    return { hasSnapshot: false };
  }
}

/**
 * Scan one save directory. Tolerates every partial state: no event log,
 * no snapshot, damaged lines — the summary reports what is there.
 */
export async function summarizeSave(saveDir: string, sessionId: string): Promise<SessionSaveSummary> {
  const summary = {
    eventCount: 0,
    malformedLines: 0,
    modelEvents: {} as Record<string, number>,
    playerEvents: {} as Record<string, number>,
    turnCount: 0,
    interactionCount: 0,
    firstTs: undefined as string | undefined,
    lastTs: undefined as string | undefined,
  };

  let sizeBytes = 0;
  try {
    const raw = await readFile(path.join(saveDir, "events.jsonl"), "utf8");
    const { size } = await stat(path.join(saveDir, "events.jsonl"));
    sizeBytes += size;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      countEventLine(trimmed, summary);
    }
  } catch {
    // No/unreadable event log: the save may still carry a snapshot.
  }

  const snapshot = await readSnapshotInfo(saveDir);
  if (snapshot.hasSnapshot) {
    try {
      sizeBytes += (await stat(path.join(saveDir, "state.json"))).size;
    } catch {
      // Unlinked concurrently; size reporting is best-effort.
    }
  }

  let hasNarrativeMemory = false;
  for (const file of NARRATIVE_FILES) {
    try {
      sizeBytes += (await stat(path.join(saveDir, file))).size;
      hasNarrativeMemory = true;
    } catch {
      // This narrative artifact was not written yet.
    }
  }

  return {
    sessionId,
    dir: path.resolve(saveDir),
    ...(summary.firstTs !== undefined ? { createdAt: summary.firstTs } : {}),
    ...(summary.lastTs !== undefined ? { lastPlayedAt: summary.lastTs } : {}),
    eventCount: summary.eventCount,
    modelEvents: summary.modelEvents,
    playerEvents: summary.playerEvents,
    malformedLines: summary.malformedLines,
    turnCount: summary.turnCount,
    interactionCount: summary.interactionCount,
    ...snapshot,
    hasNarrativeMemory,
    sizeBytes,
  };
}

/** Aggregate per-save summaries plus legacy flat-file counts in the base dir. */
export function summarizeArchive(
  saves: readonly SessionSaveSummary[],
  archive: { legacyFiles: number; legacyBytes: number },
): SessionArchiveStats {
  const endings: Record<string, number> = {};
  let ended = 0;
  let withoutSnapshot = 0;
  let totalEvents = 0;
  let totalSizeBytes = 0;
  for (const save of saves) {
    if (save.phase === "ended") {
      ended += 1;
      const key = save.endingId ?? "(unknown)";
      endings[key] = (endings[key] ?? 0) + 1;
    } else if (!save.hasSnapshot) {
      withoutSnapshot += 1;
    }
    totalEvents += save.eventCount;
    totalSizeBytes += save.sizeBytes;
  }
  return {
    totalSaves: saves.length,
    active: saves.length - ended - withoutSnapshot,
    ended,
    withoutSnapshot,
    endings,
    totalEvents,
    totalSizeBytes,
    ...archive,
  };
}

/**
 * List every save under `sessionsDir` (per-session directories only),
 * newest activity first. Directories that fail to stat are skipped.
 */
export async function listSessionSaves(sessionsDir: string): Promise<SessionSaveSummary[]> {
  const base = path.resolve(sessionsDir);
  let entries: Dirent[] = [];
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const summaries: SessionSaveSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    summaries.push(await summarizeSave(path.join(base, entry.name), entry.name));
  }
  // Newest activity first; never-played saves sink by directory name.
  summaries.sort((a, b) => {
    const keyA = a.lastPlayedAt ?? a.createdAt ?? "";
    const keyB = b.lastPlayedAt ?? b.createdAt ?? "";
    return keyB.localeCompare(keyA) || b.sessionId.localeCompare(a.sessionId);
  });
  return summaries;
}

/**
 * Count legacy flat event logs sitting directly in the sessions base
 * directory (pre-P1-7 layout). Report-only: they are not loadable saves
 * and the archive never touches them.
 */
export async function countLegacyLogFiles(
  sessionsDir: string,
): Promise<{ legacyFiles: number; legacyBytes: number }> {
  const base = path.resolve(sessionsDir);
  let entries: Dirent[] = [];
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return { legacyFiles: 0, legacyBytes: 0 };
  }
  let legacyFiles = 0;
  let legacyBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      legacyBytes += (await stat(path.join(base, entry.name))).size;
      legacyFiles += 1;
    } catch {
      // Unlinked concurrently; skip.
    }
  }
  return { legacyFiles, legacyBytes };
}

export class SessionSaveNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`存档不存在：${sessionId}`);
    this.name = "SessionSaveNotFoundError";
  }
}

/**
 * Delete one save directory. Refuses anything that is not a strict,
 * existing session id so a hostile input can never escape `sessionsDir`.
 */
export async function deleteSessionSave(sessionsDir: string, sessionId: string): Promise<void> {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`非法的会话 ID：${JSON.stringify(sessionId)}`);
  }
  const saveDir = path.resolve(sessionsDir, sessionId);
  const base = path.resolve(sessionsDir);
  if (!saveDir.startsWith(base + path.sep)) {
    throw new Error(`非法的会话 ID：${JSON.stringify(sessionId)}`);
  }
  let info;
  try {
    info = await stat(saveDir);
  } catch {
    throw new SessionSaveNotFoundError(sessionId);
  }
  if (!info.isDirectory()) {
    throw new Error(`非法的会话 ID：${JSON.stringify(sessionId)}`);
  }
  await rm(saveDir, { recursive: true, force: true });
}
