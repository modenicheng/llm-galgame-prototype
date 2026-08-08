import type { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { StageCueWire } from "./stage-types.js";

/** 消费瞬态 sound_effect cue：一次性 Audio 播放，不入 VisualState（spec §6.4）。 */
export class SoundEffectController {
  constructor(
    private readonly resolver: BrowserAssetResolver,
    private readonly createAudio: () => HTMLAudioElement = () => new Audio(),
  ) {}

  consume(cues: readonly StageCueWire[]): void {
    for (const cue of cues) {
      if (cue.type !== "sound_effect") continue;
      const url = this.resolver.resolveSoundEffect(cue.assetId);
      if (url === undefined) continue;
      const audio = this.createAudio();
      audio.src = url;
      void audio.play().catch(() => {});
    }
  }
}
