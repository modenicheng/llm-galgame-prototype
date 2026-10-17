import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ComposerSessionStore } from "./composer-session-store.js";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "composer-session-"));
}

describe("ComposerSessionStore", () => {
  it("缺文件 = 空会话；append 按次追加 JSONL", async () => {
    const root = makeRoot();
    const store = new ComposerSessionStore(root, "game_1");
    await expect(store.readRecent(30)).resolves.toEqual([]);
    await store.append({ role: "user", content: '{"sceneId":"s1","mood":"tense"}' });
    await store.append({ role: "assistant", content: '{"action":"compose","themeId":"t1"}' });
    await expect(store.readRecent(30)).resolves.toEqual([
      { role: "user", content: '{"sceneId":"s1","mood":"tense"}' },
      { role: "assistant", content: '{"action":"compose","themeId":"t1"}' },
    ]);
    const raw = readFileSync(path.join(root, "game_1", "music", "session.jsonl"), "utf8");
    expect(raw.split("\n").filter((l) => l !== "")).toHaveLength(2);
  });

  it("readRecent 窗口截断：只取最近 N 轮", async () => {
    const root = makeRoot();
    const store = new ComposerSessionStore(root, "game_1");
    for (let i = 0; i < 5; i += 1) {
      await store.append({ role: "user", content: `brief-${i}` });
      await store.append({ role: "assistant", content: `decision-${i}` });
    }
    const recent = await store.readRecent(3);
    expect(recent).toEqual([
      { role: "assistant", content: "decision-3" },
      { role: "user", content: "brief-4" },
      { role: "assistant", content: "decision-4" },
    ]);
  });

  it("新实例从盘上恢复（跨进程续会话）", async () => {
    const root = makeRoot();
    await new ComposerSessionStore(root, "game_1").append({
      role: "user",
      content: "brief",
    });
    const reopened = new ComposerSessionStore(root, "game_1");
    await expect(reopened.readRecent(30)).resolves.toEqual([
      { role: "user", content: "brief" },
    ]);
  });

  it("损坏行大声抛错（会话损坏即不可信）", async () => {
    const root = makeRoot();
    const dir = path.join(root, "game_1", "music");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "session.jsonl"), '{"role":"user"\n', "utf8");
    await expect(new ComposerSessionStore(root, "game_1").readRecent(30)).rejects.toThrow();
  });

  it("未知 role 行拒收（schema 校验）", async () => {
    const root = makeRoot();
    const dir = path.join(root, "game_1", "music");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "session.jsonl"), '{"role":"system","content":"x"}\n', "utf8");
    await expect(new ComposerSessionStore(root, "game_1").readRecent(30)).rejects.toThrow();
  });
});
