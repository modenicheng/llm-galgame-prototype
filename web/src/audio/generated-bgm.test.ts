import { describe, expect, it, vi } from "vitest";
import type { MusicScore } from "@shared/music/score.js";
import type { BgmController } from "../stage/bgm-controller.js";
import { GeneratedBgm, type MusicScoreMessage } from "./generated-bgm.js";
import type { MusicRenderer } from "./music-renderer.js";

const score: MusicScore = {
  version: 1,
  bpm: 92,
  key: 0,
  mode: "major",
  bars: 16,
  tracks: [
    { instrument: "piano", gain: 0.8, notes: [{ beat: 0, dur: 1, midi: 60, vel: 90 }] },
  ],
};

function message(cacheKey: string): MusicScoreMessage {
  return { sceneId: "scene_1", themeId: "fortress-echo", cacheKey, score };
}

function fakeBuffer(): AudioBuffer {
  return {
    numberOfChannels: 1,
    length: 2,
    sampleRate: 8000,
    getChannelData: () => Float32Array.of(0.5, -0.5),
  } as unknown as AudioBuffer;
}

function makeFixture() {
  const bgm = { applyGenerated: vi.fn() } as unknown as BgmController;
  const render = vi.fn(async () => fakeBuffer());
  const renderer: MusicRenderer = { render };
  const urls = ["blob:a", "blob:b", "blob:c"];
  const createObjectUrl = vi.fn(() => urls.shift() ?? "blob:z");
  const revokeObjectUrl = vi.fn();
  const generated = new GeneratedBgm(bgm, renderer, createObjectUrl, revokeObjectUrl);
  return { generated, bgm, render, createObjectUrl, revokeObjectUrl };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("GeneratedBgm", () => {
  it("新谱渲染 → WAV blob URL → applyGenerated", async () => {
    const f = makeFixture();
    f.generated.handleScore(message("k1"));
    await flush();
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(f.bgm.applyGenerated).toHaveBeenCalledWith("blob:a");
  });

  it("同 key 重放（重连回放）幂等 no-op", async () => {
    const f = makeFixture();
    f.generated.handleScore(message("k1"));
    await flush();
    f.generated.handleScore(message("k1"));
    await flush();
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(f.bgm.applyGenerated).toHaveBeenCalledTimes(1);
  });

  it("新 key 替换旧曲并 revoke 旧 URL", async () => {
    const f = makeFixture();
    f.generated.handleScore(message("k1"));
    await flush();
    f.generated.handleScore(message("k2"));
    await flush();
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(f.bgm.applyGenerated).toHaveBeenLastCalledWith("blob:b");
    expect(f.revokeObjectUrl).toHaveBeenCalledWith("blob:a");
  });

  it("渲染失败只告警不外抛，下一曲照常", async () => {
    const bgm = { applyGenerated: vi.fn() } as unknown as BgmController;
    const outcomes: Array<Promise<AudioBuffer>> = [
      Promise.reject(new Error("decode fail")),
      Promise.resolve(fakeBuffer()),
    ];
    const render = vi.fn(() => outcomes.shift() ?? Promise.resolve(fakeBuffer()));
    const generated = new GeneratedBgm(bgm, { render }, () => "blob:x", () => {});
    expect(() => generated.handleScore(message("k1"))).not.toThrow();
    await flush();
    expect(bgm.applyGenerated).not.toHaveBeenCalled();
    generated.handleScore(message("k2"));
    await flush();
    expect(bgm.applyGenerated).toHaveBeenCalledWith("blob:x");
  });

  it("排队期间被更新 key 取代的旧谱被丢弃", async () => {
    const f = makeFixture();
    // 用受控的挂起 promise 卡住第一次渲染。
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<AudioBuffer>((resolve) => {
      releaseFirst = () => resolve(fakeBuffer());
    });
    f.render.mockImplementationOnce(() => first);
    f.generated.handleScore(message("k1"));
    await Promise.resolve();
    f.generated.handleScore(message("k2")); // 排队，latestKey 已是 k2
    releaseFirst?.(); // k1 渲染完成，但已被 k2 取代
    await flush();
    // k1 被丢弃 → 从未创建 URL；k2 是首个消费 blob 的谱。
    expect(f.bgm.applyGenerated).toHaveBeenCalledTimes(1);
    expect(f.bgm.applyGenerated).toHaveBeenCalledWith("blob:a");
  });
});
