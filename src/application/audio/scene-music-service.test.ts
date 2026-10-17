import { describe, expect, it, vi } from "vitest";
import type { SceneDirective } from "../director/director-service.js";
import type { MusicScore, SceneMusicDirection } from "../../shared/music/score.js";
import type { ComposerDecision, MusicThemeMeta } from "../../shared/music/theme.js";
import { musicCacheKey } from "./music-cache-key.js";
import {
  SceneMusicService,
  type ComposerSessionStorePort,
  type MusicThemeStorePort,
  type SceneMusicComposerPort,
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

const score: MusicScore = {
  version: 1,
  bpm: 92,
  key: 9,
  mode: "minor",
  bars: 16,
  tracks: [
    {
      instrument: "piano",
      gain: 0.8,
      notes: [
        { beat: 0, dur: 1, midi: 69, vel: 90 },
        { beat: 2, dur: 1, midi: 72, vel: 90 },
        { beat: 4, dur: 1, midi: 71, vel: 90 },
        { beat: 6, dur: 1, midi: 67, vel: 90 },
      ],
    },
  ],
};

const themeMeta: MusicThemeMeta = {
  id: "fortress-echo",
  title: "堡垒回响",
  concept: "地下堡垒——压抑的机械回响",
  motifHint: "69,72,71,67",
};

function fakeComposer(
  behavior: (
    input: Parameters<SceneMusicComposerPort["decide"]>[0],
  ) => Promise<ComposerDecision | null>,
): SceneMusicComposerPort & { decide: ReturnType<typeof vi.fn> } {
  return { decide: vi.fn(behavior) };
}

function fakeThemes(initial: {
  themes?: MusicThemeMeta[];
  bindings?: Record<string, string>;
  scores?: Record<string, MusicScore>;
} = {}): MusicThemeStorePort & {
  putScore: ReturnType<typeof vi.fn>;
  addTheme: ReturnType<typeof vi.fn>;
  bindScene: ReturnType<typeof vi.fn>;
  getScore: ReturnType<typeof vi.fn>;
} {
  const themes = new Map((initial.themes ?? []).map((t) => [t.id, t]));
  const bindings = new Map(Object.entries(initial.bindings ?? {}));
  const scores = new Map(Object.entries(initial.scores ?? {}));
  return {
    listThemes: vi.fn(async () => [...themes.values()]),
    getBinding: vi.fn(async (sceneId: string) => bindings.get(sceneId)),
    addTheme: vi.fn(async (meta: MusicThemeMeta, bind?: { sceneId: string }) => {
      if (!themes.has(meta.id)) themes.set(meta.id, meta);
      if (bind !== undefined) bindings.set(bind.sceneId, meta.id);
    }),
    bindScene: vi.fn(async (sceneId: string, themeId: string) => {
      bindings.set(sceneId, themeId);
    }),
    getScore: vi.fn(async (themeId: string) => scores.get(themeId)),
    putScore: vi.fn(async (themeId: string, s: MusicScore) => {
      if (!scores.has(themeId)) scores.set(themeId, s);
    }),
  };
}

function fakeSession(): ComposerSessionStorePort & {
  append: ReturnType<typeof vi.fn>;
  turns: { role: "user" | "assistant"; content: string }[];
} {
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  return {
    turns,
    append: vi.fn(async (turn: { role: "user" | "assistant"; content: string }) => {
      turns.push(turn);
    }),
    readRecent: vi.fn(async () => [...turns]),
  };
}

async function flush(times = 2): Promise<void> {
  // 决策 + 落盘 + publish 全链微任务，按链长跳排干几个宏任务。
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("SceneMusicService（V2 主题决策流）", () => {
  it("无音乐指导的 directive 不触发决策", () => {
    const composer = fakeComposer(async () => null);
    new SceneMusicService({
      composer,
      themes: fakeThemes(),
      session: fakeSession(),
    }).handleDirective(makeDirective());
    expect(composer.decide).not.toHaveBeenCalled();
  });

  it("绑定命中 → 零 LLM 直接发布同主题谱面（日夜重访）", async () => {
    const composer = fakeComposer(async () => null);
    const themes = fakeThemes({
      themes: [themeMeta],
      bindings: { scene_1: "fortress-echo" },
      scores: { "fortress-echo": score },
    });
    const session = fakeSession();
    const service = new SceneMusicService({ composer, themes, session });
    const events: SceneMusicScoreEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.handleDirective(makeDirective({ mood: "warm", intensity: 1 }));
    await flush();
    expect(composer.decide).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sceneId: "scene_1", themeId: "fortress-echo" });
    expect(events[0]!.score).toBe(score);
    // 会话不追加（零 token 零留痕）。
    expect(session.append).not.toHaveBeenCalled();
  });

  it("reuse 决策 → 绑定落盘 + 会话留痕 + 发布", async () => {
    const composer = fakeComposer(async () => ({
      action: "reuse",
      themeId: "fortress-echo",
      reason: "同一堡垒区域，日夜共用",
    }));
    const themes = fakeThemes({
      themes: [themeMeta],
      scores: { "fortress-echo": score },
    });
    const session = fakeSession();
    const service = new SceneMusicService({ composer, themes, session });
    const events: SceneMusicScoreEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(themes.bindScene).toHaveBeenCalledWith("scene_1", "fortress-echo");
    expect(events[0]!.themeId).toBe("fortress-echo");
    // 决策输入携带目录（含统计）与空会话。
    const input = composer.decide.mock.calls[0]![0];
    expect(input.catalog).toHaveLength(1);
    expect(input.catalog[0]!.stats.noteCount).toBe(4);
    expect(input.sessionTurns).toEqual([]);
    // 会话两轮：user brief + assistant 决策摘要（无完整谱面）。
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0]!.role).toBe("user");
    expect(session.turns[1]!.content).not.toContain('"tracks"');
  });

  it("compose 决策 → 谱面/主题/绑定落盘 + motifHint 确定性提取 + 发布", async () => {
    const composer = fakeComposer(async () => ({
      action: "compose",
      theme: { id: "market-dawn", title: "晨市", concept: "港口晨市——市井喧嚣渐醒" },
      score,
      reason: "新区域",
    }));
    const themes = fakeThemes();
    const session = fakeSession();
    const service = new SceneMusicService({ composer, themes, session });
    const events: SceneMusicScoreEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.handleDirective(
      makeDirective({ mood: "daily", intensity: 1, note: "晨光市集" }),
    );
    await flush();
    expect(themes.putScore).toHaveBeenCalledWith("market-dawn", score);
    expect(themes.addTheme).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "market-dawn",
        motifHint: "69,72,71,67",
      }),
      { sceneId: "scene_1" },
    );
    expect(events[0]).toMatchObject({ sceneId: "scene_1", themeId: "market-dawn" });
    expect(events[0]!.cacheKey).toBe(musicCacheKey(score));
    expect(service.latestScore()).toEqual(events[0]);
  });

  it("compose 主题 id 与目录冲突 → 追加确定性短 hash 重命名（不丢作曲）", async () => {
    const composer = fakeComposer(async () => ({
      action: "compose",
      theme: { id: "fortress-echo", title: "同名", concept: "另一个" },
      score,
      reason: "无视目录",
    }));
    const themes = fakeThemes({ themes: [themeMeta], scores: { "fortress-echo": score } });
    const service = new SceneMusicService({ composer, themes, session: fakeSession() });
    const events: SceneMusicScoreEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.handleDirective(makeDirective(direction));
    await flush();
    const publishedId = events[0]!.themeId;
    expect(publishedId).toMatch(/^fortress-echo-[0-9a-f]{4}$/);
    expect(themes.putScore).toHaveBeenCalledWith(publishedId, score);
    expect(themes.addTheme).toHaveBeenCalledWith(
      expect.objectContaining({ id: publishedId }),
      { sceneId: "scene_1" },
    );
  });

  it("reuse 指向不存在主题 → 告警不发布不绑定", async () => {
    const composer = fakeComposer(async () => ({
      action: "reuse",
      themeId: "ghost",
      reason: "幻觉",
    }));
    const themes = fakeThemes();
    const service = new SceneMusicService({ composer, themes, session: fakeSession() });
    const events: SceneMusicScoreEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(events).toHaveLength(0);
    expect(themes.bindScene).not.toHaveBeenCalled();
  });

  it("决策双败 → 告警沿用当前曲目；下次同场景再到达会重试", async () => {
    const composer = fakeComposer(async () => null);
    const service = new SceneMusicService({
      composer,
      themes: fakeThemes(),
      session: fakeSession(),
    });
    const events: SceneMusicScoreEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(events).toHaveLength(0);
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(composer.decide).toHaveBeenCalledTimes(2);
  });

  it("同 sceneId 并发合流：in-flight 期间重复 directive 只调一次决策", async () => {
    let release: (() => void) | undefined;
    const composer = fakeComposer(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              action: "compose",
              theme: { id: "t", title: "T", concept: "C" },
              score,
              reason: "r",
            });
        }),
    );
    const service = new SceneMusicService({
      composer,
      themes: fakeThemes(),
      session: fakeSession(),
    });
    service.handleDirective(makeDirective(direction));
    service.handleDirective(makeDirective(direction));
    service.handleDirective(makeDirective(direction));
    // 微任务排干：decide 已发起（挂起等待 release），合流使后两次不再发。
    await flush(1);
    expect(composer.decide).toHaveBeenCalledTimes(1);
    release!();
    await flush();
    // 成功后 servedScenes 生效：再到达同场景不重复。
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(composer.decide).toHaveBeenCalledTimes(1);
  });

  it("绑定命中但谱面缺失 → 告警降级走决策（不因孤儿绑定哑火）", async () => {
    const composer = fakeComposer(async () => ({
      action: "compose",
      theme: { id: "rebuilt", title: "重建", concept: "c" },
      score,
      reason: "孤儿绑定",
    }));
    const themes = fakeThemes({
      themes: [themeMeta],
      bindings: { scene_1: "fortress-echo" },
      // scores 故意缺 fortress-echo。
    });
    const service = new SceneMusicService({ composer, themes, session: fakeSession() });
    const events: SceneMusicScoreEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(composer.decide).toHaveBeenCalledTimes(1);
    expect(events[0]!.themeId).toBe("rebuilt");
  });

  it("落盘失败仅告警：谱面仍本会话生效（发布不阻塞）", async () => {
    const composer = fakeComposer(async () => ({
      action: "compose",
      theme: { id: "x", title: "X", concept: "c" },
      score,
      reason: "r",
    }));
    const themes = fakeThemes();
    themes.putScore = vi.fn(async () => {
      throw new Error("disk full");
    });
    const warns: string[] = [];
    const service = new SceneMusicService({
      composer,
      themes,
      session: fakeSession(),
      diagnostics: {
        info: () => {},
        warn: (_scope: string, message: string) => {
          warns.push(message);
        },
      },
    });
    const events: SceneMusicScoreEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.handleDirective(makeDirective(direction));
    await flush();
    expect(events).toHaveLength(1);
    expect(warns.some((m) => m.includes("disk full"))).toBe(true);
  });
});
