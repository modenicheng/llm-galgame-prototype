/**
 * MusicThemeStore — 主题制配乐目录的 per-game 落盘（V2）。
 *
 * 一类管两处：
 *   `games/<gameId>/music/themes.json` — `{version:1, themes:[MusicThemeMeta],
 *   bindings:Record<sceneId, themeId>}`，运行期可增长（沿 stats.json 先例：
 *   tmp+rename 原子重写、ENOENT=空、损坏大声抛错）；
 *   `games/<gameId>/music/scores/<themeId>.json` — 每主题一份 MusicScore
 *   （MusicScoreSchema 复验；首写即定稿，同 id 覆写 = no-op）。
 *
 * 主题一经落定不再漂移：addTheme 同 id = no-op，putScore 同 id = no-op
 * （世界音乐身份的「首作即定稿」纪律，同 V1 谱库）。bindings 只增不删——
 * sceneId 世界级稳定（场景图契约），重访命中绑定即零 LLM。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GAME_STORAGE_LAYOUT } from "../../core/graph/ids.js";
import { MusicScoreSchema, type MusicScore } from "../../shared/music/score.js";
import { MusicThemeMetaSchema, type MusicThemeMeta } from "../../shared/music/theme.js";
import type { MusicThemeStorePort } from "../../application/audio/scene-music-service.js";

const ThemeCatalogFileSchema = z
  .object({
    version: z.literal(1),
    themes: z.array(MusicThemeMetaSchema),
    bindings: z.record(z.string().min(1), MusicThemeMetaSchema.shape.id),
  })
  .strict();

interface ThemeCatalog {
  themes: MusicThemeMeta[];
  bindings: Record<string, string>;
}

export class MusicThemeStore implements MusicThemeStorePort {
  private readonly themesPath: string;
  private readonly scoresDir: string;
  private catalog: ThemeCatalog | undefined;
  /**
   * 写互斥链：服务层不同 sceneId 的决策并发落盘时，addTheme/bindScene/
   * putScore 必须串行——否则后写者基于旧快照整体覆写 themes.json，
   * 先写者的主题/绑定被静默丢弃（对抗性评审 P1）。
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(gamesRoot: string, gameId: string) {
    const gameDir = path.join(path.resolve(gamesRoot), gameId);
    this.themesPath = path.join(gameDir, GAME_STORAGE_LAYOUT.musicThemes);
    this.scoresDir = path.join(gameDir, GAME_STORAGE_LAYOUT.musicScoresDir);
  }

  /** 串行化一次变更操作（前序失败不阻塞后续）。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.writeChain.then(operation, operation);
    this.writeChain = task.catch(() => {});
    return task;
  }

  // --- themes.json（目录 + 绑定） ---

  private async loadCatalog(): Promise<ThemeCatalog> {
    if (this.catalog !== undefined) return this.catalog;
    let raw: string;
    try {
      raw = await readFile(this.themesPath, "utf8");
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        this.catalog = { themes: [], bindings: {} };
        return this.catalog;
      }
      throw err;
    }
    const checked = ThemeCatalogFileSchema.parse(JSON.parse(raw));
    this.catalog = { themes: checked.themes, bindings: checked.bindings };
    return this.catalog;
  }

  private async writeCatalog(next: ThemeCatalog): Promise<void> {
    await mkdir(path.dirname(this.themesPath), { recursive: true });
    const tmpPath = `${this.themesPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(
      tmpPath,
      `${JSON.stringify({ version: 1, themes: next.themes, bindings: next.bindings }, null, 2)}\n`,
      "utf8",
    );
    await rename(tmpPath, this.themesPath);
    this.catalog = next;
  }

  /** 已有主题（目录序即落盘序）。 */
  async listThemes(): Promise<MusicThemeMeta[]> {
    return [...(await this.loadCatalog()).themes];
  }

  /** sceneId → 已绑定主题 id；未绑定 = undefined（未绑定 = 走作曲家决策）。 */
  async getBinding(sceneId: string): Promise<string | undefined> {
    return (await this.loadCatalog()).bindings[sceneId];
  }

  /**
   * 登记主题（可选同时绑定 sceneId）。同 id 已存在 = no-op（首作即定稿）；
   * 但绑定仍会补写（主题已存在而绑定缺失的恢复场景）。写互斥：并发
   * addTheme/bindScene 串行落盘，杜绝快照覆写丢更新。
   */
  async addTheme(meta: MusicThemeMeta, bind?: { sceneId: string }): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.loadCatalog();
      const exists = current.themes.some((theme) => theme.id === meta.id);
      const next: ThemeCatalog = {
        themes: exists ? current.themes : [...current.themes, meta],
        bindings:
          bind !== undefined && current.bindings[bind.sceneId] !== meta.id
            ? { ...current.bindings, [bind.sceneId]: meta.id }
            : current.bindings,
      };
      if (next.themes === current.themes && next.bindings === current.bindings) {
        return;
      }
      await this.writeCatalog(next);
    });
  }

  /** 只补绑定（reuse 决策路径：主题已在目录，绑定新 sceneId）。 */
  async bindScene(sceneId: string, themeId: string): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.loadCatalog();
      if (current.bindings[sceneId] === themeId) return;
      await this.writeCatalog({
        themes: current.themes,
        bindings: { ...current.bindings, [sceneId]: themeId },
      });
    });
  }

  // --- scores/<themeId>.json（谱面） ---

  /** 读主题谱面：ENOENT = undefined（目录级降级由调用方告警）；损坏大声抛错。 */
  async getScore(themeId: string): Promise<MusicScore | undefined> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.scoresDir, `${themeId}.json`), "utf8");
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return undefined;
      }
      throw err;
    }
    return MusicScoreSchema.parse(JSON.parse(raw));
  }

  /**
   * 落盘主题谱面：同 id 已存在 = no-op（首写即定稿）。存在性复查在写
   * 互斥锁内进行——并发同 id 的 check-then-write TOCTOU 会使后写者
   * 覆写先写者（对抗性评审 P1）。
   */
  async putScore(themeId: string, score: MusicScore): Promise<void> {
    return this.enqueue(async () => {
      if ((await this.getScore(themeId)) !== undefined) return;
      await mkdir(this.scoresDir, { recursive: true });
      const target = path.join(this.scoresDir, `${themeId}.json`);
      const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await writeFile(tmpPath, `${JSON.stringify(score, null, 2)}\n`, "utf8");
      await rename(tmpPath, target);
    });
  }
}
