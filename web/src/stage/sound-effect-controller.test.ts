import { describe, expect, it, vi } from "vitest";
import { SoundEffectController } from "./sound-effect-controller.js";
import { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { PublicAssetManifest, StageCueWire } from "./stage-types.js";

const manifest: PublicAssetManifest = {
  backgrounds: {},
  bgm: {},
  soundEffects: { beep: { url: "/game-assets/audio/se/beep.ogg" } },
  spriteSets: {},
};

describe("SoundEffectController", () => {
  it("只播放 sound_effect cue，且每 cue 一个一次性 Audio", () => {
    const audios: Array<{ src: string; play: ReturnType<typeof vi.fn> }> = [];
    const controller = new SoundEffectController(new BrowserAssetResolver(manifest), () => {
      const audio = { src: "", play: vi.fn().mockResolvedValue(undefined) };
      audios.push(audio);
      return audio as unknown as HTMLAudioElement;
    });
    const cues: StageCueWire[] = [
      { type: "sound_effect", assetId: "beep" },
      { type: "background", assetId: "basement" },
      { type: "sound_effect", assetId: "beep" },
    ];
    controller.consume(cues);
    expect(audios).toHaveLength(2);
    expect(audios[0]?.play).toHaveBeenCalled();
    expect(audios[0]?.src).toContain("/game-assets/audio/se/beep.ogg");
  });

  it("未知音效 id 静默跳过", () => {
    const play = vi.fn();
    const controller = new SoundEffectController(new BrowserAssetResolver(manifest), () => ({ src: "", play } as unknown as HTMLAudioElement));
    controller.consume([{ type: "sound_effect", assetId: "nope" }]);
    expect(play).not.toHaveBeenCalled();
  });
});
