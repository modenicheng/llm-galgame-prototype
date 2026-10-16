import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MusicScore } from "../../shared/music/score.js";
import { MusicLibraryStore } from "./music-library-store.js";

const score: MusicScore = {
  version: 1,
  bpm: 92,
  key: 9,
  mode: "minor",
  bars: 16,
  tracks: [
    { instrument: "piano", gain: 0.8, notes: [{ beat: 0, dur: 1, midi: 60, vel: 90 }] },
  ],
};

const otherScore: MusicScore = {
  ...score,
  bpm: 58,
  tracks: [
    { instrument: "strings", gain: 0.9, notes: [{ beat: 0, dur: 4, midi: 50, vel: 60 }] },
  ],
};

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "music-library-"));
}

describe("MusicLibraryStore", () => {
  it("缺文件 = 空库；put 后 get 命中，落盘为 music/library.json", async () => {
    const root = makeRoot();
    const store = new MusicLibraryStore(root, "game_1");
    await expect(store.get("tense:2")).resolves.toBeUndefined();
    await store.put("tense:2", score);
    await expect(store.get("tense:2")).resolves.toEqual(score);
    const raw = JSON.parse(readFileSync(path.join(root, "game_1", "music", "library.json"), "utf8"));
    expect(raw).toEqual({ version: 1, entries: { "tense:2": score } });
  });

  it("新实例从盘上恢复（跨进程重启复用）", async () => {
    const root = makeRoot();
    await new MusicLibraryStore(root, "game_1").put("tense:2", score);
    const reopened = new MusicLibraryStore(root, "game_1");
    await expect(reopened.get("tense:2")).resolves.toEqual(score);
    await reopened.put("warm:1", otherScore);
    await expect(reopened.get("warm:1")).resolves.toEqual(otherScore);
  });

  it("同键覆写 = no-op：首作即定稿", async () => {
    const root = makeRoot();
    const store = new MusicLibraryStore(root, "game_1");
    await store.put("tense:2", score);
    await store.put("tense:2", otherScore);
    await expect(store.get("tense:2")).resolves.toEqual(score);
  });

  it("put 原子写：不留 tmp 残留", async () => {
    const root = makeRoot();
    const store = new MusicLibraryStore(root, "game_1");
    await store.put("tense:2", score);
    const dir = path.join(root, "game_1", "music");
    expect(readdirSync(dir).filter((name) => name.startsWith("library.json.tmp"))).toEqual([]);
  });

  it("损坏文件大声抛错（谱库损坏即不可信）", async () => {
    const root = makeRoot();
    const dir = path.join(root, "game_1", "music");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "library.json"), "{ not json", "utf8");
    await expect(new MusicLibraryStore(root, "game_1").get("tense:2")).rejects.toThrow();
  });

  it("schema 不合的条目拒收（键值漂移防御）", async () => {
    const root = makeRoot();
    const dir = path.join(root, "game_1", "music");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "library.json"),
      JSON.stringify({ version: 1, entries: { "tense:2": { version: 99 } } }),
      "utf8",
    );
    await expect(new MusicLibraryStore(root, "game_1").get("tense:2")).rejects.toThrow();
  });
});
