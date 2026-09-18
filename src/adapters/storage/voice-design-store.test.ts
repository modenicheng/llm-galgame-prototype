/**
 * VoiceDesignStore tests（角色音频特征设计 V2）：roundtrip、拒绝覆写、
 * 缺失 = undefined、损坏大声抛错。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  it("roundtrips save/load with zod defaults preserved", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "voice-design-"));
    try {
      const store = new VoiceDesignStore(root, "game_v1");
      await store.save(FILE);
      expect(await store.load()).toEqual(FILE);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when the world has no voice design", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "voice-design-"));
    try {
      expect(await new VoiceDesignStore(root, "game_empty").load()).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing file (world-creation-once discipline)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "voice-design-"));
    try {
      const store = new VoiceDesignStore(root, "game_v1");
      await store.save(FILE);
      await expect(store.save(FILE)).rejects.toThrow("拒绝覆写");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws loudly on corrupted JSON or schema drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "voice-design-"));
    try {
      const dir = path.join(root, "game_bad", "world");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "voice-design.json"), "{not json", "utf8");
      await expect(new VoiceDesignStore(root, "game_bad").load()).rejects.toThrow();

      await writeFile(
        path.join(dir, "voice-design.json"),
        JSON.stringify({ version: 2, characters: {} }),
        "utf8",
      );
      await expect(new VoiceDesignStore(root, "game_bad").load()).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
