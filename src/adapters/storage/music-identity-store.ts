/**
 * MusicIdentityStore — 世界音乐地区身份的 per-game 落盘（编剧画像层）。
 *
 * `games/<gameId>/world/music-identity.json`：`{version:1, region}`。世界
 * 创建期由编剧 WorldDraft.musicRegion 写一次（拒绝覆写，沿 voice-design
 * 脚手架纪律）；读取缺失 = undefined（无地区锚，回落 default），损坏 =
 * 大声抛错（世界资产损坏语义）。运行时作 SceneMusicService 的
 * worldRegion——复用键与作曲创作思路的世界锚。
 */
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MUSIC_CONCRETE_REGIONS, type MusicRegion } from "../../shared/music/score.js";

const MUSIC_IDENTITY_FILE = "world/music-identity.json";

const MusicIdentityFileSchema = z
  .object({
    version: z.literal(1),
    region: z.enum(MUSIC_CONCRETE_REGIONS),
  })
  .strict();

export type MusicIdentityFile = z.infer<typeof MusicIdentityFileSchema>;

export class MusicIdentityStore {
  constructor(
    private readonly gamesRoot: string,
    private readonly gameId: string,
  ) {}

  private filePath(): string {
    return path.join(this.gamesRoot, this.gameId, MUSIC_IDENTITY_FILE);
  }

  /** 世界创建期写一次；文件已存在 = 拒绝覆写（沿 canon 脚手架纪律）。 */
  async save(file: MusicIdentityFile): Promise<void> {
    const target = this.filePath();
    try {
      await access(target);
      throw new Error(`music-identity.json 已存在，拒绝覆写：${target}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }

  /** 缺失 = undefined；JSON/schema 损坏 = 大声抛错。 */
  async load(): Promise<MusicRegion | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    return MusicIdentityFileSchema.parse(JSON.parse(raw)).region;
  }
}
