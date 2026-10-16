import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MusicIdentityStore } from "./music-identity-store.js";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "music-identity-"));
}

describe("MusicIdentityStore", () => {
  it("缺文件 = undefined；save 后 load 返回地区", async () => {
    const root = makeRoot();
    const store = new MusicIdentityStore(root, "game_1");
    await expect(store.load()).resolves.toBeUndefined();
    await store.save({ version: 1, region: "east-asia" });
    await expect(store.load()).resolves.toBe("east-asia");
  });

  it("世界创建期写一次：已存在拒绝覆写", async () => {
    const root = makeRoot();
    const store = new MusicIdentityStore(root, "game_1");
    await store.save({ version: 1, region: "celtic" });
    await expect(store.save({ version: 1, region: "nordic" })).rejects.toThrow("拒绝覆写");
    await expect(new MusicIdentityStore(root, "game_1").load()).resolves.toBe("celtic");
  });

  it("损坏文件大声抛错；词表外地区拒收", async () => {
    const root = makeRoot();
    const dir = path.join(root, "game_1", "world");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "music-identity.json"), "{ not json", "utf8");
    await expect(new MusicIdentityStore(root, "game_1").load()).rejects.toThrow();

    const root2 = makeRoot();
    const dir2 = path.join(root2, "game_1", "world");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      path.join(dir2, "music-identity.json"),
      JSON.stringify({ version: 1, region: "atlantis" }),
      "utf8",
    );
    await expect(new MusicIdentityStore(root2, "game_1").load()).rejects.toThrow();
  });
});
