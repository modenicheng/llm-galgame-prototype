import { describe, expect, it, vi } from "vitest";
import { BgmController } from "./bgm-controller.js";
import { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { PublicAssetManifest } from "./stage-types.js";

const manifest: PublicAssetManifest = {
  backgrounds: {},
  bgm: { mystery: { url: "/game-assets/audio/bgm/mystery.mp3" } },
  soundEffects: {},
  spriteSets: {},
};

function makeAudio() {
  const audio = {
    loop: false,
    preload: "",
    src: "",
    volume: 1,
    currentTime: 0,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
  };
  return audio;
}

describe("BgmController", () => {
  it("apply(id) 设置 src 并播放；相同 id 不重复设置", () => {
    const audio = makeAudio();
    const controller = new BgmController(new BrowserAssetResolver(manifest), () => audio as unknown as HTMLAudioElement);
    controller.apply("mystery");
    expect(audio.src).toContain("/game-assets/audio/bgm/mystery.mp3");
    expect(audio.play).toHaveBeenCalledTimes(1);
    controller.apply("mystery");
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("apply(undefined) 暂停并清空 src（bgm stop 语义）", () => {
    const audio = makeAudio();
    const controller = new BgmController(new BrowserAssetResolver(manifest), () => audio as unknown as HTMLAudioElement);
    controller.apply("mystery");
    controller.apply(undefined);
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
  });

  it("未知 id 保持静音不播放", () => {
    const audio = makeAudio();
    const controller = new BgmController(new BrowserAssetResolver(manifest), () => audio as unknown as HTMLAudioElement);
    controller.apply("nope");
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("setVolume/setMuted 反映到 audio.volume", () => {
    const audio = makeAudio();
    const controller = new BgmController(new BrowserAssetResolver(manifest), () => audio as unknown as HTMLAudioElement);
    controller.setVolume(0.4);
    expect(audio.volume).toBe(0.4);
    controller.setMuted(true);
    expect(audio.volume).toBe(0);
    controller.setMuted(false);
    expect(audio.volume).toBe(0.4);
  });

  it("unlock() 在 0 音量播放首曲后暂停（手势内解锁）", async () => {
    const audio = makeAudio();
    const controller = new BgmController(new BrowserAssetResolver(manifest), () => audio as unknown as HTMLAudioElement);
    controller.unlock();
    await Promise.resolve();
    expect(audio.play).toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();
  });
});
