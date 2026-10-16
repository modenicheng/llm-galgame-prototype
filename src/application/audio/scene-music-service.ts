/**
 * SceneMusicService — 动态音乐生成的编排层（三层契约的中间层）。
 *
 * 数据流：导演 SceneDirective.music（情绪/强度/注记）
 *   → 本服务去重后调用作曲端口（LLM 单次 JSON 调用产出符号谱）
 *   → musicCacheKey 指纹 → 广播给订阅者（runtime WS → 浏览器渲染）。
 *
 * 契约对齐 TTS 管线的可观测降级：作曲失败只告警、不抛——配乐永远滞后
 * 于演出（写手显式 @bgm 压过自动配乐；作曲未完成时沿用当前曲目）。
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

/** 谱面产物事件（WS 推送与重连回放的载荷）。 */
export interface SceneMusicScoreEvent {
  sceneId: string;
  cacheKey: string;
  score: MusicScore;
}

/** 指导的作曲指纹（同场景同指导不重复调 LLM）。 */
function directionSignature(direction: SceneMusicDirection): string {
  return JSON.stringify([direction.mood, direction.intensity, direction.note ?? ""]);
}

export class SceneMusicService {
  private readonly composer: SceneMusicComposerPort;
  private readonly diagnostics: DiagnosticSink;
  private readonly listeners = new Set<(event: SceneMusicScoreEvent) => void>();
  private readonly composedSignatures = new Map<string, string>();
  private latest: SceneMusicScoreEvent | undefined;

  constructor(opts: { composer: SceneMusicComposerPort; diagnostics?: DiagnosticSink }) {
    this.composer = opts.composer;
    this.diagnostics = opts.diagnostics ?? silentDiagnosticSink;
  }

  /** 导演指导完成回调（setDirectiveListener 接线；同步入口，内部 fire-and-forget）。 */
  handleDirective(directive: SceneDirective): void {
    const direction = directive.music;
    if (direction === undefined) return;
    const signature = directionSignature(direction);
    if (this.composedSignatures.get(directive.sceneId) === signature) return;
    this.composedSignatures.set(directive.sceneId, signature);
    void this.composer
      .compose({
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
        const event: SceneMusicScoreEvent = {
          sceneId: directive.sceneId,
          cacheKey: musicCacheKey(score),
          score,
        };
        this.latest = event;
        for (const listener of this.listeners) listener(event);
      })
      .catch((err: unknown) => {
        this.diagnostics.warn(
          "SceneMusicService",
          `场景 ${directive.sceneId} 作曲异常：${String(err)}`,
        );
      });
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
