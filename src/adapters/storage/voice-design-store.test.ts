/**
 * VoiceDesignStore tests（角色音频特征设计 V2）：roundtrip、拒绝覆写、
 * 缺失 = undefined、损坏大声抛错。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VoiceDesignStore, type VoiceDesignFile } from "./voice-design-store.js";

const FILE: VoiceDesignFile = {
  version: 1,
  characters: {
    su_yao: {
      name: "苏遥",
      voice: {
        timbre: "年轻女性，清亮偏冷",
        delivery: ["restrained", "firm"],
        avoid: ["playful"],
        baseline: { pace: "slow", volume: "soft" },
      },
    },
  },
};

describe("VoiceDesignStore", () => {
  let root: string;
  let store: VoiceDesignStore;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "voice-design-"));
    store = new VoiceDesignStore(root, "game_v1");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("roundtrips save/load", async () => {
    await store.save(FILE);
    expect(await store.load()).toEqual(FILE);
  });

  it("returns undefined when the world has no voice design", async () => {
    expect(await new VoiceDesignStore(root, "game_empty").load()).toBeUndefined();
  });

  it("refuses to overwrite an existing file (world-creation-once discipline)", async () => {
    await store.save(FILE);
    await expect(store.save(FILE)).rejects.toThrow("拒绝覆写");
  });

  it("throws loudly on corrupted JSON or schema drift", async () => {
    const dir = path.join(root, "game_bad", "world");
    const bad = new VoiceDesignStore(root, "game_bad");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "voice-design.json"), "{not json", "utf8");
    await expect(bad.load()).rejects.toThrow();
    await writeFile(path.join(dir, "voice-design.json"), JSON.stringify({ version: 2, characters: {} }), "utf8");
    await expect(bad.load()).rejects.toThrow();
  });
});
