/**
 * Node.js JSONL session store.
 *
 * Owns all filesystem concerns for a session: the `.jsonl` event log and
 * the adjacent `state.json` snapshot. The core only sees the
 * `SessionStorePort` surface.
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
    this.pathInternal = path.resolve(
      this.sessionsDir,
      `${metadata.sessionId}.jsonl`,
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
