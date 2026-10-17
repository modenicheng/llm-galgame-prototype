import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MusicScore } from "../../shared/music/score.js";
import type { MusicThemeMeta } from "../../shared/music/theme.js";
import { MusicThemeStore } from "./music-theme-store.js";

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

const meta: MusicThemeMeta = {
  id: "fortress-echo",
  title: "堡垒回响",
  concept: "地下堡垒——压抑的机械回响",
  motifHint: "60,64,67,72",
};

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "music-theme-"));
}

describe("MusicThemeStore", () => {
  it("缺文件 = 空目录；addTheme+putScore 落盘 themes.json 与 scores/<id>.json", async () => {
    const root = makeRoot();
    const store = new MusicThemeStore(root, "game_1");
    await expect(store.listThemes()).resolves.toEqual([]);
    await expect(store.getBinding("scene_1")).resolves.toBeUndefined();
    await store.addTheme(meta, { sceneId: "scene_1" });
    await store.putScore("fortress-echo", score);
    await expect((await store.listThemes()).map((t) => t.id)).toEqual(["fortress-echo"]);
    await expect(store.getBinding("scene_1")).resolves.toBe("fortress-echo");
    await expect(store.getScore("fortress-echo")).resolves.toEqual(score);
    const raw = JSON.parse(
      readFileSync(path.join(root, "game_1", "music", "themes.json"), "utf8"),
    );
    expect(raw).toEqual({
      version: 1,
      themes: [meta],
      bindings: { scene_1: "fortress-echo" },
    });
    expect(
      JSON.parse(
        readFileSync(path.join(root, "game_1", "music", "scores", "fortress-echo.json"), "utf8"),
      ),
    ).toEqual(score);
  });

  it("新实例从盘上恢复（跨进程重启：绑定命中零 LLM）", async () => {
    const root = makeRoot();
    const store = new MusicThemeStore(root, "game_1");
    await store.addTheme(meta, { sceneId: "scene_1" });
    await store.putScore("fortress-echo", score);
    const reopened = new MusicThemeStore(root, "game_1");
    await expect(reopened.getBinding("scene_1")).resolves.toBe("fortress-echo");
    await expect(reopened.getScore("fortress-echo")).resolves.toEqual(score);
  });

  it("同 id 主题/谱面覆写 = no-op（首作即定稿）；绑定仍会补写", async () => {
    const root = makeRoot();
    const store = new MusicThemeStore(root, "game_1");
    await store.addTheme(meta);
    const drifted: MusicThemeMeta = { ...meta, title: "漂移标题" };
    await store.addTheme(drifted, { sceneId: "scene_9" });
    await expect((await store.listThemes())[0]!.title).toBe("堡垒回响");
    await expect(store.getBinding("scene_9")).resolves.toBe("fortress-echo");
    await store.putScore("fortress-echo", score);
    await store.putScore("fortress-echo", otherScore);
    await expect(store.getScore("fortress-echo")).resolves.toEqual(score);
  });

  it("bindScene 只补绑定不碰主题；同绑定幂等", async () => {
    const root = makeRoot();
    const store = new MusicThemeStore(root, "game_1");
    await store.addTheme(meta);
    await store.bindScene("scene_2", "fortress-echo");
    await store.bindScene("scene_2", "fortress-echo");
    await expect(store.getBinding("scene_2")).resolves.toBe("fortress-echo");
    await expect((await store.listThemes()).map((t) => t.id)).toEqual(["fortress-echo"]);
  });

  it("getScore：缺文件 = undefined；谱面未落盘的主题由调用方降级", async () => {
    const root = makeRoot();
    const store = new MusicThemeStore(root, "game_1");
    await store.addTheme(meta);
    await expect(store.getScore("fortress-echo")).resolves.toBeUndefined();
    await expect(store.getScore("never-exists")).resolves.toBeUndefined();
  });

  it("写均为 tmp+rename 原子（不留残留）", async () => {
    const root = makeRoot();
    const store = new MusicThemeStore(root, "game_1");
    await store.addTheme(meta);
    await store.putScore("fortress-echo", score);
    const musicDir = path.join(root, "game_1", "music");
    expect(readdirSync(musicDir).filter((n) => n.includes(".tmp"))).toEqual([]);
    expect(readdirSync(path.join(musicDir, "scores")).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("themes.json 损坏 / schema 不合大声抛错；谱面文件损坏大声抛错", async () => {
    const root = makeRoot();
    const musicDir = path.join(root, "game_1", "music");
    mkdirSync(musicDir, { recursive: true });
    writeFileSync(path.join(musicDir, "themes.json"), "{ not json", "utf8");
    await expect(new MusicThemeStore(root, "game_1").listThemes()).rejects.toThrow();

    const root2 = makeRoot();
    const store2 = new MusicThemeStore(root2, "game_1");
    await store2.addTheme(meta);
    const scoresDir = path.join(root2, "game_1", "music", "scores");
    mkdirSync(scoresDir, { recursive: true });
    writeFileSync(path.join(scoresDir, "fortress-echo.json"), "{ not json", "utf8");
    await expect(store2.getScore("fortress-echo")).rejects.toThrow();
  });

  it("并发变更写互斥：并行 addTheme/bindScene/putScore 不丢更新（对抗性评审 P1）", async () => {
    const root = makeRoot();
    const store = new MusicThemeStore(root, "game_1");
    const metaB: MusicThemeMeta = {
      id: "market-dawn",
      title: "晨市",
      concept: "港口晨市",
    };
    // 八个并发变更（两主题 × 绑定/谱面混合）全部等齐再验目录——无写
    // 互斥时后写者基于旧快照覆写 themes.json，先写者条目被静默丢弃。
    await Promise.all([
      store.addTheme(meta, { sceneId: "s1" }),
      store.addTheme(metaB, { sceneId: "s2" }),
      store.addTheme(metaB),
      store.bindScene("s3", "fortress-echo"),
      store.addTheme(meta, { sceneId: "s4" }),
      store.putScore("fortress-echo", score),
      store.putScore("market-dawn", otherScore),
      store.bindScene("s5", "market-dawn"),
    ]);
    const reopened = new MusicThemeStore(root, "game_1");
    await expect(reopened.listThemes()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fortress-echo" }),
        expect.objectContaining({ id: "market-dawn" }),
      ]),
    );
    await expect(reopened.getBinding("s1")).resolves.toBe("fortress-echo");
    await expect(reopened.getBinding("s2")).resolves.toBe("market-dawn");
    await expect(reopened.getBinding("s3")).resolves.toBe("fortress-echo");
    await expect(reopened.getBinding("s4")).resolves.toBe("fortress-echo");
    await expect(reopened.getBinding("s5")).resolves.toBe("market-dawn");
    await expect(reopened.getScore("fortress-echo")).resolves.toEqual(score);
    await expect(reopened.getScore("market-dawn")).resolves.toEqual(otherScore);
  });
});
