/**
 * VoiceDesignStore — 编剧角色音频画像的 per-game 落盘（角色音频特征设计
 * §3.1）。`games/<gameId>/world/voice-design.json`：世界创建期写一次
 * （拒绝覆写，沿 canon 脚手架纪律）；读取缺失 = undefined，损坏 = 大声
 * 抛错（世界资产损坏语义）。
 */
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CharacterVoiceDesign } from "../../application/outline/outline-writer.js";
import { CharacterVoiceDesignSchema } from "../../application/outline/outline-writer.js";

/** per-game 音频画像文件（world/ 下的非冻结布局，随 world/prompts 先例）。 */
export const VOICE_DESIGN_FILE = "world/voice-design.json";

/** 单个角色的画像存储形状（name 供装配层直接注 factory characters）。 */
export interface StoredVoiceDesign {
  name: string;
  voice: CharacterVoiceDesign;
}

export interface VoiceDesignFile {
  version: 1;
  characters: Record<string, StoredVoiceDesign>;
}

// voice 字段的 schema 唯一真源在 outline-writer.ts（与编剧 LLM 输出校验共用，
// 防 save 侧合法形状被 load 侧更严 schema 拒收的漂移）。
const VoiceDesignFileSchema = z
  .object({
    version: z.literal(1),
    characters: z.record(
      z.string().min(1).max(64),
      z
        .object({
          name: z.string().min(1).max(64),
          voice: CharacterVoiceDesignSchema,
        })
        .strict(),
    ),
  })
  .strict();

export class VoiceDesignStore {
  constructor(
    private readonly gamesRoot: string,
    private readonly gameId: string,
  ) {}

  private filePath(): string {
    return path.join(this.gamesRoot, this.gameId, VOICE_DESIGN_FILE);
  }

  /** 世界创建期写一次；文件已存在 = 拒绝覆写（沿 canon 脚手架纪律）。 */
  async save(file: VoiceDesignFile): Promise<void> {
    const target = this.filePath();
    try {
      await access(target);
      throw new Error(`voice-design.json 已存在，拒绝覆写：${target}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }

  /** 缺失 = undefined；JSON/schema 损坏 = 大声抛错。 */
  async load(): Promise<VoiceDesignFile | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    return VoiceDesignFileSchema.parse(parsed) as VoiceDesignFile;
  }
}
