/**
 * SceneMusicService — 动态音乐生成的编排层（三层契约的中间层）。
 *
 * 数据流：导演 SceneDirective.music（情绪/强度/注记）
 *   → 复用键量化 (mood:intensity) 查 per-game 谱库（MusicLibraryStore）
 *   → 命中 = 零 token 直接广播；未命中 = 作曲端口（LLM 单次 JSON 调用）
 *     → 落盘谱库 → musicCacheKey 指纹 → 广播订阅者（runtime WS → 浏览器渲染）。
 *
 * 复用语义（token 上界 = 7 情绪 × 3 强度 = 21 首/世界，通常 4~8 首）：
 * note 只是首次作曲的编配提示，不进复用键——同世界同 (mood, intensity)
 * 恒用同一首（跨场景/跨周目/跨进程重启的 Leitmotif 一致性）。
 *
 * 契约对齐 TTS 管线的可观测降级：作曲/落盘失败只告警、不抛——配乐永远
 * 滞后于演出（写手显式 @bgm 压过自动配乐；作曲未完成时沿用当前曲目）。
 */
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { SceneDirective } from "../director/director-service.js";
import type { MusicScore, SceneMusicDirection } from "../../shared/music/score.js";
import { musicCacheKey } from "./music-cache-key.js";

export interface SceneMusicComposeRequest {
  sceneId: string;
  sceneGoal?: string;
  direction: SceneMusicDirection;
}

/** 作曲端口（LLM 适配器实现；测试注入 fake）。 */
export interface SceneMusicComposerPort {
  compose(request: SceneMusicComposeRequest): Promise<MusicScore | null>;
}

/** 谱库端口（MusicLibraryStore 实现；测试注入 fake）。 */
export interface SceneMusicLibraryPort {
  /** 复用键 → 已作曲谱面；未命中 = undefined。 */
  get(key: string): Promise<MusicScore | undefined>;
  /** 落盘一条谱面（键已存在 = no-op：首作即定稿）。 */
  put(key: string, score: MusicScore): Promise<void>;
}

/** 谱面产物事件（WS 推送与重连回放的载荷）。 */
export interface SceneMusicScoreEvent {
  sceneId: string;
  cacheKey: string;
  score: MusicScore;
}

/** 复用键：note 不参与——编配提示，非可听身份。 */
export function musicLibraryKey(direction: SceneMusicDirection): string {
  return `${direction.mood}:${direction.intensity}`;
}

export class SceneMusicService {
  private readonly composer: SceneMusicComposerPort;
  private readonly library: SceneMusicLibraryPort | undefined;
  private readonly diagnostics: DiagnosticSink;
  private readonly listeners = new Set<(event: SceneMusicScoreEvent) => void>();
  /** sceneId → 已服务的复用键（同场景同键不重复广播）。 */
  private readonly servedKeys = new Map<string, string>();
  /** 复用键 → in-flight（作曲 + 落盘全程占位，同键并发只调一次 LLM）。 */
  private readonly composing = new Map<string, Promise<MusicScore | null>>();
  private latest: SceneMusicScoreEvent | undefined;

  constructor(opts: {
    composer: SceneMusicComposerPort;
    library?: SceneMusicLibraryPort;
    diagnostics?: DiagnosticSink;
  }) {
    this.composer = opts.composer;
    this.library = opts.library;
    this.diagnostics = opts.diagnostics ?? silentDiagnosticSink;
  }

  /** 导演指导完成回调（setDirectiveListener 接线；同步入口，内部 fire-and-forget）。 */
  handleDirective(directive: SceneDirective): void {
    const direction = directive.music;
    if (direction === undefined) return;
    const key = musicLibraryKey(direction);
    if (this.servedKeys.get(directive.sceneId) === key) return;
    this.servedKeys.set(directive.sceneId, key);
    void this.resolveScore(key, {
      sceneId: directive.sceneId,
      ...(directive.sceneGoal !== undefined ? { sceneGoal: directive.sceneGoal } : {}),
      direction,
    })
      .then((score) => {
        if (score === null) {
          this.diagnostics.warn(
            "SceneMusicService",
            `场景 ${directive.sceneId} 作曲失败（模型两次输出均未过契约），沿用当前曲目`,
          );
          return;
        }
        this.publish(directive.sceneId, score);
      })
      .catch((err: unknown) => {
        this.diagnostics.warn(
          "SceneMusicService",
          `场景 ${directive.sceneId} 作曲异常：${String(err)}`,
        );
      });
  }

  /** 复用键 → 谱面：谱库命中零 token；未命中作曲一次并落盘（同键合流）。 */
  private async resolveScore(
    key: string,
    request: SceneMusicComposeRequest,
  ): Promise<MusicScore | null> {
    const cached = await this.library?.get(key);
    if (cached !== undefined) return cached;
    const inFlight = this.composing.get(key);
    if (inFlight !== undefined) return inFlight;
    const task = (async () => {
      try {
        const score = await this.composer.compose(request);
        if (score !== null) {
          try {
            await this.library?.put(key, score);
          } catch (err: unknown) {
            this.diagnostics.warn(
              "SceneMusicService",
              `复用键 ${key} 谱库落盘失败（仅本会话生效）：${String(err)}`,
            );
          }
        }
        return score;
      } finally {
        this.composing.delete(key);
      }
    })();
    this.composing.set(key, task);
    return task;
  }

  private publish(sceneId: string, score: MusicScore): void {
    const event: SceneMusicScoreEvent = {
      sceneId,
      cacheKey: musicCacheKey(score),
      score,
    };
    this.latest = event;
    for (const listener of this.listeners) listener(event);
  }

  /** 谱面产物订阅（runtime WS 桥接）。 */
  subscribe(listener: (event: SceneMusicScoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 最近一次谱面（WS 重连回放，与 descriptor 目录回放同模式）。 */
  latestScore(): SceneMusicScoreEvent | undefined {
    return this.latest;
  }
}
