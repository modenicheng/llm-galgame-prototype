import { describe, expect, it, vi } from "vitest";
import type { SceneDirective } from "../director/director-service.js";
import type { MusicScore, SceneMusicDirection } from "../../shared/music/score.js";
import { musicCacheKey } from "./music-cache-key.js";
import {
  SceneMusicService,
  musicLibraryKey,
  type SceneMusicComposeRequest,
  type SceneMusicComposerPort,
  type SceneMusicLibraryPort,
  type SceneMusicScoreEvent,
} from "./scene-music-service.js";

const direction: SceneMusicDirection = { mood: "tense", intensity: 2 };

function makeDirective(music?: SceneMusicDirection, sceneId = "scene_1"): SceneDirective {
  return {
    sceneId,
    defenseBeats: [],
    endingPressure: false,
    ...(music !== undefined ? { music } : {}),
  };
}

function fakeComposer(
  behavior: (request: SceneMusicComposeRequest) => Promise<MusicScore | null>,
): SceneMusicComposerPort & { compose: ReturnType<typeof vi.fn> } {
  return { compose: vi.fn(behavior) };
}

function fakeLibrary(
  initial: Record<string, MusicScore> = {},
): SceneMusicLibraryPort & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } {
  const entries = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => entries.get(key)),
    put: vi.fn(async (key: string, score: MusicScore) => {
      if (!entries.has(key)) entries.set(key, score);
    }),
  };
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

const otherScore: MusicScore = {
  ...score,
  bpm: 126,
  tracks: [
    { instrument: "strings", gain: 0.9, notes: [{ beat: 0, dur: 2, midi: 55, vel: 70 }] },
  ],
};

async function flush(): Promise<void> {
  // 谱库 get/put + 作曲 + publish 全链微任务，一个宏任务跳排干。
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("musicLibraryKey", () => {
  it("复用键 = region:mood:intensity，note 不参与", () => {
    expect(musicLibraryKey({ mood: "tense", intensity: 2 })).toBe("default:tense:2");
    expect(musicLibraryKey({ mood: "tense", intensity: 2, note: "不同注记" })).toBe(
      "default:tense:2",
    );
  });

  it("地区维度：导演覆盖 > 世界锚 > default", () => {
    const anchored = { mood: "tense", intensity: 2 } as SceneMusicDirection;
    expect(musicLibraryKey(anchored, "east-asia")).toBe("east-asia:tense:2");
    expect(musicLibraryKey({ ...anchored, region: "celtic" }, "east-asia")).toBe("celtic:tense:2");
    // 不同地区同情绪 = 不同键（各地区独立成曲）。
    expect(musicLibraryKey(anchored, "celtic")).not.toBe(musicLibraryKey(anchored, "east-asia"));
  });
});

describe("SceneMusicService", () => {
  it("无音乐指导的 directive 不触发作曲", () => {
    const composer = fakeComposer(async () => score);
    new SceneMusicService({ composer }).handleDirective(makeDirective());
    expect(composer.compose).not.toHaveBeenCalled();
  });

  it("作曲成功 → 落盘谱库 → 订阅者收到带确定性 cacheKey 的谱面事件", async () => {
    const composer = fakeComposer(async () => score);
    const library = fakeLibrary();
    const service = new SceneMusicService({ composer, library });
    const events: SceneMusicScoreEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]!.sceneId).toBe("scene_1");
    expect(events[0]!.cacheKey).toBe(musicCacheKey(score));
    expect(service.latestScore()).toEqual(events[0]);
    expect(library.put).toHaveBeenCalledWith("default:tense:2", score);
  });

  it("世界锚地区回落：无覆盖时请求与复用键用 worldRegion", async () => {
    const composer = fakeComposer(async () => score);
    const library = fakeLibrary();
    const service = new SceneMusicService({ composer, library, worldRegion: "east-asia" });
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(composer.compose.mock.calls[0]![0].region).toBe("east-asia");
    expect(library.put).toHaveBeenCalledWith("east-asia:tense:2", score);
  });

  it("导演地区覆盖优先于世界锚", async () => {
    const composer = fakeComposer(async () => score);
    const library = fakeLibrary();
    const service = new SceneMusicService({ composer, library, worldRegion: "east-asia" });
    service.handleDirective(makeDirective({ mood: "tense", intensity: 2, region: "celtic" }));
    await flush();
    expect(composer.compose.mock.calls[0]![0].region).toBe("celtic");
    expect(library.put).toHaveBeenCalledWith("celtic:tense:2", score);
  });

  it("同场景同复用键去重；键变化才重新解析", async () => {
    const composer = fakeComposer(async () => score);
    const service = new SceneMusicService({ composer, library: fakeLibrary() });
    service.handleDirective(makeDirective(direction));
    await flush();
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(composer.compose).toHaveBeenCalledTimes(1);
    service.handleDirective(makeDirective({ mood: "warm", intensity: 1 }));
    await flush();
    expect(composer.compose).toHaveBeenCalledTimes(2);
  });

  it("note 变化不换复用键：谱库命中 → 零 token 广播同一首", async () => {
    const composer = fakeComposer(async () => score);
    const library = fakeLibrary({ "default:tense:2": otherScore });
    const service = new SceneMusicService({ composer, library });
    const events: SceneMusicScoreEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.handleDirective(makeDirective({ mood: "tense", intensity: 2, note: "第一次注记" }));
    await flush();
    service.handleDirective(
      makeDirective({ mood: "tense", intensity: 2, note: "第二次完全不同的注记" }, "scene_2"),
    );
    await flush();
    expect(composer.compose).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    expect(events[0]!.score).toBe(otherScore);
    expect(events[1]!.score).toBe(otherScore);
    expect(events[1]!.sceneId).toBe("scene_2");
    expect(library.put).not.toHaveBeenCalled();
  });

  it("跨场景谱库回放：新场景同键命中库内曲目（零 LLM）", async () => {
    const composer = fakeComposer(async () => score);
    const library = fakeLibrary();
    const service = new SceneMusicService({ composer, library });
    service.handleDirective(makeDirective(direction, "scene_1"));
    await flush();
    service.handleDirective(makeDirective(direction, "scene_2"));
    await flush();
    expect(composer.compose).toHaveBeenCalledTimes(1);
    expect(library.put).toHaveBeenCalledTimes(1);
  });

  it("同键并发 directive 合流为一次 LLM 调用", async () => {
    let resolveCompose: ((value: MusicScore | null) => void) | undefined;
    const composer = fakeComposer(
      () =>
        new Promise((resolve) => {
          resolveCompose = resolve;
        }),
    );
    const library = fakeLibrary();
    const service = new SceneMusicService({ composer, library });
    service.handleDirective(makeDirective(direction, "scene_1"));
    service.handleDirective(makeDirective(direction, "scene_2"));
    await flush(); // 谱库 miss 落定、compose 已启动（resolveCompose 就位）
    resolveCompose?.(score);
    await flush();
    expect(composer.compose).toHaveBeenCalledTimes(1);
    expect(library.put).toHaveBeenCalledTimes(1);
  });

  it("谱库落盘失败 → 告警但谱面仍广播（仅本会话生效）", async () => {
    const composer = fakeComposer(async () => score);
    const library = fakeLibrary();
    library.put.mockRejectedValue(new Error("disk full"));
    const warnings: string[] = [];
    const service = new SceneMusicService({
      composer,
      library,
      diagnostics: { info: () => undefined, warn: (_scope, message) => warnings.push(message) },
    });
    const listener = vi.fn();
    service.subscribe(listener);
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("落盘失败");
  });

  it("作曲返回 null → 只降级不广播", async () => {
    const composer = fakeComposer(async () => null);
    const service = new SceneMusicService({ composer, library: fakeLibrary() });
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
    const service = new SceneMusicService({ composer, library: fakeLibrary() });
    expect(() => service.handleDirective(makeDirective(direction))).not.toThrow();
    await flush();
  });
});
