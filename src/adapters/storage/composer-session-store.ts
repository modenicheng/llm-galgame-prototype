/**
 * ComposerSessionStore — 作曲家持久会话（V2 第四 agent 的跨场景记忆）。
 *
 * `games/<gameId>/music/session.jsonl`：追加式 JSONL，每行
 * `{role:"user"|"assistant", content}`——user 轮 = brief JSON，assistant 轮 =
 * 决策元数据（action/themeId/concept/reason + 谱面统计一行）。
 * **不存完整谱面**（谱面在 music/scores/，会话只留指纹级摘要）。
 *
 * 读取窗口截断（最近 N 轮）：目录本身是持久记忆（音乐圣经），会话只辅助
 * 「最近为什么这么决策」。V2 不做 LLM 压缩——当会话估算字符总量 > 300k
 * 再引入（1M 上下文下每轮 ~1–2k token，百场景 ≈ 200k 仍有余量）。
 *
 * store 三惯例：追加 = appendFile（O_APPEND 单行原子性由内核保证）；读
 * ENOENT = 空会话；任何一行解析失败 = 大声抛错（会话损坏即不可信）。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GAME_STORAGE_LAYOUT } from "../../core/graph/ids.js";
import type { ComposerSessionTurn } from "../../shared/music/theme.js";
import type { ComposerSessionStorePort } from "../../application/audio/scene-music-service.js";

const SessionLineSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export class ComposerSessionStore implements ComposerSessionStorePort {
  private readonly filePath: string;

  constructor(gamesRoot: string, gameId: string) {
    this.filePath = path.join(
      path.resolve(gamesRoot),
      gameId,
      GAME_STORAGE_LAYOUT.musicSession,
    );
  }

  /** 追加一轮（user = brief JSON / assistant = 决策摘要）。 */
  async append(turn: ComposerSessionTurn): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(turn)}\n`, "utf8");
  }

  /** 最近 maxTurns 轮（不足取全量）；缺文件 = 空会话；损坏大声抛错。 */
  async readRecent(maxTurns: number): Promise<ComposerSessionTurn[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw err;
    }
    const turns: ComposerSessionTurn[] = [];
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      turns.push(SessionLineSchema.parse(JSON.parse(line)));
    }
    return turns.slice(-maxTurns);
  }
}
