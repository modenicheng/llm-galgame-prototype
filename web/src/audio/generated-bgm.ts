/**
 * GeneratedBgm — 动态音乐生成的浏览器侧编排（三层契约的渲染消费端）。
 *
 * 输入：WS music.score 消息（Node 作曲产物）。动作：渲染（确定性，同
 * cacheKey 同音频）→ WAV blob URL → BgmController.applyGenerated（最新
 * 意图胜）。同 key 重放（重连回放）为幂等 no-op；渲染串行化，排队/渲染
 * 期间被更新 key 取代的旧谱直接丢弃；旧 blob URL 替换时 revoke（生成曲
 * 内存峰值恒为单曲）。失败只 console 告警——配乐永远不阻塞演出。
 */
import type { BgmController } from "../stage/bgm-controller.js";
import type { MusicScore } from "@shared/music/score.js";
import { audioBufferToWavBlob, type MusicRenderer } from "./music-renderer.js";

/** WS music.score 的载荷（ServerMessage music.score 分支的投影）。 */
export interface MusicScoreMessage {
  sceneId: string;
  /** 主题制配乐（V2）：谱面所属主题 id（展示/诊断用；渲染幂等仍按 cacheKey）。 */
  themeId: string;
  cacheKey: string;
  score: MusicScore;
}

export class GeneratedBgm {
  private current: { cacheKey: string; url: string } | undefined;
  /** 待渲染（含排队中）的最新 key——旧谱被取代时跳过应用。 */
  private latestKey: string | undefined;
  private rendering: Promise<void> = Promise.resolve();

  constructor(
    private readonly bgm: BgmController,
    private readonly renderer: MusicRenderer,
    private readonly createObjectUrl: (blob: Blob) => string = (blob) =>
      URL.createObjectURL(blob),
    private readonly revokeObjectUrl: (url: string) => void = (url) =>
      URL.revokeObjectURL(url),
  ) {}

  /** WS 消息入口（fire-and-forget；内部串行渲染）。 */
  handleScore(message: MusicScoreMessage): void {
    this.latestKey = message.cacheKey;
    this.rendering = this.rendering
      .then(async () => {
        // 排队期间已被更新 key 取代（场景快速切换）→ 直接丢弃。
        if (this.latestKey !== message.cacheKey) return;
        // 同 key 重放（重连回放）：当前已在播（或已被写手压回但曲未变）→ 幂等。
        if (this.current?.cacheKey === message.cacheKey) return;
        const buffer = await this.renderer.render(message.score);
        if (this.latestKey !== message.cacheKey) return; // 渲染期间被取代
        const url = this.createObjectUrl(audioBufferToWavBlob(buffer));
        if (this.current !== undefined) this.revokeObjectUrl(this.current.url);
        this.current = { cacheKey: message.cacheKey, url };
        this.bgm.applyGenerated(url);
      })
      .catch((error: unknown) => {
        console.warn(`[music] 生成曲渲染失败，沿用当前曲目：${String(error)}`);
      });
  }
}
