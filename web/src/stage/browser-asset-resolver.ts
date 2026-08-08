import type { PublicAssetManifest } from "./stage-types.js";

/** 逻辑 id → 受控 URL 的纯映射（spec §6.1）。 */
export class BrowserAssetResolver {
  constructor(private readonly manifestData: PublicAssetManifest | null) {}

  get manifest(): PublicAssetManifest | null {
    return this.manifestData;
  }

  resolveBackground(id: string): string | undefined {
    return this.manifestData?.backgrounds[id]?.url;
  }

  resolveBgm(id: string): string | undefined {
    return this.manifestData?.bgm[id]?.url;
  }

  resolveSoundEffect(id: string): string | undefined {
    return this.manifestData?.soundEffects[id]?.url;
  }

  resolveSprite(spriteSet: string, variant: string): string | undefined {
    return this.manifestData?.spriteSets[spriteSet]?.variants[variant]?.url;
  }
}
