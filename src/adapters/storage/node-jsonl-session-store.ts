/**
 * Node.js JSONL session store.
 *
 * Owns all filesystem concerns for a session: the `events.jsonl` event log
 * and the adjacent `state.json` snapshot, both under the per-session
 * directory `sessions/<sessionId>/` (audit P1-7) — the same directory the
 * narrative-memory store writes into, so artifacts never leak across
 * sessions. The core only sees the `SessionStorePort` surface.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  RuntimeSnapshot,
  SessionMetadata,
  SessionStorePort,
} from "../../core/ports/session-store-port.js";
import type { StoredEvent } from "../../schema.js";
import { saveStateSnapshot } from "../../story/state.js";

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

  async saveSnapshot(snapshot: RuntimeSnapshot): Promise<void> {
    const statePath = path.join(path.dirname(this.pathInternal), "state.json");
    await saveStateSnapshot(snapshot.state, statePath);
  }
}
