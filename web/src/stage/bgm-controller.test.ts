import { describe, expect, it, vi } from "vitest";
import { BgmController, type BgmClock } from "./bgm-controller.js";
import { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { PublicAssetManifest } from "./stage-types.js";

/** 最小 <audio> 替身：事件可手动派发，play/pause 同步翻转 paused。 */
class FakeAudio {
  loop = false;
  preload = "";
  src = "";
  volume = 1;
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  private readonly listeners = new Map<string, Array<() => void>>();
  readonly play = vi.fn(async () => {
    this.paused = false;
  });
  readonly pause = vi.fn(() => {
    this.paused = true;
  });
  readonly removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });

  addEventListener(type: string, callback: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(callback);
    this.listeners.set(type, list);
  }

  emit(type: string): void {
    for (const callback of this.listeners.get(type) ?? []) callback();
  }
}

/** 手动时钟：测试里用 advance(ms) 逐帧驱动渐变与裁切回卷。 */
function makeClock() {
  let now = 0;
  let frames: Array<() => void> = [];
  const clock: BgmClock = {
    now: () => now,
    scheduleFrame: (callback) => frames.push(callback),
  };
  return {
    clock,
    async advance(ms: number) {
      now += ms;
      const due = frames;
      frames = [];
      for (const callback of due) callback();
      await Promise.resolve();
    },
  };
}

function makeController(manifest: PublicAssetManifest, clock: BgmClock) {
  const audio = new FakeAudio();
  const controller = new BgmController(
    new BrowserAssetResolver(manifest),
    () => audio as unknown as HTMLAudioElement,
    clock,
  );
  return { audio, controller };
}

function manifestWith(bgm: PublicAssetManifest["bgm"]): PublicAssetManifest {
  return { backgrounds: {}, bgm, soundEffects: {}, spriteSets: {} };
}

const plainManifest = manifestWith({
  mystery: { url: "/game-assets/audio/bgm/mystery.mp3" },
});

describe("BgmController（基础行为，无 playback 配置）", () => {
  it("apply(id) 设置 src 并播放；相同 id 不重复设置", async () => {
    const { clock, advance } = makeClock();
    const { audio, controller } = makeController(plainManifest, clock);
    controller.apply("mystery");
    expect(audio.src).toContain("/game-assets/audio/bgm/mystery.mp3");
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.loop).toBe(true);
    controller.apply("mystery");
    expect(audio.play).toHaveBeenCalledTimes(1);
    await advance(0);
  });

  it("apply(undefined) 暂停并清空 src（bgm stop 语义）", async () => {
    const { clock, advance } = makeClock();
    const { audio, controller } = makeController(plainManifest, clock);
    controller.apply("mystery");
    controller.apply(undefined);
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    await advance(0);
  });

  it("未知 id 保持静音不播放", () => {
    const { clock } = makeClock();
    const { audio, controller } = makeController(plainManifest, clock);
    controller.apply("nope");
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("setVolume/setMuted 反映到 audio.volume", () => {
    const { clock } = makeClock();
    const { audio, controller } = makeController(plainManifest, clock);
    controller.setVolume(0.4);
    expect(audio.volume).toBe(0.4);
    controller.setMuted(true);
    expect(audio.volume).toBe(0);
    controller.setMuted(false);
    expect(audio.volume).toBe(0.4);
  });

  it("unlock() 在 0 音量播放首曲后暂停（手势内解锁）", async () => {
    const { clock } = makeClock();
    const { audio, controller } = makeController(plainManifest, clock);
    controller.unlock();
    await Promise.resolve();
    expect(audio.play).toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();
  });
});

describe("BgmController（裁切窗口）", () => {
  it("起播 seek 到 start，原生 loop 关闭", async () => {
    const { clock, advance } = makeClock();
    const { audio, controller } = makeController(
      manifestWith({ m: { url: "/x/m.mp3", playback: { start: 10, end: 20 } } }),
      clock,
    );
    controller.apply("m");
    expect(audio.loop).toBe(false);
    audio.duration = 100;
    audio.emit("loadedmetadata");
    expect(audio.currentTime).toBe(10);
    expect(audio.play).toHaveBeenCalledTimes(1);
    await advance(0);
  });

  it("到达 end 回卷 start：timeupdate 与帧回调双保险", async () => {
    const { clock, advance } = makeClock();
    const { audio, controller } = makeController(
      manifestWith({ m: { url: "/x/m.mp3", playback: { start: 10, end: 20 } } }),
      clock,
    );
    controller.apply("m");
    audio.duration = 100;
    audio.emit("loadedmetadata");
    await advance(0);

    audio.currentTime = 20.4;
    audio.emit("timeupdate");
    expect(audio.currentTime).toBe(10);

    audio.currentTime = 20.4;
    await advance(16);
    expect(audio.currentTime).toBe(10);
  });

  it("只配 start：播到文件尾，ended 时回卷 start 续播", async () => {
    const { clock, advance } = makeClock();
    const { audio, controller } = makeController(
      manifestWith({ m: { url: "/x/m.mp3", playback: { start: 5 } } }),
      clock,
    );
    controller.apply("m");
    expect(audio.loop).toBe(false);
    audio.duration = 30;
    audio.emit("loadedmetadata");
    expect(audio.currentTime).toBe(5);

    audio.currentTime = 30;
    audio.emit("ended");
    expect(audio.currentTime).toBe(5);
    expect(audio.play).toHaveBeenCalledTimes(2);
    await advance(0);
  });

  it("窗口超出文件时长：end 钳制到 duration；start 越过文件尾则退回整曲循环", async () => {
    const { clock, advance } = makeClock();
    const { audio, controller } = makeController(
      manifestWith({
        clamp: { url: "/x/clamp.mp3", playback: { start: 10, end: 200 } },
        broken: { url: "/x/broken.mp3", playback: { start: 150, end: 200 } },
      }),
      clock,
    );
    controller.apply("clamp");
    audio.duration = 100;
    audio.emit("loadedmetadata");
    audio.currentTime = 100;
    await advance(16);
    expect(audio.currentTime).toBe(10); // end 已钳到 100，触底回卷

    controller.apply("broken");
    audio.currentTime = 0; // 浏览器换 src 会把播放位置归零，替身同步该行为
    audio.duration = 100;
    audio.emit("loadedmetadata");
    expect(audio.loop).toBe(true); // 100-150 < 最小窗口：放弃裁切
    expect(audio.currentTime).toBe(0);
    await advance(0);
  });
});

describe("BgmController（淡入淡出）", () => {
  it("fade_in：起播 0 音量线性爬升到目标", async () => {
    const { clock, advance } = makeClock();
    const { audio, controller } = makeController(
      manifestWith({ m: { url: "/x/m.mp3", playback: { fadeIn: 2 } } }),
      clock,
    );
    controller.setVolume(0.5);
    controller.apply("m");
    expect(audio.volume).toBe(0);
    await advance(1000);
    expect(audio.volume).toBeCloseTo(0.25);
    await advance(1000);
    expect(audio.volume).toBeCloseTo(0.5);
  });

  it("fade_out：停止先淡出，结束后才暂停清空", async () => {
    const { clock, advance } = makeClock();
    const { audio, controller } = makeController(
      manifestWith({ m: { url: "/x/m.mp3", playback: { fadeOut: 1 } } }),
      clock,
    );
    controller.apply("m");
    controller.apply(undefined);
    expect(audio.pause).not.toHaveBeenCalled();
    await advance(500);
    expect(audio.volume).toBeCloseTo(0.5);
    expect(audio.pause).not.toHaveBeenCalled();
    await advance(500);
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
  });

  it("切歌：旧曲淡出完成后起新曲淡入", async () => {
    const { clock, advance } = makeClock();
    const { audio, controller } = makeController(
      manifestWith({
        a: { url: "/x/a.mp3", playback: { fadeOut: 1 } },
        b: { url: "/x/b.mp3", playback: { fadeIn: 1 } },
      }),
      clock,
    );
    controller.apply("a");
    controller.apply("b");
    expect(audio.src).toContain("/x/a.mp3"); // 旧曲淡出期间继续发声
    await advance(1000);
    expect(audio.src).toContain("/x/b.mp3");
    expect(audio.volume).toBe(0); // 新曲淡入起点
    await advance(1000);
    expect(audio.volume).toBe(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("淡入途中调整音量：新目标立即生效，渐变继续推进", async () => {
    const { clock, advance } = makeClock();
    const { audio, controller } = makeController(
      manifestWith({ m: { url: "/x/m.mp3", playback: { fadeIn: 2 } } }),
      clock,
    );
    controller.setVolume(0.4);
    controller.apply("m");
    await advance(1000);
    expect(audio.volume).toBeCloseTo(0.2);
    controller.setVolume(1);
    expect(audio.volume).toBeCloseTo(0.5);
    await advance(1000);
    expect(audio.volume).toBeCloseTo(1);
  });

  it("淡出途中再切歌：沿用进行中的淡出，只替换接续动作", async () => {
    const { clock, advance } = makeClock();
    const { audio, controller } = makeController(
      manifestWith({
        a: { url: "/x/a.mp3", playback: { fadeOut: 2 } },
        b: { url: "/x/b.mp3" },
        c: { url: "/x/c.mp3" },
      }),
      clock,
    );
    controller.apply("a");
    controller.apply("b"); // 排队：淡出完起 b
    await advance(500);
    controller.apply("c"); // 改主意：淡出完应起 c 而不是 b
    await advance(1500);
    expect(audio.src).toContain("/x/c.mp3");
    expect(audio.volume).toBe(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
});
