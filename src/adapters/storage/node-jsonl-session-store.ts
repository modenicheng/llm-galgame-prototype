/**
 * Node.js JSONL session store.
 *
 * Owns all filesystem concerns for a session: the `events.jsonl` event log
 * and the adjacent `state.json` snapshot, both under the per-session
 * directory `sessions/<sessionId>/` (audit P1-7) — the same directory the
 * narrative-memory store writes into, so artifacts never leak across
 * sessions. The core only sees the `SessionStorePort` surface.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  RuntimeSnapshot,
  SessionMetadata,
  SessionRestore,
  SessionStorePort,
} from "../../core/ports/session-store-port.js";
import { InteractionEventSchema, type EndEvent, type InteractionEvent, type StoredEvent } from "../../schema.js";
import { DialogueDraftEventSchema, NarrationDraftEventSchema } from "../../story/types.js";
import { deserializeState } from "../../story/state.js";
import type { StageCue, VisualState } from "../../core/presentation/types.js";

function isStoredEvent(value: unknown): value is StoredEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.seq !== "number" || !Number.isInteger(record.seq) || record.seq <= 0 ||
    typeof record.turn !== "number" || !Number.isInteger(record.turn) || record.turn <= 0 ||
    typeof record.timestamp !== "string" || record.timestamp.length === 0 ||
    (record.source !== "model" && record.source !== "player") ||
    typeof record.type !== "string"
  ) return false;

  if (record.source === "model") {
    if (record.type === "dialogue") return DialogueDraftEventSchema.safeParse(record).success && typeof record.line_id === "string";
    if (record.type === "narration") return NarrationDraftEventSchema.safeParse(record).success && typeof record.line_id === "string";
    if (record.type === "interaction") return InteractionEventSchema.safeParse(record).success;
    return record.type === "end" && typeof record.ending_id === "string" && typeof record.text === "string";
  }
  if (record.type === "player_choice") return typeof record.choice_id === "string" && typeof record.text === "string";
  if (record.type === "player_input") return typeof record.interaction_id === "string" && typeof record.text === "string";
  return record.type === "player_dialogue" && typeof record.interaction_id === "string" &&
    typeof record.speaker === "string" && typeof record.text === "string" && typeof record.line_id === "string";
}

function isEndEvent(value: unknown): value is EndEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "end" && typeof record.ending_id === "string" && typeof record.text === "string";
}

function isResumeInteraction(value: unknown): value is { turn: number; interaction: InteractionEvent; stage?: StageCue[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.turn !== "number" ||
    !Number.isInteger(record.turn) ||
    record.turn <= 0 ||
    !InteractionEventSchema.safeParse(record.interaction).success
  ) {
    return false;
  }
  return record.stage === undefined || Array.isArray(record.stage);
}

function isVisualState(value: unknown): value is VisualState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.characters === "object" && record.characters !== null && !Array.isArray(record.characters);
}

export class NodeJsonlSessionStore implements SessionStorePort {
  private pathInternal = "";

  constructor(private readonly sessionsDir: string) {}

  get location(): string {
    return this.pathInternal;
  }

  async initialize(metadata: SessionMetadata): Promise<void> {
    // 会话目录统一（audit P1-7）：sessions/<sessionId>/events.jsonl +
    // state.json，与 narrative-memory 文件同目录，避免跨会话覆盖。
    this.pathInternal = path.resolve(
      this.sessionsDir,
      metadata.sessionId,
      "events.jsonl",
    );
    await mkdir(path.dirname(this.pathInternal), { recursive: true });
  }

  async append(event: StoredEvent): Promise<void> {
    await appendFile(this.pathInternal, `${JSON.stringify(event)}\n`, "utf8");
  }

  async load(): Promise<SessionRestore> {
    if (this.pathInternal === "") return { events: [] };

    const events: StoredEvent[] = [];
    try {
      const raw = await readFile(this.pathInternal, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isStoredEvent(parsed)) events.push(parsed);
        } catch {
          // A damaged line must not hide the rest of an append-only log.
        }
      }
    } catch {
      // A missing log is a valid empty session; other startup state is still usable.
    }

    let snapshot: RuntimeSnapshot | undefined;
    try {
      const raw = await readFile(path.join(path.dirname(this.pathInternal), "state.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        state?: unknown;
        visualState?: unknown;
        phase?: RuntimeSnapshot["phase"];
        nextTurn?: number;
        lastEventSeq?: number;
        ending?: EndEvent;
        resumeInteraction?: { turn: number; interaction: InteractionEvent; stage?: StageCue[] };
      };
      const statePayload = parsed.state ?? parsed;
      if (typeof statePayload === "object" && statePayload !== null) {
        const restoredState = deserializeState(JSON.stringify(statePayload));
        snapshot = {
          state: restoredState,
          ...(isVisualState(parsed.visualState) ? { visualState: parsed.visualState } : {}),
          ...(parsed.phase === "active" || parsed.phase === "ended" ? { phase: parsed.phase } : {}),
          ...(typeof parsed.nextTurn === "number" && Number.isInteger(parsed.nextTurn) && parsed.nextTurn > 0
            ? { nextTurn: parsed.nextTurn }
            : {}),
          ...(typeof parsed.lastEventSeq === "number" && Number.isInteger(parsed.lastEventSeq) && parsed.lastEventSeq >= 0
            ? { lastEventSeq: parsed.lastEventSeq }
            : {}),
          ...(isEndEvent(parsed.ending) ? { ending: parsed.ending } : {}),
          ...(isResumeInteraction(parsed.resumeInteraction) ? { resumeInteraction: parsed.resumeInteraction } : {}),
        };
      }
    } catch {
      // Missing/corrupt snapshot falls back to event replay.
    }

    return snapshot === undefined ? { events } : { events, snapshot };
  }

  async saveSnapshot(snapshot: RuntimeSnapshot): Promise<void> {
    // Lifecycle guard: initialize() (game.run) assigns the per-session
    // path. flush()/shutdown/restart may run on a game that never started
    // (e.g. the web host shutting down before any player connected) — an
    // uninitialized store must not write state.json into the cwd.
    if (this.pathInternal === "") return;
    const statePath = path.join(path.dirname(this.pathInternal), "state.json");
    const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(snapshot), "utf8");
    await rename(tmpPath, statePath);
  }
}
