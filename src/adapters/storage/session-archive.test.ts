/**
 * Tests for the session archive (statistics & management).
 *
 * Fixtures replicate the on-disk save layout: `sessions/<sessionId>/`
 * with events.jsonl + state.json + narrative-memory files, plus the
 * legacy flat `*.jsonl` logs the pre-P1-7 layout left in the base dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  countLegacyLogFiles,
  deleteSessionSave,
  isValidSessionId,
  listSessionSaves,
  SessionSaveNotFoundError,
  summarizeArchive,
} from "./session-archive.js";

/** One valid model narration event line. */
function narrationLine(seq: number, turn: number, timestamp: string): string {
  return JSON.stringify({ seq, turn, timestamp, source: "model", type: "narration", text: "…", line_id: `l${seq}` });
}

function interactionLine(seq: number, turn: number, timestamp: string): string {
  return JSON.stringify({ seq, turn, timestamp, source: "model", type: "interaction" });
}

async function writeSave(
  base: string,
  sessionId: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = path.join(base, sessionId);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

describe("session archive", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "galgame-saves-"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("lists saves newest-first with per-save statistics", async () => {
    const older = "2026-09-14T10-00-00-000Z";
    const newer = "2026-09-16T09-00-00-000Z";
    await writeSave(base, older, {
      "events.jsonl": [
        narrationLine(1, 1, "2026-09-14T10:00:01.000Z"),
        interactionLine(2, 1, "2026-09-14T10:00:05.000Z"),
        narrationLine(3, 2, "2026-09-14T10:01:00.000Z"),
      ].join("\n") + "\n",
      "state.json": JSON.stringify({ phase: "active", nextTurn: 3 }),
    });
    await writeSave(base, newer, {
      "events.jsonl": narrationLine(1, 1, "2026-09-16T09:00:01.000Z") + "\n",
      "state.json": JSON.stringify({
        phase: "ended",
        ending: { type: "end", ending_id: "end_sweet", text: "…" },
      }),
      "narrative-state.json": "{}",
      "episodes.jsonl": "",
    });

    const saves = await listSessionSaves(base);
    expect(saves.map((save) => save.sessionId)).toEqual([newer, older]);

    const ended = saves[0];
    if (ended === undefined) throw new Error("expected the newer save");
    expect(ended.phase).toBe("ended");
    expect(ended.endingId).toBe("end_sweet");
    expect(ended.eventCount).toBe(1);
    expect(ended.hasNarrativeMemory).toBe(true);
    expect(ended.sizeBytes).toBeGreaterThan(0);

    const active = saves[1];
    if (active === undefined) throw new Error("expected the older save");
    expect(active.phase).toBe("active");
    expect(active.eventCount).toBe(3);
    expect(active.interactionCount).toBe(1);
    expect(active.turnCount).toBe(2);
    expect(active.createdAt).toBe("2026-09-14T10:00:01.000Z");
    expect(active.lastPlayedAt).toBe("2026-09-14T10:01:00.000Z");
    expect(active.hasSnapshot).toBe(true);
    expect(active.hasNarrativeMemory).toBe(false);
  });

  it("tolerates damaged lines and missing artifacts", async () => {
    await writeSave(base, "damaged", {
      "events.jsonl": [
        "{not json",
        JSON.stringify({ seq: 2, turn: 1, timestamp: "2026-09-15T08:00:00.000Z" }),
        narrationLine(3, 1, "2026-09-15T08:00:01.000Z"),
      ].join("\n") + "\n",
    });

    const [save] = await listSessionSaves(base);
    expect(save?.sessionId).toBe("damaged");
    if (save === undefined) throw new Error("expected one save");
    expect(save.hasSnapshot).toBe(false);
    expect(save.phase).toBeUndefined();
    expect(save.eventCount).toBe(1);
    expect(save.malformedLines).toBe(2);
    expect(save.hasNarrativeMemory).toBe(false);
    expect(save.createdAt).toBe("2026-09-15T08:00:01.000Z");
  });

  it("returns an empty list for a missing sessions dir", async () => {
    expect(await listSessionSaves(path.join(base, "nope"))).toEqual([]);
  });

  it("counts legacy flat logs but never lists them as saves", async () => {
    const legacy = JSON.stringify({ seq: 1, turn: 1, timestamp: "2026-07-31T08:26:35.746Z" }) + "\n";
    await writeFile(path.join(base, "2026-07-31T08-26-35-746Z.jsonl"), legacy, "utf8");
    await writeFile(path.join(base, "notes.txt"), "not a log", "utf8");
    await writeSave(base, "real-save", { "state.json": "{}" });

    const saves = await listSessionSaves(base);
    expect(saves.map((save) => save.sessionId)).toEqual(["real-save"]);

    const legacyStats = await countLegacyLogFiles(base);
    expect(legacyStats.legacyFiles).toBe(1);
    expect(legacyStats.legacyBytes).toBe((await stat(path.join(base, "2026-07-31T08-26-35-746Z.jsonl"))).size);
    expect((await countLegacyLogFiles(path.join(base, "nope"))).legacyFiles).toBe(0);
  });

  it("aggregates statuses, ending distribution, and legacy files", async () => {
    await writeSave(base, "ended-a", {
      "state.json": JSON.stringify({ phase: "ended", ending: { ending_id: "end_a" } }),
    });
    await writeSave(base, "ended-b", {
      "state.json": JSON.stringify({ phase: "ended", ending: { ending_id: "end_a" } }),
    });
    await writeSave(base, "running", { "state.json": JSON.stringify({ phase: "active" }) });
    await writeSave(base, "bare", {});
    await writeFile(path.join(base, "legacy.jsonl"), "x", "utf8");

    const saves = await listSessionSaves(base);
    const stats = summarizeArchive(saves, await countLegacyLogFiles(base));
    expect(stats.totalSaves).toBe(4);
    expect(stats.ended).toBe(2);
    expect(stats.active).toBe(1);
    expect(stats.withoutSnapshot).toBe(1);
    expect(stats.endings).toEqual({ end_a: 2 });
    expect(stats.legacyFiles).toBe(1);
  });

  describe("isValidSessionId", () => {
    it("accepts timestamp ids and safe names", () => {
      expect(isValidSessionId("2026-09-16T09-00-00-000Z")).toBe(true);
      expect(isValidSessionId("slot1")).toBe(true);
      expect(isValidSessionId("a.b-c_d")).toBe(true);
    });

    it("rejects path escapes and unsafe names", () => {
      expect(isValidSessionId("")).toBe(false);
      expect(isValidSessionId(".")).toBe(false);
      expect(isValidSessionId("..")).toBe(false);
      expect(isValidSessionId("../other")).toBe(false);
      expect(isValidSessionId("a/b")).toBe(false);
      expect(isValidSessionId("a\\b")).toBe(false);
      expect(isValidSessionId("/abs")).toBe(false);
      expect(isValidSessionId("C:\\temp")).toBe(false);
      expect(isValidSessionId(".hidden")).toBe(false);
      expect(isValidSessionId("x".repeat(121))).toBe(false);
      expect(isValidSessionId("x".repeat(120))).toBe(true);
    });
  });

  describe("deleteSessionSave", () => {
    it("removes only the target save directory", async () => {
      await writeSave(base, "gone", { "events.jsonl": narrationLine(1, 1, "2026-09-16T09:00:00.000Z") });
      await writeSave(base, "kept", { "state.json": "{}" });

      await deleteSessionSave(base, "gone");

      await expect(stat(path.join(base, "gone"))).rejects.toThrow();
      await expect(stat(path.join(base, "kept", "state.json"))).resolves.toBeTruthy();
    });

    it("reports unknown saves distinctly", async () => {
      await expect(deleteSessionSave(base, "missing")).rejects.toBeInstanceOf(SessionSaveNotFoundError);
    });

    it("refuses unsafe ids before touching the filesystem", async () => {
      await expect(deleteSessionSave(base, "../escape")).rejects.toThrow("非法的会话 ID");
      await expect(deleteSessionSave(base, ".")).rejects.toThrow("非法的会话 ID");
      // Nothing was created or removed outside a real save dir.
      await expect(stat(path.join(base, "..", "escape"))).rejects.toThrow();
    });

    it("refuses a flat file that is not a save directory", async () => {
      await writeFile(path.join(base, "stray"), "not a dir", "utf8");
      await expect(deleteSessionSave(base, "stray")).rejects.toThrow("非法的会话 ID");
    });
  });
});
