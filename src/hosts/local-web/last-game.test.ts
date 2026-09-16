/**
 * games/.last-game — 最近世界 id 持久化（M5.0 宿主接线）。
 * 契约：读失败/缺失/内容非法 → undefined（开新世界）；写失败静默不阻塞。
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isValidGameId,
  readLastGameId,
  resolveExplicitGameId,
  writeLastGameId,
} from "./last-game.js";

describe("readLastGameId", () => {
  it("returns the persisted id after a write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "galgame-last-game-"));
    try {
      writeLastGameId(root, "game_2026-09-17T00-00-00-000Z");
      expect(readLastGameId(root)).toBe("game_2026-09-17T00-00-00-000Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when the file is missing (fresh world)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "galgame-last-game-"));
    try {
      expect(readLastGameId(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats corrupted or empty content as missing (fresh world)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "galgame-last-game-"));
    try {
      await writeFile(path.join(root, ".last-game"), "\x00\x01binary-noise", "utf8");
      expect(readLastGameId(root)).toBeUndefined();
      await writeFile(path.join(root, ".last-game"), "", "utf8");
      expect(readLastGameId(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects path-traversal ids from the file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "galgame-last-game-"));
    try {
      await writeFile(path.join(root, ".last-game"), "../escape", "utf8");
      expect(readLastGameId(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("writeLastGameId", () => {
  it("creates the games root when missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "galgame-last-game-"));
    try {
      const gamesRoot = path.join(root, "games");
      writeLastGameId(gamesRoot, "game_x");
      expect(readLastGameId(gamesRoot)).toBe("game_x");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("swallows write failures (best-effort, never blocks startup)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "galgame-last-game-"));
    try {
      const blocker = path.join(root, "not-a-dir");
      await writeFile(blocker, "x", "utf8");
      expect(() => writeLastGameId(blocker, "game_x")).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveExplicitGameId", () => {
  const env = (gameId?: string): Record<string, string | undefined> =>
    gameId === undefined ? {} : { VIBEGAL_GAME_ID: gameId };

  it("prefers the explicit argument over the environment variable", () => {
    expect(resolveExplicitGameId("game_arg", env("game_env"))).toBe("game_arg");
  });

  it("falls back to the environment variable", () => {
    expect(resolveExplicitGameId(undefined, env("game_env"))).toBe("game_env");
  });

  it("returns undefined when neither is set", () => {
    expect(resolveExplicitGameId(undefined, env())).toBeUndefined();
  });

  it("throws on unsafe ids (they become directory names)", () => {
    expect(() => resolveExplicitGameId("../evil", env())).toThrow();
    expect(() => resolveExplicitGameId(undefined, env("a b"))).toThrow();
  });
});

describe("isValidGameId", () => {
  it("accepts timestamp-style generated ids and simple names", () => {
    expect(isValidGameId("game_2026-09-17T00-00-00-000Z")).toBe(true);
    expect(isValidGameId("my_world.1")).toBe(true);
  });

  it("rejects empty, traversal and separator-bearing ids", () => {
    expect(isValidGameId("")).toBe(false);
    expect(isValidGameId("../escape")).toBe(false);
    expect(isValidGameId("a/b")).toBe(false);
    expect(isValidGameId("a\\b")).toBe(false);
    expect(isValidGameId(".hidden")).toBe(false);
  });
});
