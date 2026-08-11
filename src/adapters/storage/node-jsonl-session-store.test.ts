/**
 * Tests for NodeJsonlSessionStore (audit P1-7: session-scoped dirs).
 *
 * The store must keep ALL session artifacts under
 * `sessions/<sessionId>/` (events.jsonl + state.json) — never flat files
 * in the sessions base directory that cross-session writes would
 * overwrite.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeJsonlSessionStore } from "./node-jsonl-session-store.js";
import { createInitialState } from "../../story/state.js";
import type { StoredEvent } from "../../schema.js";

/** Minimal narration StoredEvent for tests. */
function makeStoredEvent(seq: number): StoredEvent {
  return {
    seq,
    turn: 1,
    timestamp: new Date().toISOString(),
    source: "model",
    type: "narration",
    text: `Event ${seq}`,
    line_id: `line-${seq}`,
  } as StoredEvent;
}

describe("NodeJsonlSessionStore", () => {
  it("stores events and state under a per-session directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-store-"));
    try {
      const store = new NodeJsonlSessionStore(dir);
      await store.initialize({ sessionId: "sess-1" });
      await store.append(makeStoredEvent(1));
      await store.saveSnapshot({ state: createInitialState() });

      // Session-scoped paths exist…
      expect(existsSync(path.join(dir, "sess-1", "events.jsonl"))).toBe(true);
      expect(existsSync(path.join(dir, "sess-1", "state.json"))).toBe(true);
      // …and the old flat paths do not.
      expect(existsSync(path.join(dir, "state.json"))).toBe(false);
      expect(existsSync(path.join(dir, "sess-1.jsonl"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not write state.json to the cwd when saveSnapshot runs before initialize", async () => {
    // flush()/shutdown/restart can run on a game that never started; the
    // store must no-op instead of writing state.json into the working dir.
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-store-"));
    try {
      const store = new NodeJsonlSessionStore(dir);
      await store.saveSnapshot({ state: createInitialState() });
      expect(store.location).toBe("");
      expect(existsSync(path.join(dir, "state.json"))).toBe(false);
      expect(existsSync(path.resolve(process.cwd(), "state.json"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
