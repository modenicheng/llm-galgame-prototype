/**
 * MusicLibraryStore — 场景配乐复用谱库的 per-game 落盘（复用语义见
 * scene-music-service / docs/scene-music-generation.md）。
 *
 * `games/<gameId>/music/library.json`：键 = 复用键（mood:intensity），值 =
 * MusicScore（schema 单一真源 shared/music/score）。运行期可增长（区别于
 * world/ 的一次性资产，沿 stats.json 先例）：tmp+rename 原子写；读宽容
 * （缺文件 = 空库）；损坏大声抛错（谱库损坏即不可信）；put 首写即定稿
 * （同键覆写 = no-op——同 (mood, intensity) 的世界音乐身份一旦落定不再漂移）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GAME_STORAGE_LAYOUT } from "../../core/graph/ids.js";
import { MusicScoreSchema, type MusicScore } from "../../shared/music/score.js";
import type { SceneMusicLibraryPort } from "../../application/audio/scene-music-service.js";

const MusicLibraryFileSchema = z
  .object({
    version: z.literal(1),
    entries: z.record(z.string().min(1).max(32), MusicScoreSchema),
  })
  .strict();

export class MusicLibraryStore implements SceneMusicLibraryPort {
  private readonly filePath: string;
  private entries: Map<string, MusicScore> | undefined;

  constructor(gamesRoot: string, gameId: string) {
    this.filePath = path.join(path.resolve(gamesRoot), gameId, GAME_STORAGE_LAYOUT.musicLibrary);
  }

  private async load(): Promise<Map<string, MusicScore>> {
    if (this.entries !== undefined) return this.entries;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        this.entries = new Map();
        return this.entries;
      }
      throw err;
    }
    const checked = MusicLibraryFileSchema.parse(JSON.parse(raw));
    this.entries = new Map(Object.entries(checked.entries));
    return this.entries;
  }

  async get(key: string): Promise<MusicScore | undefined> {
    return (await this.load()).get(key);
  }

  async put(key: string, score: MusicScore): Promise<void> {
    const entries = await this.load();
    if (entries.has(key)) return;
    const next = new Map(entries);
    next.set(key, score);
    const body = {
      version: 1 as const,
      entries: Object.fromEntries(next),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
    this.entries = next;
  }
}
