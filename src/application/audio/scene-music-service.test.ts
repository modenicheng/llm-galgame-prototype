import { describe, expect, it, vi } from "vitest";
import type { SceneDirective } from "../director/director-service.js";
import type { MusicScore, SceneMusicDirection } from "../../shared/music/score.js";
import { musicCacheKey } from "./music-cache-key.js";
import {
  SceneMusicService,
  type SceneMusicComposerPort,
  type SceneMusicScoreEvent,
} from "./scene-music-service.js";

const direction: SceneMusicDirection = { mood: "tense", intensity: 2 };

function makeDirective(music?: SceneMusicDirection): SceneDirective {
  return {
    sceneId: "scene_1",
    defenseBeats: [],
    endingPressure: false,
    ...(music !== undefined ? { music } : {}),
  };
}

function fakeComposer(
  behavior: (request: { sceneId: string }) => Promise<MusicScore | null>,
): SceneMusicComposerPort & { compose: ReturnType<typeof vi.fn> } {
  return { compose: vi.fn(behavior) };
}

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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("SceneMusicService", () => {
  it("无音乐指导的 directive 不触发作曲", () => {
    const composer = fakeComposer(async () => score);
    new SceneMusicService({ composer }).handleDirective(makeDirective());
    expect(composer.compose).not.toHaveBeenCalled();
  });

  it("作曲成功 → 订阅者收到带确定性 cacheKey 的谱面事件", async () => {
    const composer = fakeComposer(async () => score);
    const service = new SceneMusicService({ composer });
    const events: SceneMusicScoreEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]!.sceneId).toBe("scene_1");
    expect(events[0]!.cacheKey).toBe(musicCacheKey(score));
    expect(service.latestScore()).toEqual(events[0]);
  });

  it("同场景同指导去重，指导变化才重新作曲", async () => {
    const composer = fakeComposer(async () => score);
    const service = new SceneMusicService({ composer });
    service.handleDirective(makeDirective(direction));
    await flush();
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(composer.compose).toHaveBeenCalledTimes(1);
    service.handleDirective(makeDirective({ mood: "warm", intensity: 1 }));
    await flush();
    expect(composer.compose).toHaveBeenCalledTimes(2);
  });

  it("作曲返回 null → 只降级不广播", async () => {
    const composer = fakeComposer(async () => null);
    const service = new SceneMusicService({ composer });
    const listener = vi.fn();
    service.subscribe(listener);
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(service.latestScore()).toBeUndefined();
  });

  it("作曲抛异常 → 吞掉不外抛", async () => {
    const composer = fakeComposer(async () => {
      throw new Error("LLM down");
    });
    const service = new SceneMusicService({ composer });
    expect(() => service.handleDirective(makeDirective(direction))).not.toThrow();
    await flush();
  });
});
