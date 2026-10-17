/**
 * SceneMusicService — 主题制配乐的编排层（V2 重写，三层契约的中间层）。
 *
 * 决策流：
 *   导演 SceneDirective.music（mood/intensity/note）
 *   1) bindings[sceneId] 已绑定主题 → 直接发布该主题谱面，零 LLM
 *      （覆盖日夜重访/重启续玩；谱面文件缺失 = 告警解绑走决策）
 *   2) 未绑定 → 组装 brief 调作曲家 agent（第四 agent，持久会话）：
 *      输入 = brief + 全量主题目录（含 motifHint 与谱面统计）+ 最近会话轮次
 *      输出 = reuse{themeId} | compose{theme, score}
 *   3) 持久化（主题目录 + 谱面 + sceneId 绑定 + 追加会话轮）→ publish
 *
 * 复用决策权在作曲家 agent——目录与会话在作曲家侧，导演 prompt 不膨胀；
 * 一局主题数目标 5~15（专辑感）。目录为空时作曲家必 compose。
 *
 * 契约对齐 TTS 管线的可观测降级：决策/落盘失败只告警、不抛——配乐永远
 * 滞后于演出（写手显式 @bgm 压过自动配乐；作曲未完成时沿用当前曲目）。
 *
 * 注意：场景音乐一经决策（绑定落定）不再随导演后续修订变化——主题是
 * 场景的音乐身份，而非情绪档位的即时快照（与 V1「键变即重解析」不同）。
 */
import {
  COMPOSER_SESSION_WINDOW_TURNS,
  extractMotifHint,
  themeScoreStats,
  type ComposerDecision,
  type ComposerSessionTurn,
  type MusicThemeMeta,
  type SceneMusicBrief,
  type ThemeCatalogEntry,
} from "../../shared/music/theme.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import { silentDiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { SceneDirective } from "../director/director-service.js";
import { musicCacheKey } from "./music-cache-key.js";
import type { MusicScore } from "../../shared/music/score.js";

/** 主题目录端口（MusicThemeStore 实现；测试注入 fake）。 */
export interface MusicThemeStorePort {
  listThemes(): Promise<MusicThemeMeta[]>;
  getBinding(sceneId: string): Promise<string | undefined>;
  addTheme(meta: MusicThemeMeta, bind?: { sceneId: string }): Promise<void>;
  bindScene(sceneId: string, themeId: string): Promise<void>;
  getScore(themeId: string): Promise<MusicScore | undefined>;
  putScore(themeId: string, score: MusicScore): Promise<void>;
}

/** 作曲家会话端口（ComposerSessionStore 实现；测试注入 fake）。 */
export interface ComposerSessionStorePort {
  append(turn: ComposerSessionTurn): Promise<void>;
  readRecent(maxTurns: number): Promise<ComposerSessionTurn[]>;
}

/** 作曲家决策输入（适配器签名；测试注入 fake）。 */
export interface SceneMusicComposerDecisionInput {
  brief: SceneMusicBrief;
  catalog: ThemeCatalogEntry[];
  sessionTurns: ComposerSessionTurn[];
}

/** 作曲家端口（LLM 适配器实现；测试注入 fake）。 */
export interface SceneMusicComposerPort {
  decide(input: SceneMusicComposerDecisionInput): Promise<ComposerDecision | null>;
}

/** 谱面产物事件（WS 推送与重连回放的载荷）。 */
export interface SceneMusicScoreEvent {
  sceneId: string;
  themeId: string;
  cacheKey: string;
  score: MusicScore;
}

export class SceneMusicService {
  private readonly composer: SceneMusicComposerPort;
  private readonly themes: MusicThemeStorePort;
  private readonly session: ComposerSessionStorePort;
  private readonly diagnostics: DiagnosticSink;
  private readonly listeners = new Set<(event: SceneMusicScoreEvent) => void>();
  /** 已成功服务的 sceneId（会话内不重复广播；重启后由 bindings 兜底）。 */
  private readonly servedScenes = new Set<string>();
  /** sceneId → in-flight 决策全程占位（同场景并发只调一次 LLM）。 */
  private readonly deciding = new Map<string, Promise<void>>();
  private latest: SceneMusicScoreEvent | undefined;

  constructor(opts: {
    composer: SceneMusicComposerPort;
    themes: MusicThemeStorePort;
    session: ComposerSessionStorePort;
    diagnostics?: DiagnosticSink;
  }) {
    this.composer = opts.composer;
    this.themes = opts.themes;
    this.session = opts.session;
    this.diagnostics = opts.diagnostics ?? silentDiagnosticSink;
  }

  /** 导演指导完成回调（setDirectiveListener 接线；同步入口，内部 fire-and-forget）。 */
  handleDirective(directive: SceneDirective): void {
    const direction = directive.music;
    if (direction === undefined) return;
    const sceneId = directive.sceneId;
    if (this.servedScenes.has(sceneId)) return;
    const inFlight = this.deciding.get(sceneId);
    if (inFlight !== undefined) return;
    const brief: SceneMusicBrief = {
      sceneId,
      ...(directive.sceneGoal !== undefined ? { sceneGoal: directive.sceneGoal } : {}),
      mood: direction.mood,
      intensity: direction.intensity,
      ...(direction.note !== undefined ? { note: direction.note } : {}),
    };
    const task = (async () => {
      try {
        await this.serve(sceneId, brief);
      } catch (err: unknown) {
        this.diagnostics.warn(
          "SceneMusicService",
          `场景 ${sceneId} 配乐解析异常：${String(err)}`,
        );
      } finally {
        this.deciding.delete(sceneId);
      }
    })();
    this.deciding.set(sceneId, task);
  }

  private async serve(sceneId: string, brief: SceneMusicBrief): Promise<void> {
    // 1) 绑定命中 = 零 LLM（日夜重访/跨周目/跨进程重启同主题）。
    const binding = await this.themes.getBinding(sceneId);
    if (binding !== undefined) {
      const bound = await this.loadThemeScore(binding);
      if (bound !== undefined) {
        this.servedScenes.add(sceneId);
        this.publish(sceneId, binding, bound);
        return;
      }
      this.diagnostics.warn(
        "SceneMusicService",
        `场景 ${sceneId} 绑定主题 ${binding} 的谱面缺失/损坏，走作曲家决策重建`,
      );
    }

    // 2) 作曲家决策。
    const catalog = await this.buildCatalog();
    const sessionTurns = await this.session.readRecent(COMPOSER_SESSION_WINDOW_TURNS);
    const decision = await this.composer.decide({ brief, catalog, sessionTurns });
    if (decision === null) {
      this.diagnostics.warn(
        "SceneMusicService",
        `场景 ${sceneId} 作曲家决策失败（两次输出均未过契约），沿用当前曲目`,
      );
      return;
    }

    if (decision.action === "reuse") {
      const score = await this.loadThemeScore(decision.themeId);
      if (score === undefined) {
        this.diagnostics.warn(
          "SceneMusicService",
          `场景 ${sceneId} reuse 决策指向主题 ${decision.themeId}，但谱面缺失/损坏，不发布`,
        );
        return;
      }
      try {
        await this.themes.bindScene(sceneId, decision.themeId);
      } catch (err: unknown) {
        this.diagnostics.warn(
          "SceneMusicService",
          `场景 ${sceneId} 绑定落盘失败（仅本会话生效）：${String(err)}`,
        );
      }
      await this.appendSessionTurns(brief, decision, score);
      this.servedScenes.add(sceneId);
      this.publish(sceneId, decision.themeId, score);
      return;
    }

    // 3) compose：谱面 + 主题 + 绑定 + 会话，publish。
    const { theme, score } = decision;
    const motifHint = extractMotifHint(score);
    const meta: MusicThemeMeta = {
      ...theme,
      ...(motifHint !== undefined ? { motifHint } : {}),
    };
    // id 冲突检查用决策返回后的新鲜目录（决策耗时数秒，决策前快照可能
    // 已被并发场景更新）；rename 后循环复查直到不撞（对抗性评审 P1/P2）。
    const taken = new Set((await this.themes.listThemes()).map((t) => t.id));
    let themeId = theme.id;
    if (taken.has(themeId)) {
      const suffix = musicCacheKey(score).slice(0, 4);
      themeId = `${theme.id}-${suffix}`;
      for (let n = 2; taken.has(themeId); n += 1) {
        themeId = `${theme.id}-${suffix}-${n}`;
      }
      meta.id = themeId;
      this.diagnostics.warn(
        "SceneMusicService",
        `新主题 id ${theme.id} 与目录冲突，重命名为 ${themeId}`,
      );
    }
    try {
      await this.themes.putScore(themeId, score);
      await this.themes.addTheme(meta, { sceneId });
    } catch (err: unknown) {
      this.diagnostics.warn(
        "SceneMusicService",
        `主题 ${themeId} 落盘失败（仅本会话生效）：${String(err)}`,
      );
    }
    await this.appendSessionTurns(brief, decision, score, themeId);
    this.servedScenes.add(sceneId);
    this.publish(sceneId, themeId, score);
  }

  /** 主题谱面读取（绑定/reuse 共用）：缺失或损坏 = undefined（调用方告警降级）。 */
  private async loadThemeScore(themeId: string): Promise<MusicScore | undefined> {
    try {
      return await this.themes.getScore(themeId);
    } catch (err: unknown) {
      this.diagnostics.warn(
        "SceneMusicService",
        `主题 ${themeId} 谱面读取失败（目录级降级）：${String(err)}`,
      );
      return undefined;
    }
  }

  /** 全量目录：谱面统计从各主题谱面补齐；单条读取失败 warn + 跳过。 */
  private async buildCatalog(): Promise<ThemeCatalogEntry[]> {
    const metas = await this.themes.listThemes();
    const entries: ThemeCatalogEntry[] = [];
    for (const meta of metas) {
      const score = await this.loadThemeScore(meta.id);
      if (score === undefined) continue;
      entries.push({ meta, stats: themeScoreStats(score) });
    }
    return entries;
  }

  /** 会话留痕：user = brief / assistant = 决策元数据（不存完整谱面）。 */
  private async appendSessionTurns(
    brief: SceneMusicBrief,
    decision: ComposerDecision,
    score: MusicScore,
    themeId?: string,
  ): Promise<void> {
    const id = themeId ?? (decision.action === "reuse" ? decision.themeId : decision.theme.id);
    const stats = themeScoreStats(score);
    const summary = {
      action: decision.action,
      themeId: id,
      ...(decision.action === "compose"
        ? { title: decision.theme.title, concept: decision.theme.concept }
        : {}),
      reason: decision.reason,
      stats: `${stats.bpm}bpm mode=${stats.mode} ${stats.instruments.join("+")} ${stats.noteCount}音`,
    };
    try {
      await this.session.append({ role: "user", content: JSON.stringify(brief) });
      await this.session.append({ role: "assistant", content: JSON.stringify(summary) });
    } catch (err: unknown) {
      this.diagnostics.warn(
        "SceneMusicService",
        `作曲家会话留痕失败（不影响本曲发布；会话可能出现不成对轮）：${String(err)}`,
      );
    }
  }

  private publish(sceneId: string, themeId: string, score: MusicScore): void {
    const event: SceneMusicScoreEvent = {
      sceneId,
      themeId,
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
